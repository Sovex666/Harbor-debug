import assert from "node:assert/strict";
import test from "node:test";
import { projectDiagnostic } from "../src/lib/diagnostics/contract.ts";

test("structured capture drops unknown names, fields and raw payloads", () => {
  assert.equal(projectDiagnostic("https://private.example/token", { elapsedMs: 1 }), null);
  assert.deepEqual(
    projectDiagnostic("image:fetch", {
      elapsedMs: 1.234,
      error: false,
      url: "https://private.example/token",
      bytes: NaN,
      position: Infinity,
      unknown: 123,
    }),
    { name: "image:fetch", fields: { elapsedMs: 1.23, error: false } },
  );
  assert.equal(projectDiagnostic("navigation:private-title:requested", {}), null);
  assert.ok(projectDiagnostic("navigation:calendar:requested", {}));
});
