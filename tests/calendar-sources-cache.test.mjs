import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { CalendarCache } from "../src/lib/calendar-cache.ts";
import { mapCalendarLimit } from "../src/lib/calendar-scheduler.ts";

test("personal SIMKL rows separate identity, key, language and clear dependent cache on invalidation", async () => {
  let scope = "one",
    language = "en",
    connected = true,
    calls = 0,
    dependentClears = 0;
  const clearers = [];
  const mocks = {
    "./calendar-cache": { CalendarCache },
    "./calendar-cache-scope": {
      calendarScopeKey: () => scope,
      registerCalendarCache: (clear) => clearers.push(clear),
      invalidateCalendarCaches: () => clearers.forEach((clear) => clear()),
    },
    "./calendar-scheduler": { mapCalendarLimit },
    "./providers/tmdb/tmdb-client": { effectiveTmdbLanguage: () => language },
    "./cinemeta": {},
    "./trakt/calendar": {},
    "./calendar-time": {},
    "./calendar-library": {
      prepareCalendarCandidates: async (options, gather) => ({
        candidates: await gather(new AbortController().signal),
        options,
      }),
      resolveSavedCalendar: async (candidates) => candidates,
    },
    "./simkl/watchlist": {
      fetchWatchlist: async () => {
        calls++;
        return [{ type: "movie", title: scope, ids: { imdb: "tt1" } }];
      },
      fetchWatchingItems: async () => [],
      invalidateWatchlistCache: () => dependentClears++,
    },
    "./simkl/calendar": {},
    "./simkl/session": { isAuthenticated: () => connected },
    "./anilist/airing": {},
    "./providers/anime-dub-sub": {},
  };
  const api = {};
  const code = ts.transpileModule(readFileSync("src/lib/calendar-sources.ts", "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function("require", "exports", code)((id) => {
    assert.ok(id in mocks, id);
    return mocks[id];
  }, api);
  const fetch = (key = "key") => api.fetchSimklCalendar(2026, 9, { tmdbKey: key });
  assert.equal((await fetch())[0].name, "one");
  await fetch();
  assert.equal(calls, 1);
  scope = "two";
  assert.equal((await fetch())[0].name, "two");
  await fetch("new key");
  assert.equal(calls, 3);
  language = "fr";
  await fetch("new key");
  assert.equal(calls, 4);
  api.clearCalendarSourceCache();
  assert.equal(dependentClears, 1);
  await fetch("new key");
  assert.equal(calls, 5);
  connected = false;
  assert.deepEqual(await fetch(), []);
  assert.equal(calls, 5);
});
