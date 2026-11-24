import assert from "node:assert/strict";
import test from "node:test";
import { hookHarness } from "./helpers/hook-harness.ts";
import { isLocalUrl } from "../src/lib/player/local-url.ts";
import { isLivePlaybackSrc } from "../src/lib/player/live-src.ts";

function fixture() {
  let at = 0;
  let position = 20;
  let tick;
  const loads = [];
  const diagnostics = [];
  const src = {
    url: "https://sample.invalid/media",
    meta: { id: "sample", type: "movie" },
    headers: { "x-fixture": "one" },
  };
  const bridgeRef = {
    current: {
      load: async (source) => {
        loads.push(source);
      },
    },
  };
  const snap = { status: "playing", durationSec: 1000, firstFrameReady: true };
  const hook = hookHarness(
    "src/views/player/hooks/use-wake-reconnect.ts",
    "useWakeReconnect",
    {
      "@/lib/player/playback-clock": { getPlaybackPosition: () => position },
      "@/lib/player/local-url": { isLocalUrl },
      "@/lib/player/live-src": { isLivePlaybackSrc },
      "@/lib/perf/diagnostics": { recordDiagnostic: (...args) => diagnostics.push(args) },
      "@/lib/player/pause-trace": { tracePlayback() {} },
    },
    {
      window: {
        setInterval: (callback) => {
          tick = callback;
          return 1;
        },
        clearInterval() {},
      },
      Date: { now: () => at },
      console: { warn() {} },
    },
  );
  let args = { bridgeRef, src, snap };
  hook.render(args);
  return {
    loads,
    diagnostics,
    bridgeRef,
    tick(ms, pos = position) {
      at += ms;
      position = pos;
      tick();
    },
    update(patch) {
      args = { ...args, ...patch };
      hook.render(args);
    },
    cleanup: () => hook.unmount(),
  };
}

test("timer throttling must not reload native playback that continued advancing", () => {
  const f = fixture();
  try {
    f.tick(35_000, 55);
    f.tick(2_000, 57);
    assert.equal(f.loads.length, 0);
  } finally {
    f.cleanup();
  }
});

test("a delayed time-pos event after a gap cancels wake recovery", () => {
  const f = fixture();
  try {
    f.tick(35_000, 20);
    assert.equal(f.loads.length, 0, "wait for native state before replacing media");
    f.tick(2_000, 57);
    assert.equal(f.loads.length, 0);
  } finally {
    f.cleanup();
  }
});

test("a genuinely stalled network stream reconnects once at its observed position", () => {
  const f = fixture();
  try {
    f.tick(35_000, 20);
    f.tick(2_000, 20);
    assert.equal(f.loads.length, 1);
    assert.equal(f.loads[0].startAtSec, 20);
    assert.deepEqual(f.loads[0].headers, { "x-fixture": "one" });
    f.tick(2_000, 20);
    assert.equal(f.loads.length, 1);
  } finally {
    f.cleanup();
  }
});

test("a timer gap cannot resume a paused video or replace a loading source", () => {
  for (const status of ["paused", "loading", "ended", "idle", "error"]) {
    const f = fixture();
    try {
      f.update({ snap: { status, durationSec: 1000, firstFrameReady: true } });
      f.tick(35_000, 20);
      f.tick(2_000, 20);
      assert.equal(f.loads.length, 0, status);
    } finally {
      f.cleanup();
    }
  }
});

test("a pending wake recovery belongs to its original bridge and media", () => {
  for (const replacement of ["bridge", "source", "pause"]) {
    const f = fixture();
    try {
      f.tick(35_000, 20);
      if (replacement === "bridge")
        f.bridgeRef.current = { load: async (source) => f.loads.push(source) };
      if (replacement === "source")
        f.update({ src: { url: "https://sample.invalid/next", meta: { id: "next" } } });
      if (replacement === "pause") f.update({ snap: { status: "paused", durationSec: 1000 } });
      f.tick(2_000, 20);
      assert.equal(f.loads.length, 0, replacement);
    } finally {
      f.cleanup();
    }
  }
});
