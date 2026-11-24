import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { createMediaCache } from "../src/lib/media-cache.ts";
import {
  createCatalogCache,
  isCatalogPath,
  projectCatalogPage,
} from "../src/lib/providers/tmdb/tmdb-catalog-cache.ts";
import { createPrefetchCoordinator } from "../src/lib/prefetch/coordinator.ts";

const turn = () => new Promise((resolve) => setImmediate(resolve));
function moduleWithMocks(path, mocks) {
  const code = ts.transpileModule(readFileSync(path, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const api = {};
  new Function("require", "exports", code)((id) => {
    assert.ok(id in mocks, `unexpected import ${id}`);
    return mocks[id];
  }, api);
  return api;
}

function fixture() {
  let now = 1_000_000;
  const records = new Map();
  const store = {
    get: async (key) => structuredClone(records.get(key) ?? null),
    put: async (record) => (records.set(record.key, structuredClone(record)), true),
    remove: async (keys) => keys.forEach((key) => records.delete(key)),
    list: async () => [...records.values()].map(({ value: _value, ...index }) => index),
    clear: async () => (records.clear(), true),
  };
  let cache = createMediaCache(store, { now: () => now });
  const media = {
    loadMedia: async (namespace, scope, loader, policy) =>
      cache.load(`v1:${namespace}:${JSON.stringify(scope)}`, loader, policy),
    cachedMedia: async (namespace, scope, loader, policy) =>
      (await cache.load(`v1:${namespace}:${JSON.stringify(scope)}`, loader, policy)).value,
    onMediaCacheClear() {},
    MEDIA_TTL: { stale: 30 * 24 * 60 * 60_000 },
    metadataCacheTtl() {},
  };
  const browse = moduleWithMocks("src/lib/scoped-data-cache.ts", {
    "./cache-scope": { cacheInstallationSalt: () => "installation" },
    "./media-cache": media,
  });
  return {
    browse,
    media,
    advance: (ms) => (now += ms),
    flush: () => cache.flush(),
    restart: () => (cache = createMediaCache(store, { now: () => now })),
  };
}

test("next-day restart returns scoped stale data without waiting, coalesces refresh and reads its result", async () => {
  const f = fixture();
  const valid = (v) => Array.isArray(v.results);
  const old = { results: [{ id: 1 }] },
    fresh = { results: [{ id: 2 }] };
  await f.browse.cachedBrowsePage(["account-a", "US"], async () => old, valid);
  await f.flush();
  f.advance(24 * 60 * 60_000);
  f.restart();
  let finish,
    calls = 0;
  const loader = () => {
    calls++;
    return new Promise((resolve) => {
      finish = resolve;
    });
  };
  const reads = Promise.all([
    f.browse.cachedBrowsePage(["account-a", "US"], loader, valid),
    f.browse.cachedBrowsePage(["account-a", "US"], loader, valid),
  ]);
  const [a, b] = await Promise.race([
    reads,
    turn().then(() => assert.fail("stale read waited for network")),
  ]);
  assert.deepEqual(a, old);
  assert.deepEqual(b, old);
  assert.equal(calls, 1);
  assert.deepEqual(
    await f.browse.cachedBrowsePage(["account-b", "US"], async () => fresh, valid),
    fresh,
  );
  assert.deepEqual(
    await f.browse.cachedBrowsePage(["account-a", "GB"], async () => fresh, valid),
    fresh,
  );
  finish(fresh);
  await turn();
  assert.deepEqual(await f.browse.cachedBrowsePage(["account-a", "US"], loader, valid), fresh);
  assert.ok(f.browse.browseCacheRevision() > 0, "mounted views are notified of changed stale data");
  assert.equal(calls, 1);
});

test("offline restart returns stale data and backs off repeated warming", async () => {
  const f = fixture();
  const old = { results: [{ id: 1 }] };
  await f.browse.cachedBrowsePage(
    ["x"],
    async () => old,
    () => true,
  );
  await f.flush();
  f.advance(24 * 60 * 60_000);
  f.restart();
  let calls = 0;
  const offline = async () => {
    calls++;
    throw new Error("offline");
  };
  assert.deepEqual(await f.browse.cachedBrowsePage(["x"], offline, () => true), old);
  await turn();
  for (let i = 0; i < 10; i++)
    assert.deepEqual(await f.browse.cachedBrowsePage(["x"], offline, () => true), old);
  assert.equal(calls, 1);
});

test("TMDB first-page reads see a background refresh rather than a stale memory copy", async () => {
  const f = fixture();
  let finish,
    calls = 0;
  const page = (id) => ({ results: [{ id, title: `title ${id}` }] });
  let response = () => Promise.resolve(page(1));
  const tmdb = moduleWithMocks("src/lib/providers/tmdb/tmdb-client.ts", {
    "@/lib/safe-fetch": {
      safeFetch: async () => {
        calls++;
        const value = await response();
        return new Response(JSON.stringify(value));
      },
    },
    "@/lib/request-scheduler": {
      createRequestScheduler: () => ({ schedule: (_key, run) => run(), pauseFor() {} }),
    },
    "./tmdb-catalog-cache": { createCatalogCache, isCatalogPath, projectCatalogPage },
    "@/lib/cache": { lruSet: (map, key, value) => map.set(key, value) },
    "@/lib/media-cache": f.media,
    "@/lib/scoped-data-cache": f.browse,
  });
  assert.deepEqual(await tmdb.get("key", "trending/movie/week"), page(1));
  await f.flush();
  f.advance(24 * 60 * 60_000);
  f.restart();
  tmdb.releaseTmdbCatalogMemory();
  response = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  assert.deepEqual(
    await Promise.race([
      tmdb.get("key", "trending/movie/week"),
      turn().then(() => assert.fail("TMDB stale read waited for network")),
    ]),
    page(1),
  );
  await turn();
  finish(page(2));
  await turn();
  await turn();
  assert.deepEqual(await tmdb.get("key", "trending/movie/week"), page(2));
  assert.equal(calls, 2);
});

test("pausing a warm job does not abort a shared demand request or cause repeat warm requests", async () => {
  const f = fixture();
  let finish,
    calls = 0;
  const page = { results: [{ id: 7 }] };
  const tmdb = moduleWithMocks("src/lib/providers/tmdb/tmdb-client.ts", {
    "@/lib/safe-fetch": {
      safeFetch: async () => {
        calls++;
        return new Promise((resolve) => {
          finish = () => resolve(new Response(JSON.stringify(page)));
        });
      },
    },
    "@/lib/request-scheduler": {
      createRequestScheduler: () => ({ schedule: (_key, run) => run(), pauseFor() {} }),
    },
    "./tmdb-catalog-cache": { createCatalogCache, isCatalogPath, projectCatalogPage },
    "@/lib/cache": { lruSet: (map, key, value) => map.set(key, value) },
    "@/lib/media-cache": f.media,
    "@/lib/scoped-data-cache": f.browse,
  });
  const pending = [];
  const coordinator = createPrefetchCoordinator((run) => {
    pending.push(run);
    return () => {};
  });
  const get = () => tmdb.get("key", "trending/movie/week");
  coordinator.start([get, () => assert.fail("paused job ran")]);
  pending.shift()();
  await turn();
  const demand = get();
  coordinator.pause();
  finish();
  assert.deepEqual(await demand, page);
  await turn();
  for (let i = 0; i < 5; i++) assert.deepEqual(await get(), page);
  assert.equal(calls, 1);
  assert.equal(pending.length, 0);
});
