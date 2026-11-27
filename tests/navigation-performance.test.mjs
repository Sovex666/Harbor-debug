import assert from "node:assert/strict";
import test from "node:test";
import {
  beginDiagnosticNavigation,
  clearDiagnostics,
  commitDiagnosticNavigation,
  diagnosticSnapshot,
} from "../src/lib/perf/diagnostics.ts";

test("rapid navigation keeps only the final shell paint", () => {
  const savedRaf = globalThis.requestAnimationFrame;
  const savedCancel = globalThis.cancelAnimationFrame;
  const frames = [];
  globalThis.requestAnimationFrame = (callback) => {
    frames.push(callback);
    return frames.length;
  };
  globalThis.cancelAnimationFrame = () => {};

  try {
    clearDiagnostics();
    const views = ["calendar", "movies", "shows", "library"];
    for (let row = 0; row < 500; row++) {
      const view = views[row % views.length];
      beginDiagnosticNavigation(view);
      commitDiagnosticNavigation(view);
    }
    while (frames.length) frames.shift()(16);
    const snapshot = diagnosticSnapshot();
    const shellPaints = snapshot.metrics.filter((metric) => metric.name.endsWith(":shell-paint"));
    const superseded = snapshot.events.filter((event) => event.name.endsWith(":superseded"));
    assert.equal(shellPaints.length, 1);
    assert.equal(shellPaints[0].name, "navigation:library:shell-paint");
    assert.equal(superseded.length, 499);
    assert.equal(
      snapshot.events.some((event) => typeof event.fields.elapsedMs === "string"),
      false,
    );
  } finally {
    globalThis.requestAnimationFrame = savedRaf;
    globalThis.cancelAnimationFrame = savedCancel;
  }
});
