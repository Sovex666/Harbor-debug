import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

test("next-day Home hero returns saved data while refreshing and publishes fresh data", async () => {
  const old = [{ id: "old", background: "old.jpg" }];
  const fresh = [{ id: "new", background: "new.jpg" }];
  const stored = new Map([
    [
      "harbor.heroPool.v1",
      JSON.stringify({
        at: Date.now() - 24 * 60 * 60_000,
        sources: { now: old },
      }),
    ],
  ]);
  let complete;
  let calls = 0;
  const mocks = {
    "@/lib/safe-fetch": {
      safeFetch: () => {
        calls++;
        return new Promise((resolve) => {
          complete = resolve;
        });
      },
    },
    "@/lib/config/endpoints": { HARBOR_API_BASE: "https://fixture.invalid" },
  };
  const api = {};
  const code = ts.transpileModule(readFileSync("src/lib/feed/hero-pool.ts", "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function("require", "exports", "localStorage", code)((id) => mocks[id], api, {
    getItem: (key) => stored.get(key),
    setItem: (key, value) => stored.set(key, value),
  });
  const published = new Promise((resolve) => api.subscribeHeroFeed(resolve));
  assert.deepEqual(await api.fetchHeroFeed("trending"), old);
  assert.equal(calls, 1);
  assert.deepEqual(await api.fetchHeroFeed("trending"), old);
  assert.equal(calls, 1, "the visible consumer shares speculative refresh");
  complete(new Response(JSON.stringify({ sources: { now: fresh } })));
  await published;
  assert.deepEqual(await api.fetchHeroFeed("trending"), fresh);
  assert.equal(calls, 1);
});
