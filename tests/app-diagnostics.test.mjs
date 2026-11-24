import assert from "node:assert/strict";
import test from "node:test";
import {
  acknowledgeDiagnosticExport,
  beginDiagnosticNavigation,
  clearDiagnostics,
  commitDiagnosticNavigation,
  diagnosticSnapshot,
  installDiagnostics,
  measureDiagnostic,
  recordDiagnostic,
  registerDiagnosticNavigator,
} from "../src/lib/perf/diagnostics.ts";

test("diagnostic history is bounded, chronological and excludes nonnumeric payloads", () => {
  clearDiagnostics();
  recordDiagnostic("https://private.example/secret", { elapsedMs: 3 });
  for (let i = 0; i < 2100; i++) {
    recordDiagnostic("image:loaded", { elapsedMs: i, secret: "do-not-retain", invalid: NaN });
  }
  const snapshot = diagnosticSnapshot();
  assert.equal(snapshot.events.length, 2000);
  assert.equal(snapshot.retention.overwritten, 100);
  assert.equal(snapshot.events[0].sequence, 101);
  assert.equal(snapshot.events.at(-1).sequence, 2100);
  assert.equal(snapshot.metrics[0].count, 2100);
  assert.equal(snapshot.metrics[0].samples, 64);
  assert.equal(JSON.stringify(snapshot).includes("do-not-retain"), false);
  assert.equal(JSON.stringify(snapshot).includes("private.example"), false);
  assert.deepEqual(snapshot.events[0].fields, { elapsedMs: 100 });
  snapshot.events[0].fields.elapsedMs = -1;
  assert.equal(diagnosticSnapshot().events[0].fields.elapsedMs, 100);
});

test("a successful export acknowledgement retains events recorded during export", () => {
  clearDiagnostics();
  recordDiagnostic("playback:loaded");
  const captured = diagnosticSnapshot();
  recordDiagnostic("playback:buffering", { elapsedMs: 150 });
  // A failed export never calls acknowledge, so both events are still available.
  assert.equal(diagnosticSnapshot().events.length, 2);
  acknowledgeDiagnosticExport(captured.events.at(-1).sequence);
  assert.deepEqual(
    diagnosticSnapshot().events.map((event) => event.name),
    ["playback:buffering"],
  );
  assert.equal(diagnosticSnapshot().metrics[0].name, "playback:buffering");
  for (let i = 0; i < 2001; i++) recordDiagnostic("image:loaded");
  assert.equal(diagnosticSnapshot().events.length, 2000);
  assert.equal(diagnosticSnapshot().events.at(-1).sequence, captured.events.at(-1).sequence + 2002);
});

test("clearing during export preserves subsequent events and their ordering", () => {
  clearDiagnostics();
  recordDiagnostic("playback:loaded");
  const through = diagnosticSnapshot().events.at(-1).sequence;
  clearDiagnostics();
  recordDiagnostic("playback:restart");
  acknowledgeDiagnosticExport(through);
  assert.deepEqual(
    diagnosticSnapshot().events.map((event) => event.name),
    ["playback:restart"],
  );
});

test("timed operations record once and count failures", () => {
  clearDiagnostics();
  const finish = measureDiagnostic("calendar:fetch", { candidates: 3 });
  finish("error", { rows: 0 });
  finish("ok", { rows: 8 });
  const snapshot = diagnosticSnapshot();
  assert.equal(snapshot.events.length, 1);
  assert.equal(snapshot.events[0].fields.error, true);
  assert.equal(snapshot.events[0].fields.rows, 0);
  assert.equal(snapshot.metrics[0].errors, 1);
  assert.ok(snapshot.events[0].fields.elapsedMs >= 0);
});

test("navigation measures shell paint and ignores superseded requests", () => {
  clearDiagnostics();
  const savedRaf = globalThis.requestAnimationFrame;
  const savedCancel = globalThis.cancelAnimationFrame;
  const frames = [];
  globalThis.requestAnimationFrame = (fn) => {
    frames.push(fn);
    return frames.length;
  };
  globalThis.cancelAnimationFrame = () => {};
  try {
    beginDiagnosticNavigation("calendar");
    commitDiagnosticNavigation("calendar");
    frames.shift()(0);
    beginDiagnosticNavigation("movies");
    frames.shift()(1);
    assert.equal(
      diagnosticSnapshot().metrics.some((m) => m.name === "navigation:calendar:shell-paint"),
      false,
    );
    commitDiagnosticNavigation("movies");
    frames.shift()(2);
    frames.shift()(3);
    assert.equal(
      diagnosticSnapshot().metrics.some((m) => m.name === "navigation:movies:shell-paint"),
      true,
    );
  } finally {
    globalThis.requestAnimationFrame = savedRaf;
    globalThis.cancelAnimationFrame = savedCancel;
  }
});

test("navigation events carry distinct numeric correlation ids", () => {
  clearDiagnostics();
  const savedRaf = globalThis.requestAnimationFrame;
  const savedCancel = globalThis.cancelAnimationFrame;
  const frames = [];
  globalThis.requestAnimationFrame = (fn) => {
    frames.push(fn);
    return frames.length;
  };
  globalThis.cancelAnimationFrame = () => {};
  try {
    beginDiagnosticNavigation("home");
    commitDiagnosticNavigation("home");
    frames.shift()(0);
    frames.shift()(1);
    beginDiagnosticNavigation("calendar");
    commitDiagnosticNavigation("calendar");
    frames.shift()(2);
    frames.shift()(3);
    const events = diagnosticSnapshot().events.filter(
      (event) => event.name.endsWith(":requested") || event.name.endsWith(":shell-paint"),
    );
    assert.equal(events.length, 4);
    assert.ok(events.every((event) => Number.isInteger(event.fields.navigationId)));
    assert.notEqual(events[0].fields.navigationId, events[2].fields.navigationId);
  } finally {
    globalThis.requestAnimationFrame = savedRaf;
    globalThis.cancelAnimationFrame = savedCancel;
  }
});

test("agent navigation accepts only known destinations and captures no provider data", () => {
  const savedWindow = globalThis.window;
  const savedDocument = globalThis.document;
  globalThis.window = {
    setInterval: () => 1,
    clearInterval: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  globalThis.document = { addEventListener: () => {}, removeEventListener: () => {} };
  let stop;
  let unregister;
  try {
    stop = installDiagnostics();
    assert.equal(installDiagnostics(), stop);
    assert.throws(() => window.__HARBOR_DEBUG__.navigate("calendar"), /not ready/);
    let selected;
    unregister = registerDiagnosticNavigator((view) => {
      selected = view;
    });
    assert.throws(() => window.__HARBOR_DEBUG__.navigate("https://private.example"), /Unknown/);
    assert.deepEqual(window.__HARBOR_DEBUG__.navigate("calendar"), { requested: "calendar" });
    assert.equal(selected, "calendar");
  } finally {
    unregister?.();
    stop?.();
    globalThis.window = savedWindow;
    globalThis.document = savedDocument;
  }
});
