import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

test("profile/account/session and local-library mutations invalidate caches and notify mounted consumers", () => {
  const callbacks = new Map();
  let cw = [];
  const subscribe = (name) => (fn) => callbacks.set(name, fn);
  const mocks = {
    "./active-profile-id": {
      activeScopedProfileId: () => "profile",
      nuvioWatchedScope: () => "owner",
    },
    "./trakt/session": { subscribeSession: subscribe("trakt") },
    "./simkl/session": { subscribeSession: subscribe("simkl") },
    "./watchlist": { subscribeWatchlist: subscribe("watchlist") },
    "./local-cw": { subscribeLocalCw: subscribe("cw"), listLocalCw: () => cw },
    "./manual-watched": { subscribeManualWatched: subscribe("watched") },
  };
  const api = {};
  const code = ts.transpileModule(readFileSync("src/lib/calendar-cache-scope.ts", "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function("require", "exports", "window", code)((id) => mocks[id], api, {
    addEventListener: (name, fn) => callbacks.set(name, fn),
  });
  let clears = 0,
    updates = 0;
  const purges = [];
  api.registerCalendarCache((purge = true) => {
    clears++;
    purges.push(purge);
  });
  const unsubscribe = api.subscribeCalendarCache(() => updates++);
  for (const name of [
    "trakt",
    "simkl",
    "watchlist",
    "cw",
    "watched",
    "harbor:active-profile-changed",
    "harbor:account-provider-changed",
    "harbor:nuvio-state-changed",
    "storage",
  ]) {
    const previous = api.calendarScopeKey();
    if (name === "cw")
      cw = [{ id: "series-one", type: "series", season: 1, episode: 2, positionMs: 1000 }];
    callbacks.get(name)();
    assert.notEqual(api.calendarScopeKey(), previous, name);
  }
  assert.equal(clears, 9);
  assert.equal(updates, 9);
  cw = cw.map((entry) => ({ ...entry, positionMs: 5000, t: 12345 }));
  callbacks.get("cw")();
  assert.equal(clears, 9, "position-only autosave keeps calendar cache warm");
  cw = cw.map((entry) => ({ ...entry, episode: 3 }));
  callbacks.get("cw")();
  assert.equal(clears, 10, "episode membership changes invalidate calendar");
  // A library sync at launch must not delete the saved calendar the view opens with.
  assert.deepEqual(purges, Array(10).fill(false));
  unsubscribe();
  api.invalidateCalendarCaches();
  assert.equal(updates, 10);
  assert.equal(purges.at(-1), true, "an explicit clear still purges saved data");
});
