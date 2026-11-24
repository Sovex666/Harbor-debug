import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Cdp } from "./cdp.mjs";

export const SUITES = Object.freeze([
  "cold",
  "warm",
  "stale",
  "navigation",
  "playback",
  "session",
  "export",
]);
const HERE = dirname(fileURLToPath(import.meta.url));
const EXPRESSIONS = Object.freeze({
  ready: `(() => ({ ready: window.__HARBOR_DEBUG__?.version === 1 && typeof window.__HARBOR_DEBUG__.navigate === 'function' }))()`,
  home: `(async () => { await window.__HARBOR_DEBUG__.navigate('home'); return true; })()`,
  calendar: `(async () => { await window.__HARBOR_DEBUG__.navigate('calendar'); return true; })()`,
  snapshot: `(() => { const s = window.__HARBOR_DEBUG__.snapshot(); return { version: s?.version, activeView: s?.activeView }; })()`,
  start: `(async () => { const f = window.__HARBOR_DEBUG__?.sessionStart; if (typeof f !== 'function') return { supported: false }; return { supported: true, ok: (await f('basic'))?.ok === true }; })()`,
  stop: `(async () => { const f = window.__HARBOR_DEBUG__?.sessionStop; if (typeof f !== 'function') return { supported: false }; return { supported: true, ok: (await f())?.ok === true }; })()`,
  export: `(async () => { const f = window.__HARBOR_DEBUG__?.sessionExport; if (typeof f !== 'function') return { supported: false }; return { supported: true, ok: (await f())?.ok === true }; })()`,
});

export async function inspectArtifact(path, expectedHash, repeat, suite) {
  if (!/^[a-f0-9]{64}$/.test(expectedHash) || basename(path).toLowerCase() !== "harbor.exe")
    throw new Error("Invalid staged artifact");
  const hash = createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
  if (hash !== expectedHash) throw new Error("Staged artifact hash mismatch");
  if (repeat === undefined) return hash;
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 20)
    throw new Error("Repeat must be 1–20");
  if (suite !== undefined && suite !== "all" && !SUITES.includes(suite))
    throw new Error("Unknown suite");
  return {
    schemaVersion: 2,
    artifactSha256: hash,
    repeat,
    launched: false,
    results: Array.from({ length: repeat }, (_, iteration) => ({
      iteration: iteration + 1,
      scenario: suite ?? "all",
      status: "not-run",
      reason: "Use run-native.ps1 for owned execution",
    })),
  };
}

function owner(options) {
  const result = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      join(HERE, "verify-owner.ps1"),
      "-OwnerPid",
      String(options.pid),
      "-Port",
      String(options.port),
      "-Executable",
      options.executable,
      "-StartTimeUtc",
      options.started,
      "-Hash",
      options.hash,
    ],
    { windowsHide: true, timeout: 15000, encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error("Owned process or CDP listener verification failed");
}

async function call(cdp, options, name, verifyOwner) {
  verifyOwner(options);
  await cdp.verifyIdentity(options.nonce, options.pid);
  const result = await cdp.send("Runtime.evaluate", {
    expression: EXPRESSIONS[name],
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) throw new Error(`${name} command failed`);
  await cdp.verifyIdentity(options.nonce, options.pid);
  verifyOwner(options);
  return result.result?.value;
}

export async function runSmoke(options, verifyOwner = owner) {
  let cdp;
  const deadline = Date.now() + 45000;
  while (!cdp && Date.now() < deadline) {
    try {
      verifyOwner(options);
      cdp = await Cdp.connect({
        port: options.port,
        timeoutMs: 1000,
        requireIdentity: true,
        expectedNonce: options.nonce,
        expectedPid: options.pid,
      });
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  if (!cdp) throw new Error("Owned attested main target unavailable");
  const results = [{ scenario: "attestation", status: "passed" }];
  try {
    const readyDeadline = Date.now() + 20000;
    while (!(await call(cdp, options, "ready", verifyOwner))?.ready) {
      if (Date.now() >= readyDeadline) throw new Error("Debug API readiness timed out");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    for (const view of options.suite === "all" ||
    options.suite === "navigation" ||
    options.suite === "warm"
      ? ["home", "calendar", "home"]
      : []) {
      const start = performance.now();
      await call(cdp, options, view, verifyOwner);
      const end = Date.now() + 10000;
      let snapshot;
      do {
        snapshot = await call(cdp, options, "snapshot", verifyOwner);
        if (snapshot?.activeView === view) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      } while (Date.now() < end);
      results.push({
        scenario: `navigate-${view}`,
        status: snapshot?.activeView === view ? "passed" : "failed",
        durationMs: Math.round(performance.now() - start),
      });
    }
    if (!["all", "session", "export"].includes(options.suite)) return results;
    const started = await call(cdp, options, "start", verifyOwner);
    if (!started?.supported) {
      results.push(
        { scenario: "session", status: "unsupported", reason: "sessionStart API unavailable" },
        { scenario: "export", status: "not-run", reason: "session API unavailable" },
      );
    } else if (!started.ok) {
      results.push(
        { scenario: "session", status: "failed", reason: "session start did not confirm success" },
        { scenario: "export", status: "not-run", reason: "session start failed" },
      );
    } else {
      const stopped = await call(cdp, options, "stop", verifyOwner);
      results.push({
        scenario: "session",
        status: !stopped?.supported ? "unsupported" : stopped.ok ? "passed" : "failed",
      });
      if (stopped?.supported && stopped.ok) {
        const exported = await call(cdp, options, "export", verifyOwner);
        results.push({
          scenario: "export",
          status: !exported?.supported ? "unsupported" : exported.ok ? "passed" : "failed",
        });
      } else
        results.push({
          scenario: "export",
          status: "not-run",
          reason: "sessionStop API unavailable",
        });
    }
    return results;
  } catch {
    results.push({
      scenario: "smoke",
      status: "failed",
      reason: "Owned identity or fixed command failed",
    });
    return results;
  } finally {
    cdp.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [pid, port, executable, started, hash, nonce, suite] = process.argv.slice(2);
  runSmoke({ pid: Number(pid), port: Number(port), executable, started, hash, nonce, suite })
    .then((results) => {
      console.log(JSON.stringify({ results }));
      if (results.some((result) => result.status === "failed")) process.exitCode = 1;
    })
    .catch(() => {
      console.log(
        JSON.stringify({
          results: [
            {
              scenario: "attestation-or-smoke",
              status: "failed",
              reason: "Owned attestation or fixed command failed",
            },
          ],
        }),
      );
      process.exitCode = 1;
    });
}
