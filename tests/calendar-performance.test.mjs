import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

function clock() {
  let now = 0;
  const pending = [];
  return {
    get now() {
      return now;
    },
    delay(ms, value) {
      return new Promise((resolve) =>
        pending.push({ at: now + ms, resolve: () => resolve(value) }),
      );
    },
    async finish(promise) {
      let done = false;
      let result;
      let error;
      promise.then(
        (v) => {
          done = true;
          result = v;
        },
        (e) => {
          done = true;
          error = e;
        },
      );
      for (let i = 0; i < 10000 && !done; i++) {
        // Drain all promise continuations before advancing the simulated clock.
        for (let j = 0; j < 100; j++) await Promise.resolve();
        if (done) break;
        assert.ok(pending.length, "provider deadlock");
        now = Math.min(...pending.map((p) => p.at));
        for (let j = pending.length - 1; j >= 0; j--) {
          if (pending[j].at === now) pending.splice(j, 1)[0].resolve();
        }
      }
      assert.ok(done);
      if (error) throw error;
      return result;
    },
  };
}

function loadLibrary(overrides = {}) {
  const modules = new Map();
  const mocks = {
    "./cinemeta": { meta: async () => null },
    "./stremio": { library: async () => [] },
    "./watchlist": { readLocalEntries: () => [] },
    "./local-cw": { listLocalCw: () => [] },
    "./manual-watched": { manualWatchedLibraryItems: () => [] },
    "./trakt/watchlist": { fetchWatchlist: async () => [] },
    "./providers/tvmaze": { tvmazeUpcoming: async () => null },
    "./providers/tmdb/tmdb-client": { effectiveTmdbLanguage: () => "en-US" },
    "./providers/tmdb/tmdb-calendar": {},
    "./providers/anizip": {},
    "./providers/anime-mapping": {
      imdbToKitsu: async () => null,
      tmdbTvToKitsu: async () => null,
      kitsuToAnilist: async () => null,
    },
    "./anilist/entry": { anilistAnimeEntry: async () => null },
    "./anilist/next-airing": { fetchAnilistAiringSchedule: async () => null },
    "./anime-tracker-entry": { resolveTrackerAnimeEntry: async () => null },
    // No installation salt: titles skip the disk cache in these tests.
    "./cache-scope": { cacheInstallationSalt: () => "" },
    "./media-cache": {
      readMediaValue: async () => null,
      removeMediaNamespaces: async () => {},
      saveMedia: async () => false,
    },
    "./providers/anime-franchise-root": { franchiseRoot: async (id) => id },
    "./calendar-time": { localDateTimeFromIso: (date) => ({ date }) },
    "@/lib/perf/diagnostics": { recordDiagnostic() {}, measureDiagnostic: () => () => {} },
    "./calendar-cache-scope": { calendarScopeKey: () => "scope", registerCalendarCache() {} },
    ...overrides,
  };
  function load(file) {
    if (modules.has(file)) return modules.get(file);
    const exports = {};
    modules.set(file, exports);
    const code = ts.transpileModule(readFileSync(file, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    new Function("require", "exports", code)((id) => {
      if (id in mocks) return mocks[id];
      assert.ok(id.startsWith("./calendar-") || id === "./cache", `Unexpected import ${id}`);
      return load(path.resolve(path.dirname(file), `${id}.ts`));
    }, exports);
    return exports;
  }
  return load(path.resolve("src/lib/calendar-library.ts"));
}

const candidate = (id, type = "series") => ({ id, type, name: id, mtime: 0, temp: false });

test("resolves every library title beyond the former eighty-title caps", async (t) => {
  // Fixture dates are October 2026; the library window is relative to now.
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-01T00:00:00Z") });
  const api = loadLibrary({
    "./cinemeta": {
      meta: async (_type, id) => ({
        id,
        name: id,
        releaseDate: "2026-10-10",
        videos: [{ season: 1, episode: 1, released: "2026-10-10", name: "Episode" }],
      }),
    },
  });
  const statuses = [];
  const rows = await api.resolveSavedCalendar(
    [
      ...Array.from({ length: 95 }, (_, i) => candidate(`tt-series-${i}`)),
      ...Array.from({ length: 90 }, (_, i) => candidate(`tt-movie-${i}`, "movie")),
    ],
    2026,
    9,
    { tmdbKey: "", onSnapshot: (_rows, status) => statuses.push(status) },
  );
  assert.equal(rows.length, 185);
  assert.equal(statuses.at(-1).resolved, 185);
  assert.equal(statuses.at(-1).pending, 0);
  assert.equal(statuses.at(-1).complete, true);
});

test("an unresponsive title fails without preventing queued titles from resolving", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: new Date("2026-10-01T00:00:00Z") });
  const api = loadLibrary({
    "./cinemeta": {
      meta: (_type, id) =>
        id === "tt0"
          ? new Promise(() => {})
          : Promise.resolve({ id, name: id, releaseDate: "2026-10-10" }),
    },
  });
  const pending = api
    .resolveSavedCalendar(
      Array.from({ length: 10 }, (_, i) => candidate(`tt${i}`, "movie")),
      2026,
      9,
      { tmdbKey: "" },
    )
    .catch((error) => error);
  for (let i = 0; i < 200; i++) await Promise.resolve();
  t.mock.timers.tick(30_000);
  const error = await pending;
  assert.equal(error.status.resolved, 9);
  assert.equal(error.status.failed, 1);
  assert.equal(error.status.pending, 0);
  assert.equal(error.items.length, 9);
});

test("measures independent library/watchlist provider waits", async (t) => {
  const c = clock();
  const api = loadLibrary({
    "./stremio": { library: () => c.delay(40, []) },
    "./trakt/watchlist": { fetchWatchlist: () => c.delay(60, []) },
  });
  await c.finish(api.fetchLibraryCalendar("auth", 2026, 9, { tmdbKey: "", includeTrakt: true }));
  t.diagnostic(`library/watchlist simulated duration: ${c.now} ms`);
  assert.equal(c.now, 60);
});

test("franchise roots resolve inside the bounded title queue", async (t) => {
  const c = clock();
  const api = loadLibrary({
    "./local-cw": {
      listLocalCw: () => [1, 2, 3, 4].map((n) => ({ id: `mal:${n}`, type: "series" })),
    },
    "./providers/anime-franchise-root": { franchiseRoot: (id) => c.delay(20, id) },
    "./providers/anizip": { aniZipByMal: async () => null },
  });
  await c.finish(api.fetchLibraryCalendar("", 2026, 9, { tmdbKey: "", includeTrakt: false }));
  t.diagnostic(`four roots simulated duration: ${c.now} ms`);
  assert.equal(c.now, 20);
});

test("measures batch head-of-line waits and sequential movie start", async (t) => {
  const c = clock();
  const starts = [];
  const api = loadLibrary({
    "./cinemeta": {
      meta: (type, id) => {
        starts.push([type, id, c.now]);
        return c.delay(id === "tt1" ? 100 : 10, null);
      },
    },
  });
  await c.finish(
    api.resolveSavedCalendar(
      [...[1, 2, 3, 4, 5, 6].map((n) => candidate(`tt${n}`)), candidate("tt7", "movie")],
      2026,
      9,
      { tmdbKey: "" },
    ),
  );
  t.diagnostic(
    `mixed providers simulated duration: ${c.now} ms; fourth series start: ${starts.find((s) => s[1] === "tt4")[2]} ms; movie start: ${starts.find((s) => s[0] === "movie")[2]} ms`,
  );
  assert.equal(c.now, 100);
  assert.equal(starts.find((s) => s[1] === "tt4")[2], 0);
  assert.equal(starts.find((s) => s[0] === "movie")[2], 0);
});

test("measures overlapping metadata fetch duplication", async () => {
  const c = clock();
  let calls = 0;
  const api = loadLibrary({
    "./cinemeta": {
      meta: () => {
        calls++;
        return c.delay(10, null);
      },
    },
  });
  await c.finish(
    Promise.all(
      [1, 2].map(() => api.resolveSavedCalendar([candidate("tt1")], 2026, 9, { tmdbKey: "" })),
    ),
  );
  assert.equal(calls, 1);
});

test("custom discovery overlaps extras and preserves extra-first dedup/filter semantics", async (t) => {
  const c = clock();
  const code = ts.transpileModule(readFileSync("src/lib/calendar.ts", "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const api = {};
  let discoveryStarted;
  new Function("require", "exports", code)(
    (id) =>
      id === "@/lib/safe-fetch"
        ? {
            safeFetch: () => {
              discoveryStarted = c.now;
              return c.delay(40, {
                ok: true,
                json: async () => ({
                  results: [
                    { id: 1, title: "base duplicate", release_date: "2026-10-01" },
                    { id: 2, title: "base", release_date: "2026-10-02" },
                  ],
                }),
              });
            },
          }
        : {},
    api,
  );
  const extra = c.delay(60, [
    { id: "tmdb:movie:1", name: "extra", type: "movie", isAnime: false, releaseDate: "2026-10-01" },
    { id: "tv", type: "tv", isAnime: false, releaseDate: "2026-10-01" },
  ]);
  const rows = await c.finish(
    api.fetchCustomCalendar({
      apiKey: "key",
      region: "US",
      start: "2026-10-01",
      end: "2026-10-31",
      extra,
      filters: {
        trackedPeople: [],
        genres: [{ id: 1, mediaType: "movie" }],
        watchProviders: [],
        originCountries: [],
        mediaTypes: { movie: true, tv: false, anime: false },
      },
    }),
  );
  assert.equal(discoveryStarted, 0);
  assert.equal(c.now, 60);
  assert.deepEqual(
    rows.map((r) => r.name),
    ["extra", "base"],
  );
  t.diagnostic(`custom base/extras simulated duration: ${c.now} ms (serial waits: 100 ms)`);
});

test("catalog-only libraries skip irrelevant franchise lookups and films survive anime dedup", async () => {
  let roots = 0;
  const api = loadLibrary({
    "./local-cw": { listLocalCw: () => [{ id: "tt1", type: "series" }] },
    "./providers/anime-mapping": {
      imdbToKitsu: async () => {
        roots++;
        return null;
      },
    },
  });
  await api.fetchLibraryCalendar("", 2026, 9, { tmdbKey: "", includeTrakt: false });
  assert.equal(roots, 0);
  const localToday = new Date();
  const date = `${localToday.getFullYear()}-${String(localToday.getMonth() + 1).padStart(2, "0")}-${String(localToday.getDate()).padStart(2, "0")}`;
  const film = loadLibrary({
    "./local-cw": {
      listLocalCw: () => [
        { id: "mal:1", type: "series" },
        { id: "tt2", type: "movie" },
      ],
    },
    "./providers/anime-franchise-root": { franchiseRoot: async () => "same" },
    "./providers/anime-mapping": { imdbToKitsu: async () => 1 },
    "./providers/anizip": { aniZipByMal: async () => null },
    "./cinemeta": { meta: async () => ({ id: "tt2", name: "Film", releaseDate: date }) },
  });
  const today = new Date();
  const rows = await film.fetchLibraryCalendar("", today.getFullYear(), today.getMonth(), {
    tmdbKey: "",
    includeTrakt: false,
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "Film");
});

test("saved calendar publishes a fast result before a failed ten-second tail", async (t) => {
  // Fixture dates are October 2026; the library window is relative to now.
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-01T00:00:00Z") });
  const c = clock();
  const snapshots = [];
  const api = loadLibrary({
    "./cinemeta": {
      meta: (type, id) =>
        id === "tt1"
          ? c.delay(10000).then(() => {
              throw new Error("tail failed");
            })
          : c.delay(100, { id, name: "Fast film", releaseDate: "2026-10-10" }),
    },
  });
  const outcome = await c.finish(
    api
      .resolveSavedCalendar([candidate("tt1", "movie"), candidate("tt2", "movie")], 2026, 9, {
        tmdbKey: "",
        onSnapshot: (items) => snapshots.push({ at: c.now, items }),
      })
      .catch((error) => error),
  );
  assert.equal(snapshots[0].at, 100);
  assert.deepEqual(
    snapshots[0].items.map((item) => item.name),
    ["Fast film"],
  );
  assert.equal(outcome.status.complete, false);
  assert.equal(outcome.status.failed, 1);
  assert.deepEqual(outcome.items, snapshots[0].items);
  assert.equal(c.now, 10000);
});

test("aborting a saved calendar stops publication and queued provider starts", async (t) => {
  // Fixture dates are October 2026; the library window is relative to now.
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-01T00:00:00Z") });
  const c = clock();
  const controller = new AbortController();
  const snapshots = [];
  let starts = 0;
  const api = loadLibrary({
    "./cinemeta": {
      meta: (type, id) => {
        starts++;
        return c.delay(id === "tt1" ? 100 : 10000, { id, name: id, releaseDate: "2026-10-10" });
      },
    },
  });
  const outcome = await c.finish(
    api
      .resolveSavedCalendar(
        Array.from({ length: 10 }, (_, i) => candidate(`tt${i + 1}`, "movie")),
        2026,
        9,
        {
          tmdbKey: "",
          signal: controller.signal,
          onSnapshot: (items) => {
            snapshots.push(items);
            controller.abort();
          },
        },
      )
      .catch((error) => error),
  );
  assert.equal(c.now, 100);
  assert.equal(starts, 6);
  assert.equal(outcome.status.reason, "cancelled");
  assert.equal(outcome.items.length, 1);
  await c.finish(c.delay(10000));
  assert.equal(snapshots.length, 1);
  assert.equal(starts, 6);
});

test("TMDB series and movies share six provider slots", async () => {
  const c = clock();
  let active = 0;
  let peak = 0;
  const wait = (value) => {
    active++;
    peak = Math.max(peak, active);
    return c.delay(100, value).then((result) => {
      active--;
      return result;
    });
  };
  const api = loadLibrary({
    "./providers/tmdb/tmdb-calendar": {
      tmdbTvUpcoming: () => wait(null),
      tmdbMovieRelease: () => wait(null),
    },
  });
  await c.finish(
    api.resolveSavedCalendar(
      [
        ...Array.from({ length: 6 }, (_, i) => candidate(`tmdb:tv:${i}`)),
        ...Array.from({ length: 6 }, (_, i) => candidate(`tmdb:movie:${i}`, "movie")),
      ],
      2026,
      9,
      { tmdbKey: "key" },
    ),
  );
  assert.equal(peak, 6);
  assert.equal(c.now, 200);
});

test("deadline returns truthful incomplete status and fences late provider completion", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: new Date("2026-10-01T00:00:00Z") });
  let resolveTail;
  const snapshots = [];
  const api = loadLibrary({
    "./cinemeta": {
      meta: () =>
        new Promise((resolve) => {
          resolveTail = resolve;
        }),
    },
  });
  const outcome = api
    .resolveSavedCalendar([candidate("tt1", "movie")], 2026, 9, {
      tmdbKey: "",
      maxMs: 500,
      onSnapshot: (rows) => snapshots.push(rows),
    })
    .catch((error) => error);
  for (let i = 0; i < 100; i++) await Promise.resolve();
  t.mock.timers.tick(500);
  const error = await outcome;
  assert.equal(error.status.reason, "deadline");
  assert.equal(error.status.pending, 1);
  assert.equal(error.status.complete, false);
  resolveTail({ id: "tt1", name: "Late", releaseDate: "2026-10-10" });
  for (let i = 0; i < 100; i++) await Promise.resolve();
  assert.equal(snapshots.length, 0);
});

test("snapshot bursts are batched within a 100ms publication window", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: new Date("2026-10-01T00:00:00Z") });
  const resolves = new Map();
  const snapshots = [];
  const api = loadLibrary({
    "./cinemeta": { meta: (_type, id) => new Promise((resolve) => resolves.set(id, resolve)) },
  });
  const outcome = api.resolveSavedCalendar(
    [1, 2, 3].map((i) => candidate(`tt${i}`, "movie")),
    2026,
    9,
    { tmdbKey: "", onSnapshot: (rows) => snapshots.push(rows) },
  );
  const drain = async () => {
    for (let i = 0; i < 100; i++) await Promise.resolve();
  };
  await drain();
  resolves.get("tt1")({ id: "tt1", name: "One", releaseDate: "2026-10-10" });
  await drain();
  assert.equal(snapshots.length, 1);
  resolves.get("tt2")({ id: "tt2", name: "Two", releaseDate: "2026-10-10" });
  await drain();
  assert.equal(snapshots.length, 1);
  t.mock.timers.tick(99);
  await drain();
  assert.equal(snapshots.length, 1);
  t.mock.timers.tick(1);
  await drain();
  assert.equal(snapshots.length, 2);
  assert.equal(snapshots[1].length, 2);
  resolves.get("tt3")(null);
  await outcome;
});

test("a relaunch reuses titles resolved within 12 hours and resolves only new ones", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-01T00:00:00Z") });
  const disk = new Map();
  const media = {
    readMediaValue: async (namespace, key) => {
      const hit = disk.get(JSON.stringify([namespace, key]));
      return hit && hit.until > Date.now() ? hit.value : null;
    },
    saveMedia: async (namespace, key, value, policy) => {
      disk.set(JSON.stringify([namespace, key]), { value, until: Date.now() + policy.ttl });
      return true;
    },
    removeMediaNamespaces: async (prefix) => {
      for (const key of disk.keys()) if (JSON.parse(key)[0].startsWith(prefix)) disk.delete(key);
    },
  };
  const lookups = [];
  const launch = () => {
    const clearers = [];
    const api = loadLibrary({
      "./cache-scope": { cacheInstallationSalt: () => "salt" },
      "./media-cache": media,
      "./calendar-cache-scope": {
        calendarScopeKey: () => "scope",
        registerCalendarCache: (clear) => clearers.push(clear),
      },
      "./cinemeta": {
        meta: async (_type, id) => {
          lookups.push(id);
          if (id === "tt-broken") throw new Error("offline");
          return { id, name: id, releaseDate: "2026-10-10" };
        },
      },
    });
    const resolve = (ids) =>
      api
        .resolveSavedCalendar(
          ids.map((id) => candidate(id, "movie")),
          2026,
          9,
          { tmdbKey: "" },
        )
        .catch((error) => error.items);
    return { resolve, clear: (purge) => clearers.forEach((fn) => fn(purge)) };
  };
  const flushWrites = () => new Promise((resolve) => setImmediate(resolve));

  const first = launch();
  assert.equal((await first.resolve(["tt1", "tt2", "tt-broken"])).length, 2);
  await flushWrites();
  assert.deepEqual(lookups.sort(), ["tt-broken", "tt1", "tt2"]);

  lookups.length = 0;
  const second = launch();
  assert.equal((await second.resolve(["tt1", "tt2", "tt3", "tt-broken"])).length, 3);
  await flushWrites();
  assert.deepEqual(lookups.sort(), ["tt-broken", "tt3"], "only new and failed titles resolve");

  lookups.length = 0;
  second.clear(false);
  await second.resolve(["tt1", "tt2", "tt3"]);
  assert.deepEqual(lookups, [], "a library change keeps resolved titles");

  t.mock.timers.tick(12 * 60 * 60 * 1000 + 1);
  lookups.length = 0;
  await launch().resolve(["tt1"]);
  assert.deepEqual(lookups, ["tt1"], "titles older than 12 hours resolve again");

  lookups.length = 0;
  const third = launch();
  third.clear(true);
  await flushWrites();
  await third.resolve(["tt1"]);
  assert.deepEqual(lookups, ["tt1"], "an explicit clear forgets saved titles");
});
