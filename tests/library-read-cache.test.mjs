import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { createMediaCache, mediaCacheKey } from "../src/lib/media-cache.ts";

function fixture() {
  const records = new Map();
  let now = 1000;
  let metadata = [["tt1", "1"]];
  let metaCalls = 0;
  let bodyCalls = 0;
  let metadataGate;
  const store = {
    async get(key) {
      return structuredClone(records.get(key) ?? null);
    },
    async put(record) {
      records.set(record.key, structuredClone(record));
      return true;
    },
    async list() {
      return [...records.values()].map(({ value: _value, ...index }) => index);
    },
    async remove(keys) {
      for (const key of keys) records.delete(key);
    },
    async clear() {
      records.clear();
      return true;
    },
  };
  function reopen() {
    const cache = createMediaCache(store, { now: () => now });
    const media = {
      mediaCacheKey,
      async loadMedia(namespace, scope, loader, policy) {
        return cache.load(await mediaCacheKey(namespace, scope), loader, policy);
      },
      async readMediaValue(namespace, scope) {
        return cache.readValue(await mediaCacheKey(namespace, scope));
      },
      removeMediaNamespaces(prefix) {
        return cache.removePrefix(`v1:${prefix}`);
      },
      releasePersonalCacheMemory() {
        cache.releaseMemory("v1:library-read-");
      },
    };
    const mocks = {
      "./cache-scope": { cacheInstallationSalt: () => "salt" },
      "./media-cache": media,
      "./stremio": {
        async libraryProjectionMetadata() {
          metaCalls++;
          if (metadataGate) await metadataGate;
          return metadata;
        },
        async libraryProjectionItems() {
          bodyCalls++;
          return [
            {
              _id: "tt1",
              type: "movie",
              name: "One",
              removed: false,
              temp: false,
              _ctime: "",
              _mtime: "",
            },
          ];
        },
      },
    };
    const code = ts.transpileModule(readFileSync("src/lib/library-read-cache.ts", "utf8"), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
    const api = {};
    new Function("require", "exports", code)((id) => mocks[id], api);
    return { api, cache };
  }
  return {
    reopen,
    records,
    advance: (ms) => {
      now += ms;
    },
    change: () => {
      metadata = [["tt1", "2"]];
    },
    counts: () => [metaCalls, bodyCalls],
    gate: (promise) => {
      metadataGate = promise;
    },
  };
}

test("restart reuses a resolved snapshot; stale signature validation skips unchanged bodies", async () => {
  const f = fixture();
  const identity = { authKey: "secret", userId: "user", profileId: "profile" };
  const one = f.reopen();
  assert.equal((await one.api.readLibraryProjection(identity)).value.length, 1);
  await one.cache.flush();
  const two = f.reopen();
  assert.equal((await two.api.readLibraryProjection(identity)).value.length, 1);
  assert.deepEqual(f.counts(), [1, 1]);
  f.advance(61_000);
  const stale = await two.api.readLibraryProjection(identity);
  assert.equal(stale.value.length, 1);
  await stale.refresh;
  await two.cache.flush();
  assert.deepEqual(f.counts(), [2, 1]);
  f.change();
  f.advance(61_000);
  const changed = await two.api.readLibraryProjection(identity);
  await changed.refresh;
  assert.deepEqual(f.counts(), [3, 2]);
  await two.api.invalidateLibraryProjections();
  assert.equal(f.records.size, 0);
});

test("mutations fence only their account, including overlapping mutations and late reads", async () => {
  const f = fixture();
  const { api, cache } = f.reopen();
  const a = { authKey: "a", userId: "a", profileId: "profile" };
  const b = { authKey: "b", userId: "b", profileId: "profile" };
  await api.readLibraryProjection(a);
  await api.readLibraryProjection(b);
  await cache.flush();
  let release;
  f.gate(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  const pending = api.readLibraryProjection(a, true);
  await new Promise((resolve) => setImmediate(resolve));
  const endOne = api.beginLibraryProjectionMutation("a");
  const endTwo = api.beginLibraryProjectionMutation("a");
  endOne();
  assert.equal((await api.readLibraryProjection(a)).value, null);
  assert.equal((await api.readLibraryProjection(b)).value.length, 1);
  endTwo();
  release();
  assert.equal((await pending).value, null);
  await api.invalidateLibraryProjections("a");
  await cache.flush();
  assert.equal(f.records.size, 1);
});

test("unresolved accounts never persist and resolved identities do not share snapshots", async () => {
  const f = fixture();
  const { api, cache } = f.reopen();
  await api.readLibraryProjection({ authKey: "secret", userId: null, profileId: "profile" });
  await cache.flush();
  assert.equal(f.records.size, 0);
  await api.readLibraryProjection({ authKey: "secret", userId: "user", profileId: "a" });
  await api.readLibraryProjection({ authKey: "secret", userId: "user", profileId: "b" });
  await cache.flush();
  assert.equal(f.records.size, 2);
  for (const key of f.records.keys()) assert.ok(!key.includes("secret") && !key.includes("user"));
});
