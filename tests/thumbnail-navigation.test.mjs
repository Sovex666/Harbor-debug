import assert from "node:assert/strict";
import test from "node:test";
import { createThumbnailScheduler } from "../src/lib/thumbnail-scheduler.ts";
import { readFileSync } from "node:fs";
import ts from "typescript";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { createObjectUrlCache } from "../src/lib/object-url-cache.ts";

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("rapid category navigation cancels obsolete queued work but preserves shared visible demand", async () => {
  const scheduler = createThumbnailScheduler({ active: 1, speculative: 1, queued: 4 });
  let releaseActive;
  const active = scheduler.acquire(
    "active",
    "visible",
    () =>
      new Promise((resolve) => {
        releaseActive = resolve;
      }),
  );
  await tick();
  const hidden = scheduler.acquire("hidden-only", "near", async () => "hidden");
  const hiddenRejected = assert.rejects(hidden.promise, /released/);
  const sharedHidden = scheduler.acquire("shared", "near", async () => "shared");
  const sharedVisible = scheduler.acquire("shared", "visible", async () => "duplicate");
  hidden.release();
  sharedHidden.setPriority("speculative");
  assert.equal(scheduler.stats().queued, 1);
  releaseActive("active");
  assert.equal(await active.promise, "active");
  assert.equal(await sharedVisible.promise, "shared");
  await hiddenRejected;
  sharedVisible.release();
  sharedHidden.release();
  await tick();
  assert.equal(scheduler.stats().active, 0);
});

test("a parked App layer holds new image work without re-rendering and resumes it", async () => {
  const dom = new JSDOM("<div id='app'></div>", { url: "http://localhost/" });
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    MutationObserver: globalThis.MutationObserver,
    act: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.MutationObserver = dom.window.MutationObserver;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  window.__TAURI_INTERNALS__ = {};
  const pool = createObjectUrlCache();
  const scheduler = createThumbnailScheduler({ active: 1, speculative: 1, queued: 4 });
  const calls = [];
  const pending = [];
  const compile = (path, dependencies) => {
    const out = {};
    const code = ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    new Function("require", "exports", code)((name) => dependencies[name], out);
    return out;
  };
  const readiness = compile("../src/lib/image-readiness.ts", {});
  const proxy = compile("../src/lib/remote-image-proxy.ts", {
    react: React,
    "./image-readiness": readiness,
    "./object-url-cache": { createObjectUrlCache: () => pool },
    "./thumbnail-scheduler": { createThumbnailScheduler: () => scheduler },
    "./perf/diagnostics": { measureDiagnostic: () => () => {}, recordDiagnostic: () => {} },
    "@tauri-apps/api/core": {
      invoke: (command) => {
        calls.push(command);
        if (command === "harbor_image_cancel") return Promise.resolve();
        return new Promise((resolve) => pending.push(resolve));
      },
    },
    "@/lib/manga/sources/suwayomi/auth-registry": { suwayomiAuthFor: () => undefined },
    "@/lib/settings": { useSettings: () => ({ settings: { posterQuality: "max" } }) },
    "@/lib/idb-cache": {},
  });
  const fetches = () => calls.filter((v) => v === "harbor_image_fetch").length;
  let renders = 0;
  function Image({ url }) {
    renders++;
    const ref = React.useRef(null);
    proxy.useProxiedImageSrc(url, { forceProxy: true, layerRef: ref });
    return React.createElement("div", { ref });
  }
  const view = (urls) =>
    React.createElement(
      "div",
      { className: "harbor-layer-active" },
      urls.map((url) => React.createElement(Image, { key: url, url })),
    );
  const root = createRoot(document.querySelector("#app"));
  try {
    await React.act(async () => root.render(view(["https://example.com/a"])));
    assert.equal(fetches(), 1);
    const layer = document.querySelector(".harbor-layer-active");
    const rendersBeforePark = renders;
    await React.act(async () => {
      layer.className = "hidden";
      layer.setAttribute("data-layer-inactive", "");
      await tick();
    });
    assert.equal(renders, rendersBeforePark, "parking re-renders no image");
    assert.equal(calls.filter((v) => v === "harbor_image_cancel").length, 0);
    // A card that mounts while its layer is parked queues but does not start.
    await React.act(async () =>
      root.render(view(["https://example.com/a", "https://example.com/b"])),
    );
    await React.act(async () => {
      pending.shift()({ ok: false, status: 404 });
      await tick();
    });
    assert.equal(fetches(), 1, "parked work never takes the freed slot");
    const rendersBeforeResume = renders;
    await React.act(async () => {
      layer.className = "harbor-layer-active";
      layer.removeAttribute("data-layer-inactive");
      await tick();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await tick();
    });
    assert.equal(fetches(), 2, "un-parking resumes queued work without a render");
    assert.equal(renders, rendersBeforeResume, "un-parking re-renders no image");
    await React.act(async () => {
      pending.shift()({ ok: false, status: 404 });
      await tick();
    });
  } finally {
    await React.act(() => root.unmount());
    pool.clear();
    dom.window.close();
    globalThis.window = previous.window;
    globalThis.document = previous.document;
    globalThis.MutationObserver = previous.MutationObserver;
    globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act;
  }
});

test("a hidden owner releasing a shared lease does not cancel the visible owner", async () => {
  const scheduler = createThumbnailScheduler({ active: 1, speculative: 1, queued: 2 });
  let finish;
  const blocker = scheduler.acquire(
    "blocker",
    "visible",
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await tick();
  let runs = 0;
  const hidden = scheduler.acquire("poster", "near", async () => {
    runs++;
    return 7;
  });
  const visible = scheduler.acquire("poster", "visible", async () => {
    runs++;
    return 8;
  });
  hidden.release();
  finish(0);
  assert.equal(await visible.promise, 7);
  assert.equal(runs, 1);
  visible.release();
  await blocker.promise;
});
