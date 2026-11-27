import assert from "node:assert/strict";
import test from "node:test";
import {
  recordDiagnostic,
  diagnosticSnapshot,
  clearDiagnostics,
} from "../src/lib/perf/diagnostics.ts";
import {
  startDiagnosticsSession,
  stopDiagnosticsSession,
  flushDiagnostics,
} from "../src/lib/diagnostics/session.ts";

test("structured sessions persist projected breadcrumbs while preserving legacy history", async () => {
  const previous = globalThis.window;
  const batches = [];
  const active = { sessionId: "33333333-3333-4333-8333-333333333333", mode: "basic", domains: 63 };
  globalThis.window = {
    __TAURI_INTERNALS__: {
      invoke: async (command, args) => {
        if (command === "diagnostics_session_start") return { active };
        if (command === "diagnostics_clock_sample") return { monoMs: 0 };
        if (command === "diagnostics_append_batch") {
          batches.push(args.batch);
          return { persistedThroughSeq: args.batch.events.at(-1).seq };
        }
        if (command === "diagnostics_session_stop") return { active: null };
        throw new Error(command);
      },
    },
  };
  try {
    clearDiagnostics();
    await startDiagnosticsSession();
    recordDiagnostic("image:queue", { count: 2, private: 99 });
    await flushDiagnostics();
    assert.deepEqual(batches[0].events.at(-1).fields, { count: 2 });
    assert.equal(diagnosticSnapshot().events.at(-1).fields.private, 99);
    await stopDiagnosticsSession();
  } finally {
    globalThis.window = previous;
  }
});
