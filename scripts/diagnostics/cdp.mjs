const DEFAULT_TIMEOUT_MS = 5000;

export function boundedNumber(value, name, min, max, integer = false) {
  const number =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : NaN;
  if (
    !Number.isFinite(number) ||
    number < min ||
    number > max ||
    (integer && !Number.isInteger(number))
  ) {
    throw new Error(
      `${name} must be ${integer ? "an integer" : "a number"} between ${min} and ${max}`,
    );
  }
  return number;
}

export function config(env = process.env) {
  return {
    port: boundedNumber(env.HARBOR_CDP_PORT ?? 9333, "HARBOR_CDP_PORT", 1, 65535, true),
    timeoutMs: boundedNumber(
      env.HARBOR_CDP_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS,
      "HARBOR_CDP_TIMEOUT_MS",
      100,
      30000,
      true,
    ),
  };
}

function settingsFor(options) {
  const settings = { ...config(), ...options };
  return {
    port: boundedNumber(settings.port, "CDP port", 1, 65535, true),
    timeoutMs: boundedNumber(settings.timeoutMs, "CDP timeout", 100, 30000, true),
  };
}

const IDENTITY_EXPRESSION =
  "(() => { const value = window.__HARBOR_CONTEXT_IDENTITY__; return value && typeof value === 'object' ? { appId: value.appId, buildId: value.buildId, windowRole: value.windowRole, nonce: value.nonce, pid: value.pid, storageVerified: value.storageVerified } : null; })()";

function validIdentity(value, expectedNonce, expectedPid) {
  return (
    value &&
    value.appId === "app.harbor.context-review" &&
    value.buildId === "context-review" &&
    value.windowRole === "main" &&
    typeof value.nonce === "string" &&
    value.nonce.length > 0 &&
    Number.isInteger(value.pid) &&
    value.storageVerified === true &&
    (!expectedNonce || value.nonce === expectedNonce) &&
    (!Number.isInteger(expectedPid) || value.pid === expectedPid)
  );
}

export function isHarborTarget(target) {
  if (target?.type !== "page" || typeof target.url !== "string") return false;
  try {
    const url = new URL(target.url);
    return (
      !url.username &&
      !url.password &&
      ((url.protocol === "tauri:" && url.hostname === "localhost" && !url.port) ||
        (["http:", "https:"].includes(url.protocol) &&
          url.hostname === "tauri.localhost" &&
          !url.port) ||
        (url.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
          url.port === "1420"))
    );
  } catch {
    return false;
  }
}

const unavailable =
  "Harbor CDP unavailable. Windows: launch scripts/dev-diag.ps1. Chromium dev preview: enable --remote-debugging-port on the local browser. Native macOS WKWebView and Linux WebKitGTK do not expose CDP; use a Chromium dev preview for frontend diagnostics and rss for native process memory.";

export async function listTargets(options = {}) {
  const { port, timeoutMs } = settingsFor(options);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });
    if (!response.ok) throw new Error();
    // Keep the timeout active while consuming the body, too.
    const targets = await response.json();
    if (!Array.isArray(targets)) throw new Error();
    return targets.filter(isHarborTarget);
  } catch {
    throw new Error(unavailable);
  }
}

function socketUrl(target, port) {
  try {
    const url = new URL(target.webSocketDebuggerUrl);
    if (
      url.protocol !== "ws:" ||
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      Number(url.port || 80) !== port ||
      url.username ||
      url.password
    )
      throw new Error();
    // Pin the actual connection to loopback even when discovery advertises localhost.
    url.hostname = "127.0.0.1";
    return url.href;
  } catch {
    throw new Error("Harbor target advertised an invalid or non-local CDP socket");
  }
}

export class Cdp {
  constructor(ws, target, timeoutMs = DEFAULT_TIMEOUT_MS, identity = null) {
    this.ws = ws;
    this.target = target;
    this.timeoutMs = timeoutMs;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;
    this.identity = identity;
    ws.addEventListener("message", (event) => this.onMessage(String(event.data)));
    ws.addEventListener("close", () => this.fail("CDP connection closed"));
    ws.addEventListener("error", () => this.close());
  }

  static async connect(options = {}) {
    const settings = settingsFor(options);
    if (options.requireIdentity && !/^[A-Za-z0-9_-]{1,128}$/.test(options.expectedNonce ?? ""))
      throw new Error("A valid runner nonce is required for context-review selection");
    const targets = await listTargets(settings);
    if (!options.requireIdentity && targets.length !== 1)
      throw new Error(
        targets.length
          ? "Multiple Harbor targets found; use a dedicated CDP browser with one Harbor tab"
          : "No Harbor page target found; open http://localhost:1420 in the CDP browser or launch Harbor with diagnostics enabled",
      );
    if (options.requireIdentity && !targets.length)
      throw new Error("No Harbor context-review target found");
    if (typeof WebSocket === "undefined")
      throw new Error("Diagnostics require Node.js 22 or newer (built-in WebSocket)");
    const candidates = options.requireIdentity ? targets : [targets[0]];
    const sockets = candidates.map((target) => socketUrl(target, settings.port));
    let selected = null;
    let matches = 0;
    for (const [index, target] of candidates.entries()) {
      const ws = new WebSocket(sockets[index]);
      const cdp = new Cdp(ws, target, settings.timeoutMs);
      try {
        await cdp.open();
        if (!options.requireIdentity) return cdp;
        const identity = await cdp.send("Runtime.evaluate", {
          expression: IDENTITY_EXPRESSION,
          returnByValue: true,
        });
        const value = identity?.result?.value;
        if (validIdentity(value, options.expectedNonce)) {
          matches++;
          if (selected) cdp.close();
          else {
            selected = cdp;
            selected.identity = value;
          }
          continue;
        }
      } catch (error) {
        /* Candidate is stale or not an attested Harbor page. */
        if (!options.requireIdentity) {
          cdp.close();
          throw error;
        }
      }
      cdp.close();
    }
    if (
      !selected ||
      matches !== 1 ||
      (Number.isInteger(options.expectedPid) && selected.identity.pid !== options.expectedPid)
    ) {
      selected?.close();
      throw new Error(
        options.expectedNonce
          ? "No uniquely owned context-review main target matched the run nonce"
          : "No uniquely owned context-review main target was attested",
      );
    }
    return selected;
  }

  async open() {
    const { ws } = this;
    await new Promise((resolve, reject) => {
      const finish = (error) => {
        clearTimeout(timer);
        ws.removeEventListener("open", open);
        ws.removeEventListener("error", failed);
        ws.removeEventListener("close", failed);
        if (error) {
          this.close();
          reject(error);
        } else resolve();
      };
      const open = () => finish();
      const failed = () => finish(new Error("CDP WebSocket connection failed"));
      const timer = setTimeout(
        () => finish(new Error("CDP WebSocket connection timed out")),
        this.timeoutMs,
      );
      ws.addEventListener("open", open, { once: true });
      ws.addEventListener("error", failed, { once: true });
      ws.addEventListener("close", failed, { once: true });
    });
  }

  async verifyIdentity(expectedNonce, expectedPid) {
    const result = await this.send("Runtime.evaluate", {
      expression: IDENTITY_EXPRESSION,
      returnByValue: true,
    });
    const value = result?.result?.value;
    if (!validIdentity(value, expectedNonce, expectedPid))
      throw new Error("Context-review target identity changed");
  }

  onMessage(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      this.close();
      return;
    }
    if (!message || typeof message !== "object") {
      this.close();
      return;
    }
    if (message.id != null) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error("CDP request failed"));
      else pending.resolve(message.result);
      return;
    }
    for (const listener of this.listeners.get(message.method) ?? []) {
      try {
        listener(message.params);
      } catch {
        this.close();
      }
    }
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) ?? [];
    listeners.push(listener);
    this.listeners.set(method, listeners);
  }

  send(method, params = {}) {
    if (this.closed || this.ws.readyState !== 1)
      return Promise.reject(new Error("CDP connection is not open"));
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP request timed out: ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error("CDP send failed"));
      }
    });
  }

  fail(message) {
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
    this.pending.clear();
  }

  close() {
    this.fail("CDP connection closed");
    this.listeners.clear();
    try {
      this.ws.close();
    } catch {
      /* A connecting socket may already have failed. */
    }
  }
}
