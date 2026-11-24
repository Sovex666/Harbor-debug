import assert from "node:assert/strict";
import test from "node:test";
import { runDiagnosticsSelfTest } from "../src/lib/diagnostics/self-test.ts";

const ID = "44444444-4444-4444-8444-444444444444";

function fakeService({ activeAtStart = null } = {}) {
  const calls = [];
  let active = activeAtStart;
  let events = 0;
  const ended = new Map();
  return {
    calls,
    invoke: async (command, args) => {
      calls.push(command);
      switch (command) {
        case "diagnostics_session_status":
          return { active: active && { ...active, events }, buildIdentity: "production" };
        case "diagnostics_preferences_read":
          return { enabled: false, autoStart: false, mode: "basic", domains: 63 };
        case "diagnostics_session_start":
          active = { sessionId: ID, mode: args.mode, domains: args.domains };
          events = 1;
          return { active };
        case "diagnostics_clock_sample":
          return { monoMs: 0 };
        case "diagnostics_append_batch":
          events += args.batch.events.length;
          return { persistedThroughSeq: args.batch.events.at(-1).seq };
        case "diagnostics_session_stop":
          ended.set(args.sessionId, Date.now());
          active = null;
          return { active: null };
        case "diagnostics_session_export":
          return { sessionId: args.sessionId, path: "export.zip", bytes: 2048 };
        case "diagnostics_sessions_list":
          return [{ sessionId: ID, endedAt: ended.get(ID) ?? null, events }];
        default:
          throw new Error(command);
      }
    },
  };
}

async function withService(service, body) {
  const previous = globalThis.window;
  globalThis.window = { __TAURI_INTERNALS__: { invoke: service.invoke } };
  try {
    return await body();
  } finally {
    globalThis.window = previous;
  }
}

test("self-test runs a basic session through start, write, stop, export and list", async () => {
  const service = fakeService();
  const progress = [];
  const result = await withService(service, () =>
    runDiagnosticsSelfTest((steps) => progress.push(steps)),
  );
  assert.equal(result.passed, true);
  assert.deepEqual(
    result.steps.map((s) => s.state),
    ["passed", "passed", "passed", "passed", "passed", "passed", "passed"],
  );
  assert.ok(progress.length >= 14, "each step reports running and its outcome");
  assert.ok(!service.calls.includes("diagnostics_preferences_write"), "preferences stay untouched");
});

test("self-test refuses to touch an active capture session", async () => {
  const service = fakeService({
    activeAtStart: { sessionId: "55555555-5555-4555-8555-555555555555", mode: "basic", domains: 63 },
  });
  const result = await withService(service, () => runDiagnosticsSelfTest(() => {}));
  assert.equal(result.passed, false);
  assert.equal(result.steps[0].state, "failed");
  assert.ok(result.steps.slice(1).every((s) => s.state === "pending"));
  assert.ok(!service.calls.includes("diagnostics_session_start"));
  assert.ok(!service.calls.includes("diagnostics_session_stop"));
});
