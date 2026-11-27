import assert from "node:assert/strict";
import test from "node:test";
import { CalendarCache } from "../src/lib/calendar-cache.ts";
import { mapCalendarLimit } from "../src/lib/calendar-scheduler.ts";

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

test("warm results and overlapping requests avoid repeat fetches; failures can retry", async () => {
  const cache = new CalendarCache(3, 10000);
  let calls = 0;
  const wait = deferred();
  const fetcher = () => {
    calls++;
    return wait.promise;
  };
  const one = cache.fetch("one", fetcher);
  const two = cache.fetch("one", fetcher);
  assert.equal(one, two);
  wait.resolve([1]);
  assert.deepEqual(await one, [1]);
  assert.deepEqual(await cache.fetch("one", fetcher), [1]);
  assert.equal(calls, 1);
  await assert.rejects(
    cache.fetch("failed", async () => {
      throw new Error("failed");
    }),
  );
  assert.equal(await cache.fetch("failed", async () => 2), 2);
});

test("clear fences stale writes and stale cleanup cannot remove replacement inflight work", async () => {
  const cache = new CalendarCache(3, 10000);
  const old = deferred(),
    fresh = deferred();
  const first = cache.fetch("same", () => old.promise);
  cache.clear();
  const second = cache.fetch("same", () => fresh.promise);
  old.resolve("old");
  assert.equal(await first, "old");
  assert.equal(cache.peek("same"), undefined);
  assert.equal(
    cache.fetch("same", () => {
      throw new Error("duplicate");
    }),
    second,
  );
  fresh.resolve("fresh");
  await second;
  assert.equal(cache.peek("same"), "fresh");
});

test("results, pending requests, and TTL remain bounded", async () => {
  const cache = new CalendarCache(2, 10000);
  await cache.fetch("a", async () => "a");
  await cache.fetch("b", async () => "b");
  cache.peek("a");
  await cache.fetch("c", async () => "c");
  assert.equal(cache.peek("b"), undefined);
  assert.equal(cache.peek("a"), "a");
  const expired = new CalendarCache(2, -1);
  await expired.fetch("x", async () => 1);
  assert.equal(expired.peek("x"), undefined);
  assert.equal(await expired.fetch("x", async () => 2), 2);
});

test("slot scheduler respects the concurrency bound and input ordering", async () => {
  let active = 0,
    peak = 0;
  const gates = Array.from({ length: 8 }, deferred);
  const work = mapCalendarLimit(gates, 3, async (gate) => {
    peak = Math.max(peak, ++active);
    const result = await gate.promise;
    active--;
    return result;
  });
  assert.equal(active, 3);
  gates.forEach((gate, index) => gate.resolve(index));
  assert.deepEqual(await work, [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(peak, 3);
});

test("evicted pending writes cannot overwrite newer requests for the same key", async () => {
  const cache = new CalendarCache(1, 10000);
  const old = deferred(),
    other = deferred(),
    fresh = deferred();
  const first = cache.fetch("a", () => old.promise);
  const second = cache.fetch("b", () => other.promise);
  const third = cache.fetch("a", () => fresh.promise);
  fresh.resolve("fresh");
  await third;
  old.resolve("old");
  other.resolve("other");
  await Promise.all([first, second]);
  assert.equal(cache.peek("a"), "fresh");
});

test("public source cache keeps stale rows during one background refresh", async () => {
  const cache = new CalendarCache(2, -1, true);
  await cache.fetch("a", async () => "old");
  const fresh = deferred();
  let calls = 0;
  const fetcher = () => {
    calls++;
    return fresh.promise;
  };
  assert.equal(await cache.fetch("a", fetcher), "old");
  assert.equal(await cache.fetch("a", fetcher), "old");
  assert.equal(calls, 1);
  fresh.resolve("new");
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(await cache.fetch("a", async () => "next"), "new");
});

test("refresh notifications are keyed, bounded by cache ownership, and ignore failed results", async () => {
  const cache = new CalendarCache(1, -1, true);
  let updates = 0;
  const unsubscribe = cache.subscribe(() => updates++);
  await cache.fetch("a", async () => ["old"]);
  const old = deferred();
  await cache.fetch(
    "a",
    () => old.promise,
    (rows) => rows.length > 0,
  );
  old.resolve([]);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(updates, 0);
  assert.equal(cache.getRevision("a"), 0);
  const evicted = deferred();
  await cache.fetch("a", () => evicted.promise);
  await cache.fetch("b", async () => ["b"]);
  evicted.resolve(["superseded"]);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(updates, 0);
  const next = deferred();
  await cache.fetch("b", () => next.promise);
  next.resolve(["new"]);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(updates, 1);
  assert.equal(cache.getRevision("a"), 0);
  assert.equal(cache.getRevision("b"), 1);
  unsubscribe();
});
