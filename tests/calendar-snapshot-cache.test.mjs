import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { createMediaCache, mediaCacheKey } from "../src/lib/media-cache.ts";

function fixture() {
  let now = 1_000_000;
  const records = new Map();
  const store = {
    async get(key) {
      return structuredClone(records.get(key) ?? null);
    },
    async put(record) {
      records.set(record.key, structuredClone(record));
      return true;
    },
    async list() {
      return [...records.values()].map(({ value: _value, ...rest }) => rest);
    },
    async remove(keys) {
      keys.forEach((key) => records.delete(key));
    },
    async clear() {
      records.clear();
      return true;
    },
  };
  let invalidate;
  const start = () => {
    const cache = createMediaCache(store, { now: () => now });
    const mocks = {
      "./cache-scope": { cacheInstallationSalt: () => "private-salt" },
      "./calendar-cache-scope": {
        registerCalendarCache: (fn) => {
          invalidate = fn;
        },
      },
      "./media-cache": {
        mediaCacheGeneration: cache.generation,
        readMediaValue: async (ns, scope) => cache.readValue(await mediaCacheKey(ns, scope)),
        saveMedia: async (ns, scope, value, policy, at, generation) =>
          generation === cache.generation() &&
          cache.save(await mediaCacheKey(ns, scope), value, policy, at),
        removeMediaNamespaces: (prefix) => cache.removePrefix(`v1:${prefix}`),
      },
    };
    const code = ts.transpileModule(readFileSync("src/lib/calendar-snapshot-cache.ts", "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const exports = {};
    new Function("require", "exports", code)((name) => mocks[name], exports);
    return exports.calendarSnapshot;
  };
  return {
    start,
    records,
    nextDay: () => {
      now += 24 * 60 * 60_000;
    },
    invalidate: (purge = true) => invalidate(purge),
  };
}

const row = (id) => ({ id, name: id });

test("startup session notifications fence old writes while retaining next-day snapshots", async () => {
  const f = fixture();
  const make = f.start();
  const scope = ["account", "profile", "month"];
  const old = make(scope, () => true);
  await old.save([row("saved")], true);
  f.nextDay();
  f.invalidate(false);
  await old.save([row("obsolete")], true);
  assert.deepEqual(await make(scope, () => true).read(), { complete: true, items: [row("saved")] });
  assert.deepEqual(
    await f
      .start()(scope, () => true)
      .read(),
    { complete: true, items: [row("saved")] },
  );
});

test("complete snapshots survive a next-day process restart and isolate identity and inputs", async () => {
  const f = fixture();
  const scope = ["account-secret", "profile", "provider", "en", "US", { filter: 1 }, 2026, 9];
  await f
    .start()(scope, () => true)
    .save([row("yesterday")], true);
  assert.equal(f.records.size, 1);
  assert.ok([...f.records.keys()].every((key) => !key.includes("account-secret")));
  f.nextDay();
  const restart = f.start();
  assert.deepEqual(await restart(scope, () => true).read(), {
    complete: true,
    items: [row("yesterday")],
  });
  for (let i = 0; i < scope.length; i++) {
    const changed = [...scope];
    changed[i] = `changed-${i}`;
    assert.equal(await restart(changed, () => true).read(), null);
  }
});

test("partial snapshots remain partial, cannot replace complete rows, and are fenced on invalidation or abort", async () => {
  const f = fixture();
  const make = f.start();
  const scope = ["account", "month"];
  const partial = make(scope, () => true);
  await partial.save([row("partial")], false);
  assert.deepEqual(await make(scope, () => true).read(), {
    complete: false,
    items: [row("partial")],
  });
  await partial.save([row("complete")], true);
  await partial.save([row("late")], false);
  assert.deepEqual(await make(scope, () => true).read(), {
    complete: true,
    items: [row("complete")],
  });
  let current = true;
  const aborted = make(["aborted"], () => current);
  current = false;
  await aborted.save([row("bad")], true);
  assert.equal(await make(["aborted"], () => true).read(), null);
  const old = make(scope, () => true);
  f.invalidate();
  await old.save([row("stale")], true);
  assert.equal(await make(scope, () => true).read(), null);
  assert.equal(
    await f
      .start()(scope, () => true)
      .read(),
    null,
  );
});
