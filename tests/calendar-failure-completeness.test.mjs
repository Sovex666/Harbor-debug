import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { CalendarCache } from "../src/lib/calendar-cache.ts";

function load(file, mocks) {
  const code = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const api = {};
  // calendar-core has no dependencies, so the real helpers load in place of a stub.
  const require = (id) =>
    mocks[id] ?? (id === "./calendar-core" ? load("src/lib/calendar-core.ts", {}) : {});
  new Function("require", "exports", code)(require, api);
  return api;
}

const { prepareCalendarCandidates } = load("src/lib/calendar-library.ts", {
  "./calendar-cache": { CalendarCache },
  "./calendar-cache-scope": { registerCalendarCache() {} },
});

test("candidate gathering is bounded and cancelled before resolution starts", async () => {
  await assert.rejects(
    prepareCalendarCandidates({ tmdbKey: "", maxMs: 5 }, () => new Promise(() => {})),
    (e) => e.status.reason === "deadline",
  );
  const controller = new AbortController();
  const pending = prepareCalendarCandidates(
    { tmdbKey: "", signal: controller.signal },
    () => new Promise(() => {}),
  );
  controller.abort();
  await assert.rejects(pending, (e) => e.status.reason === "cancelled");
});

test("strict SIMKL rejects malformed archive envelopes", async () => {
  const api = load("src/lib/simkl/calendar.ts", {
    "@/lib/safe-fetch": {
      safeFetch: async () => ({ ok: true, json: async () => ({ error: true }) }),
    },
    "./calendar-data": { parseSimklCalendar: () => [] },
  });
  await assert.rejects(api.fetchSimklCdnCalendar(2026, 9, true), /Invalid SIMKL/);
});

test("AniList rejects a failed page while successful feeds complete", async () => {
  let fail = true;
  const api = load("src/lib/anilist/airing.ts", {
    "./client": {
      AnilistApiError: class extends Error {},
      anilistRequest: async (_query, { page }) => {
        if (fail && page === 2) throw new Error("offline");
        return { Page: { airingSchedules: [], pageInfo: { hasNextPage: page === 1 } } };
      },
    },
  });
  await assert.rejects(api.fetchAniListAiringCalendar(2026, 9), /offline/);
  fail = false;
  assert.deepEqual(await api.fetchAniListAiringCalendar(2026, 9), []);
});

test("strict AniList ignores speculative pages after a confirmed empty first page", async () => {
  const api = load("src/lib/anilist/airing.ts", {
    "./client": {
      anilistRequest: async (_query, { page }) => {
        if (page > 1) throw new Error("unneeded page");
        return { Page: { airingSchedules: [], pageInfo: { hasNextPage: false } } };
      },
    },
  });
  assert.deepEqual(await api.fetchAniListAiringCalendar(2026, 9, true), []);
});

test("AniList rejects a page without an airing schedule", async () => {
  const api = load("src/lib/anilist/airing.ts", {
    "./client": { anilistRequest: async () => ({ Page: { airingSchedules: null, pageInfo: null } }) },
  });
  await assert.rejects(api.fetchAniListAiringCalendar(2026, 9), /incomplete airing schedule/);
});

test("strict SIMKL archive propagates a failed component and permits retry", async () => {
  let fail = true;
  const api = load("src/lib/simkl/calendar.ts", {
    "@/lib/safe-fetch": {
      safeFetch: async (url) => ({
        ok: !(fail && url.includes("anime.json")),
        json: async () => ({ calendar: [], metadata: {} }),
      }),
    },
    "./calendar-data": { parseSimklCalendar: () => [] },
  });
  await assert.rejects(api.fetchSimklCdnCalendar(2026, 9, true), /SIMKL/);
  fail = false;
  assert.deepEqual(await api.fetchSimklCdnCalendar(2026, 9, true), []);
});

test("a failed TMDB page rejects strict range while legacy range remains partial", async () => {
  const api = load("src/lib/calendar.ts", {
    "@/lib/safe-fetch": {
      safeFetch: async (input) => {
        const url = new URL(input);
        if (url.pathname.endsWith("/discover/tv") && url.searchParams.get("page") === "2") {
          return { ok: false };
        }
        return {
          ok: true,
          json: async () => ({ results: [{ id: 1, title: "Film", release_date: "2026-10-01" }] }),
        };
      },
    },
    "./scoped-data-cache": { cachedBrowsePage: async (_key, fetcher) => fetcher() },
    "./providers/tmdb/tmdb-catalog-cache": { projectCatalogPage: (value) => value },
  });
  const args = ["key", "2026-10-01", "2026-10-31", "US"];
  assert.equal((await api.fetchCalendarRange(...args)).length, 1);
  await assert.rejects(api.fetchCalendarRange(...args, true), /Calendar request failed/);
});

test("strict calendar demand reuses validated prefetched first pages", async () => {
  let requests = 0;
  const pages = new Map();
  const api = load("src/lib/calendar.ts", {
    "@/lib/safe-fetch": {
      safeFetch: async () => {
        requests++;
        return { ok: true, json: async () => ({ results: [] }) };
      },
    },
    "./scoped-data-cache": {
      cachedBrowsePage: async (scope, loader) => {
        const key = JSON.stringify(scope);
        if (pages.has(key)) return pages.get(key);
        const value = await loader();
        if (value !== null) pages.set(key, value);
        return value;
      },
    },
    "./providers/tmdb/tmdb-catalog-cache": { projectCatalogPage: (value) => value },
  });
  const now = new Date(2026, 9, 15);
  for (const job of api.calendarWarmJobs("key", "US", now)) await job();
  assert.equal(requests, 3);
  await api.fetchCalendarRange("key", "2026-10-01", "2026-10-31", "US", true);
  assert.equal(requests, 5, "only the two second pages need transport");
});

test("custom calendar propagates failed discovery and credits in strict mode", async () => {
  const api = load("src/lib/calendar.ts", {
    "@/lib/safe-fetch": { safeFetch: async () => ({ ok: false }) },
  });
  const filters = {
    trackedPeople: [],
    genres: [{ id: 1, mediaType: "movie" }],
    watchProviders: [],
    originCountries: [],
    mediaTypes: { movie: true, tv: false, anime: false },
  };
  const opts = { apiKey: "key", region: "US", start: "2026-10-01", end: "2026-10-31", filters };
  assert.deepEqual(await api.fetchCustomCalendar(opts), []);
  await assert.rejects(api.fetchCustomCalendar({ ...opts, strict: true }), /discovery/);
  await assert.rejects(
    api.fetchCustomCalendar({
      ...opts,
      strict: true,
      filters: {
        ...filters,
        genres: [],
        trackedPeople: [{ id: 1, name: "Person", role: "any" }],
      },
    }),
    /credits/,
  );
  await assert.rejects(
    api.fetchCustomCalendar({
      ...opts,
      strict: true,
      filters: { ...filters, genres: [] },
      extra: Promise.reject(new Error("extra failed")),
    }),
    /extra failed/,
  );
});

test("Trakt strict callers see failures while legacy callers retain empty fallbacks", async () => {
  const request = async () => {
    throw new Error("offline");
  };
  const calendar = load("src/lib/trakt/calendar.ts", { "./client": { traktRequest: request } });
  const watchlist = load("src/lib/trakt/watchlist.ts", { "./client": { traktRequest: request } });
  for (const [name, args] of [
    ["fetchUpcomingEpisodes", [14]],
    ["fetchUpcomingMovies", [30]],
    ["fetchAnticipatedShows", []],
    ["fetchAnticipatedMovies", []],
  ]) {
    assert.deepEqual(await calendar[name](...args), []);
    await assert.rejects(calendar[name](...args, true), /offline/);
  }
  assert.deepEqual(await watchlist.fetchWatchlist(), []);
  await assert.rejects(watchlist.fetchWatchlist(true), /offline/);
});

test("SIMKL strict loads bypass a cached legacy failure for both statuses", async () => {
  let fail = true;
  const api = load("src/lib/simkl/watchlist.ts", {
    "./activities/gate": { currentActivitiesAll: async () => "same" },
    "./client": {
      simklRequest: async () => {
        if (fail) throw new Error("offline");
        return { movies: [] };
      },
    },
  });
  for (const name of ["fetchWatchlist", "fetchWatchingItems"]) {
    assert.deepEqual(await api[name](), []);
    await assert.rejects(api[name](true), /offline/);
  }
  fail = false;
  assert.deepEqual(await api.fetchWatchlist(true), []);
});

test("SIMKL calendar rejects either failed list before resolving or caching candidates", async () => {
  let failed = "watching",
    resolutions = 0;
  const api = load("src/lib/calendar-sources.ts", {
    "./calendar-cache": { CalendarCache },
    "./calendar-cache-scope": { calendarScopeKey: () => "scope", registerCalendarCache() {} },
    "./providers/tmdb/tmdb-client": { effectiveTmdbLanguage: () => "en" },
    "./simkl/session": { isAuthenticated: () => true },
    "./simkl/watchlist": {
      fetchWatchlist: async (strict) => {
        assert.equal(strict, true);
        if (failed === "watchlist") throw new Error("watchlist");
        return [{ type: "movie", title: "Film", ids: { imdb: "tt1" } }];
      },
      fetchWatchingItems: async (strict) => {
        assert.equal(strict, true);
        if (failed === "watching") throw new Error("watching");
        return [];
      },
    },
    "./calendar-library": {
      prepareCalendarCandidates,
      resolveSavedCalendar: async (rows) => {
        resolutions++;
        return rows;
      },
    },
  });
  const fetch = () => api.fetchSimklCalendar(2026, 9, { tmdbKey: "key" });
  await assert.rejects(fetch(), /watching/);
  failed = "watchlist";
  await assert.rejects(fetch(), /watchlist/);
  assert.equal(resolutions, 0);
  failed = "none";
  assert.equal((await fetch()).length, 1);
});

test("Trakt calendar forwards strict mode to both personal and anticipated halves", async () => {
  const strictArgs = [];
  const api = load("src/lib/calendar-sources.ts", {
    "./calendar-cache": { CalendarCache },
    "./calendar-cache-scope": { registerCalendarCache() {} },
    "./trakt/calendar": {
      fetchUpcomingEpisodes: async (_days, strict) => {
        strictArgs.push(strict);
        return [];
      },
      fetchUpcomingMovies: async (_days, strict) => {
        strictArgs.push(strict);
        throw new Error("movie failed");
      },
      fetchAnticipatedShows: async (strict) => {
        strictArgs.push(strict);
        return [];
      },
      fetchAnticipatedMovies: async (strict) => {
        strictArgs.push(strict);
        throw new Error("movie failed");
      },
    },
  });
  const now = new Date();
  await assert.rejects(
    api.fetchTraktCalendar(now.getFullYear(), now.getMonth(), true),
    /movie failed/,
  );
  await assert.rejects(
    api.fetchAnticipatedCalendar(now.getFullYear(), now.getMonth(), true),
    /movie failed/,
  );
  assert.deepEqual(strictArgs, [true, true, true, true]);
});
