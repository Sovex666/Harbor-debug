import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import test from "node:test";
import { Cdp, boundedNumber, config, isHarborTarget, listTargets } from "./cdp.mjs";
import {
  VIEWS,
  clear,
  evalInPage,
  navigate,
  performanceSummary,
  safeState,
  snapshot,
  state,
  watch,
} from "../harbor-diag.mjs";
import { availableTools, runTool } from "../harbor-diag-mcp.mjs";
import { inspectArtifact, runSmoke } from "./run-suite.mjs";

test("review startup attests before services and creates an isolated main webview", async () => {
  const source = await readFile(new URL("../../src-tauri/src/lib.rs", import.meta.url), "utf8");
  const setup = source.slice(source.indexOf(".setup(move |app|"));
  assert.ok(
    setup.indexOf("context_review::attest_storage(") <
      setup.indexOf("diagnostics_sessions::initialize("),
  );
  assert.ok(
    setup.indexOf("context_review::attest_storage(") <
      setup.indexOf("stream_proxy::ProxyState::start("),
  );
  assert.match(setup, /WebviewWindowBuilder::from_config\(app, config\)/);
  assert.match(setup, /builder\.data_directory\(webview_data\)/);
  assert.match(source, /context_review::identity_script\(webview\.label\(\)\)/);
  const config = JSON.parse(
    await readFile(
      new URL("../../src-tauri/tauri.context-review.conf.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(config.app.windows.find((window) => window.label === "main").create, false);
});

test("self-test reports unexecuted scenarios and rejects a changed artifact", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "harbor-diag-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const executable = join(dir, "harbor.exe");
  const bytes = Buffer.from("test artifact, never executed");
  await writeFile(executable, bytes);
  const hash = createHash("sha256").update(bytes).digest("hex");
  const report = await inspectArtifact(executable, hash, 3, "warm");
  assert.equal(report.launched, false);
  assert.equal(report.results.length, 3);
  assert.ok(report.results.every((row) => row.status === "not-run"));
  await assert.rejects(inspectArtifact(executable, "0".repeat(64)), /hash mismatch/);
});

test("every fixed app diagnostic event survives the CLI/MCP projection", async () => {
  const files = [
    "../../src/lib/remote-image-proxy.ts",
    "../../src/lib/player/mpv.ts",
    "../../src/lib/perf/diagnostics.ts",
    "../../src/views/player/hooks/use-wake-reconnect.ts",
    "../../src/lib/calendar-library.ts",
    "../../src/views/calendar/use-calendar-data.ts",
  ];
  for (const file of files) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    for (const match of source.matchAll(
      /(?:recordDiagnostic|measureDiagnostic)\("([a-z][a-z0-9:._-]+)"/g,
    )) {
      const projected = safeState({
        events: [
          {
            name: match[1],
            fields: { elapsedMs: 12, position: 50, persistent: true, title: "private" },
          },
        ],
      });
      assert.equal(projected.events[0].name, match[1]);
      assert.deepEqual(projected.events[0].fields, {
        elapsedMs: 12,
        position: 50,
        persistent: true,
      });
    }
  }
});

class MockSocket extends EventTarget {
  static open = true;
  static instances = [];
  static handler = null;
  constructor(url) {
    super();
    this.url = url;
    this.readyState = 0;
    MockSocket.instances.push(this);
    if (MockSocket.open)
      queueMicrotask(() => {
        this.readyState = 1;
        this.dispatchEvent(new Event("open"));
      });
  }
  send(raw) {
    MockSocket.handler?.(this, JSON.parse(raw));
  }
  reply(id, result) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ id, result }) }));
  }
  close() {
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }
}

async function fixture(t, respond) {
  const server = createServer(
    respond ??
      ((_request, response) => {
        response.setHeader("Content-Type", "application/json");
        response.end(
          JSON.stringify([
            {
              type: "page",
              url: "http://localhost:1420/private?token=secret",
              title: "private title",
              webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/devtools/page/test`,
            },
          ]),
        );
      }),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const original = globalThis.WebSocket;
  globalThis.WebSocket = MockSocket;
  MockSocket.open = true;
  MockSocket.handler = null;
  MockSocket.instances = [];
  t.after(() => {
    globalThis.WebSocket = original;
  });
  return { port: server.address().port, timeoutMs: 100 };
}

test("strict validation rejects nonfinite, empty, and out-of-bounds input", async () => {
  for (const value of [NaN, Infinity, "", " ", "bad", 0, -1, 65536, 1.1])
    assert.throws(() => config({ HARBOR_CDP_PORT: value }));
  assert.equal(config({}).port, 9333);
  assert.throws(() => boundedNumber(null, "number", 1, 120));
  for (const args of [
    [NaN, 5],
    [121, 5],
    [30, 0],
    [1, 2],
    [30, Infinity],
  ])
    await assert.rejects(watch(...args));
  await assert.rejects(navigate("https://example.com"));
});

test("navigation allowlist tracks the actual TypeScript View union", async () => {
  const source = await readFile(new URL("../../src/lib/view.tsx", import.meta.url), "utf8");
  const union = source.match(/export type View =([\s\S]*?);/)[1];
  assert.deepEqual(
    VIEWS,
    [...union.matchAll(/"([^"]+)"/g)].map((match) => match[1]),
  );
});

test("Harbor targeting requires exact origins and ignores unrelated pages", () => {
  for (const url of [
    "http://localhost:1420",
    "http://127.0.0.1:1420/a",
    "http://[::1]:1420/",
    "tauri://localhost",
    "http://tauri.localhost",
    "https://tauri.localhost",
  ])
    assert.equal(isHarborTarget({ type: "page", url }), true, url);
  for (const url of [
    "https://example.com/?localhost:1420",
    "http://localhost:14200",
    "http://tauri.localhost.evil",
    "https://localhost:1420",
    "file:///Harbor",
    "http://user:password@localhost:1420",
  ])
    assert.equal(isHarborTarget({ type: "page", url }), false, url);
  assert.equal(isHarborTarget({ type: "iframe", url: "http://localhost:1420" }), false);
});

test("CDP matches synchronous responses, bounds requests, and rejects pending on close", async (t) => {
  const options = await fixture(t);
  const cdp = await Cdp.connect(options);
  MockSocket.handler = (socket, request) => socket.reply(request.id, { ok: true });
  assert.deepEqual(await cdp.send("Runtime.enable"), { ok: true });
  MockSocket.handler = null;
  await assert.rejects(cdp.send("Runtime.enable"), /timed out/);
  assert.equal(cdp.pending.size, 0);
  const waiting = cdp.send("Runtime.enable");
  cdp.ws.close();
  await assert.rejects(waiting, /closed/);
  assert.equal(cdp.pending.size, 0);
  await assert.rejects(cdp.send("Runtime.enable"), /not open/);
});

test("malformed CDP messages and transport errors reject all in-flight work safely", async (t) => {
  const options = await fixture(t);
  const cdp = await Cdp.connect(options);
  const pending = cdp.send("Runtime.evaluate");
  cdp.ws.dispatchEvent(new MessageEvent("message", { data: "not-json" }));
  await assert.rejects(pending, /closed/);
  assert.equal(cdp.pending.size, 0);
  const second = await Cdp.connect(options);
  const other = second.send("Runtime.evaluate");
  second.ws.dispatchEvent(new Event("error"));
  await assert.rejects(other, /closed/);
  assert.equal(second.pending.size, 0);
});

test("discovery and WebSocket handshakes have deadlines", async (t) => {
  const options = await fixture(t);
  MockSocket.open = false;
  await assert.rejects(Cdp.connect(options), /timed out/);
  assert.equal(MockSocket.instances[0].readyState, 3);
  const hanging = await fixture(t, () => {});
  await assert.rejects(listTargets(hanging), /CDP unavailable/);
});

test("target selection fails closed for unrelated, ambiguous, and external sockets", async (t) => {
  let targets = [{ type: "page", url: "http://example.com" }];
  const options = await fixture(t, (_request, response) => response.end(JSON.stringify(targets)));
  await assert.rejects(Cdp.connect(options), /No Harbor/);
  targets = [1, 2].map(() => ({ type: "page", url: "http://localhost:1420" }));
  await assert.rejects(Cdp.connect(options), /Multiple Harbor/);
  targets = [
    {
      type: "page",
      url: "http://localhost:1420",
      webSocketDebuggerUrl: "ws://example.com:9333/debug",
    },
  ];
  await assert.rejects(Cdp.connect(options), /non-local/);
});

test("context target selection probes fixed identity and rejects wrong nonce or duplicate main", async (t) => {
  let targets;
  const options = await fixture(t, (_request, response) => response.end(JSON.stringify(targets)));
  targets = ["tray", "main"].map((role) => ({
    type: "page",
    url: "http://tauri.localhost",
    webSocketDebuggerUrl: `ws://127.0.0.1:${options.port}/${role}`,
  }));
  let duplicate = false;
  MockSocket.handler = (socket, request) => {
    assert.equal(request.method, "Runtime.evaluate");
    assert.ok(request.params.expression.includes("__HARBOR_CONTEXT_IDENTITY__"));
    socket.reply(request.id, {
      result: {
        value: {
          appId: "app.harbor.context-review",
          buildId: "context-review",
          windowRole: duplicate || socket.url.endsWith("/main") ? "main" : "tray",
          nonce: "run-1",
          pid: 42,
          storageVerified: true,
        },
      },
    });
  };
  const cdp = await Cdp.connect({ ...options, requireIdentity: true, expectedNonce: "run-1" });
  assert.ok(cdp.ws.url.endsWith("/main"));
  cdp.close();
  await assert.rejects(
    Cdp.connect({ ...options, requireIdentity: true, expectedNonce: "wrong" }),
    /nonce/,
  );
  duplicate = true;
  await assert.rejects(
    Cdp.connect({ ...options, requireIdentity: true, expectedNonce: "run-1" }),
    /uniquely/,
  );
  await assert.rejects(Cdp.connect({ ...options, requireIdentity: true }), /nonce/);
});

test("context target selection can require the owned PID", async (t) => {
  const options = await fixture(t);
  MockSocket.handler = (socket, request) =>
    socket.reply(request.id, {
      result: {
        value: {
          appId: "app.harbor.context-review",
          buildId: "context-review",
          windowRole: "main",
          nonce: "run-1",
          pid: 7,
          storageVerified: true,
        },
      },
    });
  await assert.rejects(
    Cdp.connect({ ...options, requireIdentity: true, expectedNonce: "run-1", expectedPid: 8 }),
    /owned|attested/,
  );
  const cdp = await Cdp.connect({
    ...options,
    requireIdentity: true,
    expectedNonce: "run-1",
    expectedPid: 7,
  });
  cdp.close();
});

test("owned smoke uses fixed actions and reports session/export only on explicit success", async (t) => {
  const options = await fixture(t);
  const calls = [];
  const window = {
    __HARBOR_CONTEXT_IDENTITY__: {
      appId: "app.harbor.context-review",
      buildId: "context-review",
      windowRole: "main",
      nonce: "run-1",
      pid: 42,
      storageVerified: true,
    },
    __HARBOR_DEBUG__: {
      version: 1,
      activeView: "home",
      navigate(view) {
        calls.push(view);
        this.activeView = view;
      },
      snapshot() {
        return { version: 1, activeView: this.activeView };
      },
      sessionStart: async () => ({ ok: true }),
      sessionStop: async () => ({ ok: true }),
      sessionExport: async () => ({ ok: true }),
    },
  };
  MockSocket.handler = (socket, request) => {
    Promise.resolve(Function("window", `return ${request.params.expression}`)(window)).then(
      (value) => socket.reply(request.id, { result: { value } }),
    );
  };
  let checks = 0;
  const results = await runSmoke({ ...options, pid: 42, nonce: "run-1", suite: "all" }, () => {
    checks++;
  });
  assert.deepEqual(calls, ["home", "calendar", "home"]);
  assert.ok(checks > 1);
  assert.equal(results.find((row) => row.scenario === "session").status, "passed");
  assert.equal(results.find((row) => row.scenario === "export").status, "passed");
  window.__HARBOR_DEBUG__.sessionExport = async () => ({ ok: false });
  const failed = await runSmoke({ ...options, pid: 42, nonce: "run-1", suite: "export" }, () => {});
  assert.equal(failed.find((row) => row.scenario === "export").status, "failed");
});

test("API contract supports state/clear/navigation and reports missing v1 API", async (t) => {
  const options = await fixture(t);
  const previous = process.env.HARBOR_CDP_PORT;
  process.env.HARBOR_CDP_PORT = String(options.port);
  t.after(() => {
    if (previous === undefined) delete process.env.HARBOR_CDP_PORT;
    else process.env.HARBOR_CDP_PORT = previous;
  });
  const calls = [];
  const browserPerformance = {
    now: () => 42,
    getEntriesByType: (type) =>
      type === "resource"
        ? [
            {
              name: "https://private.example/secret?token=password",
              transferSize: 128,
              duration: 5,
            },
          ]
        : type === "navigation"
          ? [
              {
                name: "http://localhost:1420/private",
                responseEnd: 20,
                requestStart: 5,
                domContentLoadedEventEnd: 30,
                loadEventEnd: 40,
              },
            ]
          : [],
  };
  const window = {
    __HARBOR_DEBUG__: {
      version: 1,
      snapshot: () => ({
        version: 1,
        startedAt: 10,
        capturedAt: 20,
        activeView: "calendar",
        retention: { capacity: 2000, overwritten: 3, events: 1 },
        metrics: [
          {
            name: "calendar.load",
            count: 1,
            errors: 0,
            totalMs: 12,
            maxMs: 12,
            p50Ms: 12,
            p95Ms: 12,
            samples: 1,
          },
        ],
        navigation: { view: "calendar", navDepth: 2 },
        title: "Secret",
        url: "https://private",
        events: [
          {
            kind: "private title",
            name: "calendar.load",
            fields: { elapsedMs: 12, error: false, cancelled: false, items: 42, title: "private" },
            durationMs: 12,
          },
        ],
      }),
      clear: () => calls.push("clear"),
      navigate: (view) => calls.push(view),
    },
  };
  MockSocket.handler = (socket, request) => {
    Promise.resolve(
      Function(
        "window",
        "performance",
        `return ${request.params.expression}`,
      )(window, browserPerformance),
    ).then((value) => socket.reply(request.id, { result: { value } }));
  };
  const projected = await state();
  assert.equal(projected.activeView, "calendar");
  assert.deepEqual(projected.retention, { capacity: 2000, overwritten: 3, events: 1 });
  assert.deepEqual(projected.metrics, [
    {
      name: "calendar.load",
      count: 1,
      errors: 0,
      totalMs: 12,
      maxMs: 12,
      p50Ms: 12,
      p95Ms: 12,
      samples: 1,
    },
  ]);
  assert.deepEqual(projected.events, [
    {
      name: "calendar.load",
      fields: { elapsedMs: 12, error: false, cancelled: false, items: 42 },
      durationMs: 12,
    },
  ]);
  assert.ok(!JSON.stringify(projected).includes("private"));
  const perf = await performanceSummary();
  assert.deepEqual(perf.diagnostics, projected);
  assert.equal(perf.uptimeMs, 42);
  assert.deepEqual(perf.resources, { count: 1, transferBytes: 128, durationMs: 5 });
  assert.deepEqual(perf.navigation, { responseMs: 15, domContentLoadedMs: 30, loadMs: 40 });
  assert.ok(!JSON.stringify(perf).includes("private"));
  assert.deepEqual(await navigate("calendar"), { requestedView: "calendar", accepted: true });
  assert.deepEqual(await clear(), { cleared: true });
  assert.deepEqual(calls, ["calendar", "clear"]);
  delete window.__HARBOR_DEBUG__;
  await assert.rejects(state(), /API v1 unavailable/);
  assert.equal((await performanceSummary()).diagnostics.supported, false);
});

test("state privacy projection rejects free text, unknown fields and deep data", () => {
  const data = {
    title: "private",
    url: "https://token",
    navigation: { view: "calendar", stackKinds: ["home", "private title"], navDepth: 2 },
    playback: { paused: true, title: "private", state: "playing" },
    events: [{ name: "private-title", type: "https://private", timestamp: 12, durationMs: 4 }],
    memory: { jsHeapMB: Infinity },
  };
  const output = safeState(data);
  assert.deepEqual(output, {
    navigation: { view: "calendar", stackKinds: ["home"], navDepth: 2 },
    playback: { paused: true, state: "playing" },
    events: [{ timestamp: 12, durationMs: 4 }],
    memory: { jsHeapMB: null },
  });
  assert.ok(!JSON.stringify(output).includes("private"));
});

test("unsafe commands are opt-in at both CLI API and MCP dispatch boundaries", async (t) => {
  const previous = process.env.HARBOR_DIAG_UNSAFE;
  delete process.env.HARBOR_DIAG_UNSAFE;
  t.after(() => {
    if (previous === undefined) delete process.env.HARBOR_DIAG_UNSAFE;
    else process.env.HARBOR_DIAG_UNSAFE = previous;
  });
  assert.ok(!availableTools().some((tool) => tool.name === "harbor_eval"));
  await assert.rejects(evalInPage("location.href"), /disabled/);
  await assert.rejects(snapshot(), /disabled/);
  await assert.rejects(runTool("harbor_eval", { expression: "location.href" }), /disabled/);
  process.env.HARBOR_DIAG_UNSAFE = "1";
  assert.ok(availableTools().some((tool) => tool.name === "harbor_eval"));
});

test("MCP validates argument objects, types, ranges, and unexpected fields", async () => {
  for (const args of [
    null,
    [],
    { seconds: "30" },
    { seconds: Infinity },
    { seconds: 121 },
    { interval: 0 },
    { expression: "secret" },
  ])
    await assert.rejects(runTool("harbor_watch", args));
  await assert.rejects(runTool("harbor_navigate", {}), /Missing/);
  await assert.rejects(runTool("harbor_navigate", { view: "https://private" }), /Invalid/);
});

test(
  "MCP newline stdio handles initialization, notifications, schemas, errors and ping",
  { timeout: 5000 },
  async (t) => {
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("../harbor-diag-mcp.mjs", import.meta.url))],
      { env: { ...process.env, HARBOR_DIAG_UNSAFE: "0" }, stdio: ["pipe", "pipe", "pipe"] },
    );
    t.after(() => child.kill());
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => {
      stdout += data;
    });
    child.stderr.on("data", (data) => {
      stderr += data;
    });
    const exited = once(child, "exit");
    child.stdin.end(
      [
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-03-26" },
        }),
        JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
        JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
        JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "harbor_navigate", arguments: { view: "https://private" } },
        }),
        "{broken",
        JSON.stringify({ jsonrpc: "2.0", id: 4, method: "ping" }),
        JSON.stringify({ jsonrpc: "2.0", id: 5, method: "unknown" }),
        "null",
      ].join("\n") + "\n",
    );
    assert.deepEqual(await exited, [0, null]);
    assert.equal(stderr, "");
    const replies = stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(replies.length, 7);
    assert.equal(replies.find((reply) => reply.id === 1).result.protocolVersion, "2025-03-26");
    assert.ok(
      replies
        .find((reply) => reply.id === 2)
        .result.tools.some((tool) => tool.name === "harbor_navigate"),
    );
    assert.equal(replies.find((reply) => reply.id === 3).result.isError, true);
    assert.equal(replies.find((reply) => reply.id === 5).error.code, -32601);
    assert.ok(replies.some((reply) => reply.error?.code === -32700));
    assert.ok(!stdout.includes("https://private"));
  },
);
