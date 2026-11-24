import test from "node:test";
import assert from "node:assert/strict";
import { createPrefetchCoordinator } from "../src/lib/prefetch/coordinator.ts";

const turn = () => new Promise((resolve) => setImmediate(resolve));

function fixture() {
  const idle = [];
  const deadlines = [];
  const schedule = (list) => (run) => {
    const item = { run, cancelled: false };
    list.push(item);
    return () => {
      item.cancelled = true;
    };
  };
  const runNext = (list) => {
    const item = list.find((entry) => !entry.cancelled);
    assert.ok(item, "expected scheduled callback");
    item.cancelled = true;
    item.run();
  };
  return {
    idle,
    deadlines,
    coordinator: createPrefetchCoordinator(schedule(idle), schedule(deadlines)),
    runIdle: () => runNext(idle),
    expire: () => runNext(deadlines),
    pendingIdle: () => idle.filter((item) => !item.cancelled).length,
  };
}

test("noncooperative jobs stay bounded across navigation and saturated work is dropped", async () => {
  const f = fixture();
  const finish = [];
  const calls = [];
  const stuck = (label) => () => {
    calls.push(label);
    return new Promise((resolve) => finish.push(resolve));
  };
  f.coordinator.start([stuck("old"), stuck("discard")]);
  f.runIdle();
  await turn();
  for (let i = 0; i < 100; i++) {
    f.coordinator.pause();
    f.coordinator.start([stuck("replacement")]);
  }
  assert.deepEqual(calls, ["old"]);
  assert.equal(f.pendingIdle(), 0);
  f.expire();
  f.runIdle();
  await turn();
  assert.deepEqual(calls, ["old", "replacement"]);
  for (let i = 0; i < 100; i++) {
    f.coordinator.pause();
    f.coordinator.start([stuck("overflow")]);
  }
  f.expire();
  assert.equal(f.pendingIdle(), 0);
  assert.deepEqual(calls, ["old", "replacement"]);

  finish[0]();
  await turn();
  f.coordinator.start([stuck("retry")]);
  f.runIdle();
  await turn();
  assert.deepEqual(calls, ["old", "replacement", "retry"]);
  finish[1]();
  finish[2]();
  await turn();
});

test("a detached job's settlement cannot unlock its replacement", async () => {
  const f = fixture();
  const finish = [];
  const calls = [];
  const job = (name) => () => {
    calls.push(name);
    return new Promise((resolve) => finish.push(resolve));
  };
  f.coordinator.start([job("old")]);
  f.runIdle();
  await turn();
  f.coordinator.start([job("new"), job("next")]);
  f.expire();
  f.runIdle();
  await turn();
  finish[0]();
  await turn();
  assert.equal(f.pendingIdle(), 0);
  assert.deepEqual(calls, ["old", "new"]);
  finish[1]();
  await turn();
  f.runIdle();
  await turn();
  assert.deepEqual(calls, ["old", "new", "next"]);
  finish[2]();
  await turn();
});

test("abort-aware work releases immediately, including start without pause", async () => {
  const f = fixture();
  const calls = [];
  f.coordinator.start([
    (signal) =>
      new Promise((resolve) => {
        calls.push("old");
        signal.addEventListener("abort", resolve, { once: true });
      }),
    async () => calls.push("discard"),
  ]);
  f.runIdle();
  await turn();
  f.coordinator.start([async () => calls.push("new")]);
  await turn();
  f.runIdle();
  await turn();
  assert.deepEqual(calls, ["old", "new"]);
});

test("pause and restart resume as soon as abort-aware work settles", async () => {
  const f = fixture();
  const calls = [];
  f.coordinator.start([
    (signal) =>
      new Promise((resolve) => {
        calls.push("old");
        signal.addEventListener("abort", resolve, { once: true });
      }),
  ]);
  f.runIdle();
  await turn();
  f.coordinator.pause();
  f.coordinator.start([async () => calls.push("new")]);
  await turn();
  assert.equal(f.pendingIdle(), 1);
  f.runIdle();
  await turn();
  assert.deepEqual(calls, ["old", "new"]);
});

test("pause before invocation cancels old work and a stale idle callback cannot steal admission", async () => {
  const f = fixture();
  const calls = [];
  f.coordinator.start([async () => calls.push("stale")]);
  const stale = f.idle[0];
  f.coordinator.pause();
  f.coordinator.start([async () => calls.push("current")]);
  stale.run();
  assert.equal(f.pendingIdle(), 1);
  f.runIdle();
  f.coordinator.pause();
  f.coordinator.start([async () => calls.push("latest")]);
  await turn();
  f.runIdle();
  await turn();
  assert.deepEqual(calls, ["latest"]);
});
