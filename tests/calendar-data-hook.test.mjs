import assert from "node:assert/strict";
import test from "node:test";
import { hookHarness, flushPromises } from "./helpers/hook-harness.ts";
import { CalendarCache } from "../src/lib/calendar-cache.ts";
import { readFileSync } from "node:fs";
import ts from "typescript";

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

function fixture(sourceApi) {
  let scope = '["one","owner",0]',
    revision = 0,
    sourceRevision = 0;
  const clearers = [];
  const calls = [];
  let saved = null;
  const snapshots = new Map();
  const saves = [];
  let traktSession = { accessToken: "trakt", username: "trakt-user" };
  const mocks = {
    "@/hooks/use-browse-cache-updates": { useBrowseCacheUpdates: () => 0 },
    "@/lib/calendar-cache": { CalendarCache },
    "@/lib/calendar-snapshot-cache": {
      calendarSnapshot: (scope, current) => ({
        read: async () => (current() ? (snapshots.get(JSON.stringify(scope)) ?? saved) : null),
        save: async (items, complete) => {
          saves.push({ items, complete });
          if (current()) snapshots.set(JSON.stringify(scope), { items, complete });
        },
      }),
    },
    "@/lib/trakt/session": { getSession: () => traktSession },
    "@/lib/simkl/session": { getSession: () => ({ accessToken: "simkl", username: "simkl-user" }) },
    "@/lib/calendar-cache-scope": {
      calendarScopeKey: () => scope,
      calendarCacheRevision: () => revision,
      subscribeCalendarCache: () => () => {},
      registerCalendarCache: (clear) => clearers.push(clear),
    },
    "@/lib/perf/diagnostics": { recordDiagnostic() {}, measureDiagnostic: () => () => {} },
    "@/lib/i18n": { t: (s) => s },
    "@/lib/calendar": {
      monthRangeISO: () => ({ start: "2026-10-01", end: "2026-10-31" }),
      fetchCalendarRange: () => Promise.resolve([]),
      fetchCustomCalendar: (opts) => {
        calls.push({ source: "custom", opts });
        return Promise.resolve([]);
      },
    },
    "@/lib/calendar-sources": sourceApi ?? {
      ...Object.fromEntries(
        [
          "Library",
          "Trakt",
          "Simkl",
          "SimklPremieres",
          "Anticipated",
          "AniListAiring",
          "AnimeDub",
        ].map((name) => [
          `fetch${name}Calendar`,
          (...args) => {
            const wait = deferred();
            calls.push({ source: name, args, wait });
            return wait.promise;
          },
        ]),
      ),
      subscribeCalendarSourceCache: () => () => {},
      calendarSourceCacheRevision: () => sourceRevision,
    },
  };
  const source = "src/views/calendar/use-calendar-data.ts";
  // Separate harnesses execute the module afresh; share its cache to model real remounts.
  const sharedCache = new CalendarCache(18, 300000);
  mocks["@/lib/calendar-cache"].CalendarCache = class {
    constructor() {
      return sharedCache;
    }
  };
  const create = () => hookHarness(source, "useCalendarData", mocks);
  const args = {
    source: "library",
    authKey: "auth",
    traktConnected: true,
    simklConnected: false,
    year: 2026,
    month: 9,
    animeDub: false,
    settings: {
      tmdbKey: "tmdb",
      tmdbLanguage: "en",
      region: "US",
      customCalendar: {
        trackedPeople: [],
        genres: [],
        watchProviders: [],
        originCountries: [],
        mediaTypes: { movie: true, tv: true, anime: true },
      },
    },
  };
  return {
    create,
    args,
    calls,
    saves,
    setSaved(value) {
      saved = value;
    },
    setTraktSession(value) {
      traktSession = value;
    },
    refreshSources() {
      sourceRevision++;
    },
    invalidate(next = scope) {
      scope = next;
      revision++;
      saved = null;
      snapshots.clear();
      clearers.forEach((clear) => clear());
    },
  };
}

test("remount coalesces pending work and reuses warm rows", async () => {
  const f = fixture();
  f.args.source = "trakt";
  const first = f.create();
  first.render(f.args);
  await flushPromises();
  first.unmount();
  const second = f.create();
  second.render(f.args);
  await flushPromises();
  assert.equal(f.calls.length, 1);
  f.calls[0].wait.resolve([{ id: "one" }]);
  await flushPromises();
  assert.deepEqual(second.render(f.args).items, [{ id: "one" }]);
  second.unmount();
  const third = f.create();
  const warm = third.render(f.args);
  await flushPromises();
  assert.deepEqual(warm.items, [{ id: "one" }]);
  assert.equal(warm.loading, false);
  assert.equal(f.calls.length, 1);
  third.unmount();
});

test("restart displays disk rows while the library loader is blocked and keeps them offline", async () => {
  const f = fixture();
  f.setSaved({ complete: true, items: [{ id: "yesterday" }] });
  const h = f.create();
  h.render(f.args);
  await flushPromises();
  assert.deepEqual(h.render(f.args).items, [{ id: "yesterday" }]);
  assert.equal(h.render(f.args).loading, false);
  assert.equal(f.calls.length, 1);
  f.calls[0].wait.reject(new Error("offline"));
  await flushPromises();
  assert.deepEqual(h.render(f.args).items, [{ id: "yesterday" }]);
  assert.equal(h.render(f.args).error, "offline");
  h.unmount();
});

test("failed nonempty provider refresh preserves complete disk rows without saving or warming partial data", async () => {
  const f = fixture();
  f.args.source = "trakt";
  f.setSaved({ complete: true, items: [{ id: "complete" }] });
  const h = f.create();
  h.render(f.args);
  await flushPromises();
  assert.equal(f.calls[0].args[2], true);
  f.calls[0].wait.reject(new Error("movie half failed"));
  await flushPromises();
  assert.deepEqual(h.render(f.args).items, [{ id: "complete" }]);
  assert.equal(f.saves.length, 0);
  h.unmount();
  const next = f.create();
  next.render(f.args);
  await flushPromises();
  assert.equal(f.calls.length, 2);
  next.unmount();
});

test("username-less provider accounts do not share a memory or durable scope", async () => {
  const f = fixture();
  f.args.source = "trakt";
  f.setTraktSession({ username: null, accessToken: "account-one" });
  const h = f.create();
  h.render(f.args);
  await flushPromises();
  f.calls[0].wait.resolve([{ id: "one" }]);
  await flushPromises();
  f.setTraktSession({ username: null, accessToken: "account-two" });
  assert.deepEqual(h.render(f.args).items, []);
  await flushPromises();
  assert.equal(f.calls.length, 2);
  assert.deepEqual(h.render(f.args).items, []);
  h.unmount();
});

test("month/source/account changes hide old rows immediately and reject late completion", async () => {
  const f = fixture();
  const h = f.create();
  h.render(f.args);
  await flushPromises();
  const next = { ...f.args, month: 10 };
  assert.deepEqual(h.render(next).items, []);
  await flushPromises();
  f.calls[0].wait.resolve([{ id: "old" }]);
  await flushPromises();
  assert.deepEqual(h.render(next).items, []);
  f.calls[1].wait.resolve([{ id: "new" }]);
  await flushPromises();
  assert.deepEqual(h.render(next).items, [{ id: "new" }]);
  f.invalidate('["other-account","owner",0]');
  assert.deepEqual(h.render(next).items, []);
  await flushPromises();
  assert.equal(f.calls.length, 3);
  const trakt = { ...next, source: "trakt" };
  assert.deepEqual(h.render(trakt).items, []);
  await flushPromises();
  assert.equal(f.calls[3].source, "Trakt");
  h.unmount();
});

test("all custom filters refetch; base starts with pending extras", async () => {
  const f = fixture();
  const h = f.create();
  let args = {
    ...f.args,
    source: "custom",
    settings: {
      ...f.args.settings,
      customCalendar: {
        ...f.args.settings.customCalendar,
        includeTraktAnticipated: true,
      },
    },
  };
  h.render(args);
  await flushPromises();
  assert.deepEqual(
    f.calls.map((c) => c.source),
    ["Anticipated", "custom"],
  );
  assert.ok(f.calls[1].opts.extra instanceof Promise);
  for (const [key, value] of Object.entries({
    genres: [{ id: 1, mediaType: "movie" }],
    watchProviders: [{ id: 1 }],
    originCountries: ["GB"],
    mediaTypes: { movie: false, tv: true, anime: false },
  })) {
    args = {
      ...args,
      settings: {
        ...args.settings,
        customCalendar: { ...args.settings.customCalendar, [key]: value },
      },
    };
    h.render(args);
    await flushPromises();
  }
  assert.equal(f.calls.filter((c) => c.source === "custom").length, 5);
  h.unmount();
});

test("library snapshots reach UI and superseded generations are aborted", async () => {
  const f = fixture();
  const h = f.create();
  h.render(f.args);
  await flushPromises();
  const opts = f.calls[0].args[3];
  const progress = { resolved: 1, pending: 2, failed: 0, complete: false };
  opts.onSnapshot([{ id: "fast" }], progress);
  assert.deepEqual(h.render(f.args).items, [{ id: "fast" }]);
  assert.deepEqual(h.render(f.args).progress, progress);
  assert.equal(h.render(f.args).loading, true);
  const next = { ...f.args, month: 10 };
  h.render(next);
  assert.equal(opts.signal.aborted, true);
  opts.onSnapshot([{ id: "stale" }], progress);
  assert.deepEqual(h.render(next).items, []);
  h.unmount();
});

test("failed partial calendar keeps visible rows and never warms the complete month cache", async () => {
  const f = fixture();
  const first = f.create();
  first.render(f.args);
  await flushPromises();
  const status = { resolved: 1, pending: 0, failed: 1, complete: false, reason: "failed" };
  f.calls[0].args[3].onSnapshot([{ id: "good" }], status);
  f.calls[0].wait.reject(Object.assign(new Error("tail failed"), { status }));
  await flushPromises();
  const failed = first.render(f.args);
  assert.deepEqual(failed.items, [{ id: "good" }]);
  assert.equal(failed.error, "tail failed");
  assert.equal(failed.progress.complete, false);
  first.unmount();
  const second = f.create();
  second.render(f.args);
  await flushPromises();
  assert.equal(f.calls.length, 2);
  second.unmount();
});

test("late progressive callbacks cannot replace a completed refresh", async () => {
  const f = fixture();
  f.setSaved({ complete: true, items: [{ id: "old" }] });
  const h = f.create();
  h.render(f.args);
  await flushPromises();
  const call = f.calls[0];
  call.args[3].onSnapshot([{ id: "partial" }], { complete: false });
  assert.deepEqual(
    h.render(f.args).items.map((row) => row.id),
    ["old", "partial"],
  );
  call.wait.resolve([{ id: "fresh" }]);
  await flushPromises();
  call.args[3].onSnapshot([{ id: "late" }], { complete: false });
  assert.deepEqual(h.render(f.args).items, [{ id: "fresh" }]);
  assert.deepEqual(f.saves.at(-1), { items: [{ id: "fresh" }], complete: true });
  h.unmount();
});

test("unrelated source notifications do not restart a personal library load", async () => {
  const f = fixture();
  const h = f.create();
  h.render(f.args);
  await flushPromises();
  f.refreshSources();
  h.render(f.args);
  await flushPromises();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].args[3].signal.aborted, false);
  h.unmount();
});

function realSources(fetchProvider) {
  const mocks = {
    "./calendar-cache": { CalendarCache },
    "./calendar-cache-scope": {
      calendarScopeKey: () => "scope",
      registerCalendarCache() {},
      invalidateCalendarCaches() {},
    },
    "./calendar-scheduler": {},
    "./providers/tmdb/tmdb-client": {},
    "./cinemeta": {},
    "./trakt/calendar": {},
    "./calendar-time": {
      localDateTimeFromIso: () => ({ date: "2026-10-10", time: "12:00", atMs: 1 }),
    },
    "./calendar-library": {},
    "./simkl/watchlist": {},
    "./simkl/calendar": {
      clearCalendarCache() {},
      fetchSimklCdnCalendar: () => fetchProvider("simkl"),
    },
    "./simkl/session": {},
    "./anilist/airing": { fetchAniListAiringCalendar: () => fetchProvider("anilist") },
    "./providers/anime-dub-sub": { fetchDubSchedule: () => fetchProvider("dub") },
  };
  const code = ts.transpileModule(readFileSync("src/lib/calendar-sources.ts", "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const api = {};
  new Function("require", "exports", code)((id) => {
    assert.ok(id in mocks, id);
    return mocks[id];
  }, api);
  return api;
}

test("real public sources refresh a mounted hook without a stale warm-cache hit", async () => {
  const realNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    for (const provider of ["anilist", "dub", "simkl"]) {
      const next = deferred();
      let calls = 0;
      const dubRow = (id) => ({
        episodeNumber: 1,
        episodeDate: "2026-10-10",
        media: { media: { id, title: { english: id } } },
      });
      const rows = (id) => (provider === "dub" ? [dubRow(id)] : [{ id, name: id }]);
      const api = realSources((kind) => {
        assert.equal(kind, provider);
        return ++calls === 1 ? Promise.resolve(rows("old")) : next.promise;
      });
      const fetch =
        provider === "anilist"
          ? api.fetchAniListAiringCalendar
          : provider === "dub"
            ? api.fetchAnimeDubCalendar
            : api.fetchSimklPremieresCalendar;
      await fetch(2026, 9);
      now += 31 * 60_000;
      const f = fixture(api);
      f.args.source = provider === "simkl" ? "simkl-anticipated" : "anime";
      f.args.animeDub = provider === "dub";
      const h = f.create();
      h.render(f.args);
      await flushPromises();
      assert.match(h.render(f.args).items[0].id, /old/);
      assert.equal(calls, 2);
      next.resolve(rows("fresh"));
      await flushPromises();
      h.render(f.args);
      await flushPromises();
      assert.match(h.render(f.args).items[0].id, /fresh/);
      assert.equal(calls, 2);
      h.unmount();
    }
  } finally {
    Date.now = realNow;
  }
});

test("authoritative empty public results remove obsolete rows and save complete", async () => {
  let calls = 0;
  const api = realSources(async () => {
    calls++;
    return [];
  });
  const f = fixture(api);
  f.args.source = "anime";
  f.setSaved({ complete: true, items: [{ id: "obsolete" }] });
  const h = f.create();
  h.render(f.args);
  await flushPromises();
  assert.deepEqual(h.render(f.args).items, []);
  assert.ok(f.saves.some((save) => save.complete && save.items.length === 0));
  h.unmount();
  const next = f.create();
  next.render(f.args);
  await flushPromises();
  assert.equal(calls, 1);
  assert.deepEqual(next.render(f.args).items, []);
  next.unmount();
});

test("an expired public source publishes an empty refresh to the mounted view and snapshot", async () => {
  const realNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    const next = deferred();
    let calls = 0;
    const api = realSources(() =>
      ++calls === 1 ? Promise.resolve([{ id: "old" }]) : next.promise,
    );
    await api.fetchAniListAiringCalendar(2026, 9);
    now += 31 * 60_000;
    const f = fixture(api);
    f.args.source = "anime";
    const h = f.create();
    h.render(f.args);
    await flushPromises();
    assert.equal(h.render(f.args).items[0].id, "old");
    next.resolve([]);
    await flushPromises();
    h.render(f.args);
    await flushPromises();
    assert.deepEqual(h.render(f.args).items, []);
    assert.ok(f.saves.some((save) => save.complete && save.items.length === 0));
    assert.equal(calls, 2);
    h.unmount();
  } finally {
    Date.now = realNow;
  }
});

test("successful strict public feeds replace complete snapshots", async () => {
  for (const source of ["anime", "simkl-anticipated"]) {
    const f = fixture();
    f.args.source = source;
    f.setSaved({ complete: true, items: [{ id: "complete" }] });
    const h = f.create();
    h.render(f.args);
    await flushPromises();
    const call = f.calls.find(
      (item) => item.source === (source === "anime" ? "AniListAiring" : "SimklPremieres"),
    );
    call.wait.resolve([{ id: "fresh" }]);
    await flushPromises();
    assert.deepEqual(
      h.render(f.args).items.map((item) => item.id),
      ["fresh"],
    );
    assert.ok(f.saves.some((save) => save.complete));
    h.unmount();
  }
});

test("deadline publishes and saves partial rows from the resolver final error", async () => {
  const f = fixture();
  f.setSaved({ complete: true, items: [{ id: "saved" }] });
  const h = f.create();
  h.render(f.args);
  await flushPromises();
  f.calls[0].wait.reject(
    Object.assign(new Error("deadline"), {
      items: [{ id: "last-result" }],
      status: { resolved: 1, pending: 1, failed: 0, complete: false, reason: "deadline" },
    }),
  );
  await flushPromises();
  assert.deepEqual(
    h.render(f.args).items.map((item) => item.id),
    ["saved", "last-result"],
  );
  assert.ok(f.saves.some((save) => !save.complete && save.items[0]?.id === "last-result"));
  h.unmount();
});
