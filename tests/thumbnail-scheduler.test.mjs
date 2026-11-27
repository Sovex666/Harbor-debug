import test from "node:test";
import assert from "node:assert/strict";
import { createThumbnailScheduler } from "../src/lib/thumbnail-scheduler.ts";

const tick = () => new Promise((resolve) => setImmediate(resolve));
test("visible work overtakes speculation and shared consumers retain a single job", async () => {
  const scheduler = createThumbnailScheduler({ active: 1, speculative: 1, queued: 4 });
  const started = [];
  let finish;
  const first = scheduler.acquire(
    "first",
    "visible",
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const idle = scheduler.acquire("idle", "speculative", async () => {
    started.push("idle");
    return 2;
  });
  const visible = scheduler.acquire("visible", "visible", async () => {
    started.push("visible");
    return 3;
  });
  const shared = scheduler.acquire("visible", "near", async () => {
    throw new Error("duplicate");
  });
  visible.release();
  await tick();
  finish(1);
  assert.equal(await first.promise, 1);
  assert.equal(await shared.promise, 3);
  assert.equal(await idle.promise, 2);
  assert.deepEqual(started, ["visible", "idle"]);
  await tick();
  assert.equal(scheduler.stats().active, 0);
});

test("last consumer cancels queued and active work; queues remain bounded", async () => {
  const scheduler = createThumbnailScheduler({ active: 1, speculative: 1, queued: 1 });
  let aborted = false;
  const first = scheduler.acquire(
    "first",
    "visible",
    (signal) =>
      new Promise((resolve) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          resolve(null);
        });
      }),
  );
  await tick();
  const waiting = scheduler.acquire("waiting", "speculative", async () => 2);
  const rejected = scheduler.acquire("overflow", "speculative", async () => 3);
  await assert.rejects(rejected.promise, /queue full/);
  waiting.release();
  await assert.rejects(waiting.promise, /released/);
  first.release();
  await first.promise;
  await tick();
  assert.equal(aborted, true);
  assert.deepEqual(scheduler.stats(), { active: 0, speculative: 0, queued: 0, dropped: 1 });
});

test("visible demand displaces near work and an old release cannot erase its replacement", async () => {
  const scheduler = createThumbnailScheduler({ active: 1, speculative: 1, queued: 1 });
  let finish;
  const active = scheduler.acquire(
    "active",
    "visible",
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await tick();
  const old = scheduler.acquire("same", "near", async () => 1);
  const rejected = assert.rejects(old.promise, /released/);
  const visible = scheduler.acquire("visible", "visible", async () => 2);
  await rejected;
  visible.release();
  await assert.rejects(visible.promise, /released/);
  const replacement = scheduler.acquire("same", "visible", async () => 3);
  old.release();
  finish(0);
  assert.equal(await replacement.promise, 3);
  await active.promise;
});

test("held jobs wait without blocking other work and start on pump", async () => {
  const scheduler = createThumbnailScheduler({ active: 2, speculative: 1, queued: 1 });
  let parked = true;
  const started = [];
  const held = scheduler.acquire(
    "parked",
    "visible",
    async () => {
      started.push("parked");
      return 1;
    },
    () => parked,
  );
  // A held visible job neither fills the queue nor keeps background work from starting.
  const background = scheduler.acquire("background", "background", async () => {
    started.push("background");
    return 2;
  });
  assert.equal(await background.promise, 2);
  assert.deepEqual(started, ["background"]);
  assert.equal(scheduler.stats().queued, 0);
  await tick();
  scheduler.pump();
  assert.deepEqual(started, ["background"], "a held job never starts, even on a pump");
  parked = false;
  scheduler.pump();
  assert.equal(await held.promise, 1);
  assert.deepEqual(started, ["background", "parked"]);
});

test("shared lease promotion follows current owners", async () => {
  const scheduler = createThumbnailScheduler({ active: 1, speculative: 1, queued: 4 });
  let finish;
  const started = [];
  const active = scheduler.acquire(
    "active",
    "visible",
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await tick();
  const near = scheduler.acquire("shared", "near", async () => {
    started.push("shared");
    return 1;
  });
  const visible = scheduler.acquire("shared", "visible", async () => 0);
  const other = scheduler.acquire("other", "visible", async () => {
    started.push("other");
    return 2;
  });
  visible.release();
  finish(0);
  await Promise.all([active.promise, near.promise, other.promise]);
  assert.deepEqual(started, ["other", "shared"]);
});
