import test from "node:test";
import assert from "node:assert/strict";
import { createMediaCache } from "../src/lib/media-cache.ts";
import { projectCatalogPage } from "../src/lib/providers/tmdb/tmdb-catalog-cache.ts";
import { createPrefetchCoordinator } from "../src/lib/prefetch/coordinator.ts";
import { readFileSync } from "node:fs";
import ts from "typescript";

const turn = () => new Promise((resolve) => setImmediate(resolve));
function fixture() {
  const records = new Map();
  const store = {
    async get(key) {
      return structuredClone(records.get(key) ?? null);
    },
    async put(record) {
      records.set(record.key, structuredClone(record));
      return true;
    },
    async remove(keys) {
      for (const key of keys) records.delete(key);
    },
    async list() {
      return [...records.values()].map(({ value: _value, ...index }) => index);
    },
    async clear() {
      records.clear();
      return true;
    },
  };
  return { records, store };
}

test("browse data survives a cache restart and memory release without retaining private fields", async () => {
  const f = fixture();
  const page = projectCatalogPage({
    results: [{ id: 1, title: "A", poster_path: "https://private/?token=x", secret: "x" }],
  });
  assert.deepEqual(page, { results: [{ id: 1, title: "A" }] });
  const cache = createMediaCache(f.store);
  await cache.save("v1:browse-catalog:key", page, { ttl: 60_000 });
  cache.releaseMemory("v1:browse-catalog:");
  const reopened = createMediaCache(f.store);
  assert.deepEqual(
    (await reopened.load("v1:browse-catalog:key", async () => assert.fail("network"))).value,
    page,
  );
  assert.equal(f.records.size, 1);
});

test("clear fences a loader that completes late", async () => {
  const f = fixture();
  const cache = createMediaCache(f.store);
  let finish;
  const loading = cache.load(
    "v1:browse-catalog:key",
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await turn();
  await cache.clear();
  finish({ results: [] });
  await loading;
  await cache.flush();
  assert.equal(f.records.size, 0);
});

test("scope invalidation fences queued writes and removes an already active write", async () => {
  const f = fixture();
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const originalPut = f.store.put;
  let puts = 0;
  f.store.put = async (record) => {
    puts++;
    if (puts === 1) await blocked;
    return originalPut(record);
  };
  const cache = createMediaCache(f.store);
  let epoch = 0;
  const currentEpoch = epoch;
  const policy = { current: () => epoch === currentEpoch };
  const first = cache.save("v1:library-read-one:a", { value: 1 }, policy);
  await turn();
  const second = cache.save("v1:library-read-one:b", { value: 2 }, policy);
  epoch++;
  const removed = cache.removePrefix("v1:library-read-");
  release();
  await Promise.all([first, second, removed]);
  assert.equal(puts, 1);
  assert.equal(f.records.size, 0);
});

test("browse namespace caps entries and skips oversized payloads", async () => {
  const f = fixture();
  const cache = createMediaCache(f.store);
  for (let i = 0; i < 130; i++) {
    await cache.save(`v1:browse-catalog:${i}`, { value: i }, { ttl: 60_000 });
  }
  assert.equal(f.records.size, 128);
  assert.equal(
    await cache.save("v1:browse-catalog:large", { value: "large" }, { maxBytes: 2 }),
    false,
  );
  assert.equal(f.records.size, 128);
});

test("prefetch runs only when admitted, pauses queued jobs, and resumes after an active job", async () => {
  const pending = [];
  const coordinator = createPrefetchCoordinator((run) => {
    const ticket = { run, cancelled: false };
    pending.push(ticket);
    return () => {
      ticket.cancelled = true;
    };
  });
  const calls = [];
  let finish;
  coordinator.start([
    () => {
      calls.push("old");
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
    async () => {
      calls.push("discard");
    },
  ]);
  assert.deepEqual(calls, []);
  pending.shift().run();
  await turn();
  coordinator.pause();
  coordinator.start([
    async () => {
      calls.push("new");
    },
  ]);
  finish();
  await turn();
  pending.shift().run();
  await turn();
  assert.deepEqual(calls, ["old", "new"]);
});

test("warming selects Home, Calendar and only enabled first-page categories", async () => {
  const calls = [];
  let browseReleases = 0;
  let tmdbReleases = 0;
  const makeSpec = (key) => ({ key, fetcher: async (page) => calls.push([key, page]) });
  const mocks = {
    "../media-cache": {
      releaseBrowseCacheMemory() {
        browseReleases++;
      },
    },
    "../providers/tmdb/tmdb-client": {
      releaseTmdbCatalogMemory() {
        tmdbReleases++;
      },
    },
    "../page-rows": { loadPageRows: (page) => ({ hidden: page === "movies" ? ["hidden"] : [] }) },
    "@/views/movies/movie-specs": {
      movieSpecs: () => [makeSpec("movie"), makeSpec("hidden"), makeSpec("under-90")],
    },
    "@/views/shows/show-specs": { showSpecs: () => [makeSpec("show")] },
    "../calendar": { calendarWarmJobs: () => [async () => calls.push(["calendar", 1])] },
    "../feed/hero-pool": { fetchHeroFeed: async () => calls.push(["home", 1]) },
  };
  const code = ts.transpileModule(readFileSync("src/lib/prefetch/browse-data.ts", "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const api = {};
  new Function("require", "exports", code)((id) => mocks[id], api);
  for (const job of api.browseWarmJobs("key", "US")) await job();
  assert.deepEqual(calls, [
    ["home", 1],
    ["calendar", 1],
    ["movie", 1],
    ["show", 1],
  ]);
  // A warm completion must leave durable/memory cache ownership intact; the
  // next warm pass can coalesce against it instead of forcing a network storm.
  for (const job of api.browseWarmJobs("key", "US")) await job();
  assert.equal(browseReleases, 0);
  assert.equal(tmdbReleases, 0);
  assert.deepEqual(api.browseWarmJobs("", "US"), []);
});

test("aborting a warm consumer leaves a shared demand request intact", async () => {
  let finish;
  const shared = new Promise((resolve) => {
    finish = resolve;
  });
  const calls = [];
  const mocks = {
    "../page-rows": { loadPageRows: () => ({ hidden: [] }) },
    "@/views/movies/movie-specs": { movieSpecs: () => [] },
    "@/views/shows/show-specs": { showSpecs: () => [] },
    "../calendar": {
      calendarWarmJobs: () => [
        () => {
          calls.push("calendar");
          return shared;
        },
      ],
    },
    "../feed/hero-pool": { fetchHeroFeed: () => shared },
  };
  const code = ts.transpileModule(readFileSync("src/lib/prefetch/browse-data.ts", "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const api = {};
  new Function("require", "exports", code)((id) => mocks[id], api);
  const controller = new AbortController();
  const [hero, calendar] = api.browseWarmJobs("key", "US");
  const warm = calendar(controller.signal);
  controller.abort();
  await hero(controller.signal);
  finish("demand result");
  assert.equal(await shared, "demand result");
  await warm;
  assert.deepEqual(calls, ["calendar"]);
});
