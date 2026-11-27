import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { JSDOM } from "jsdom";
import * as React from "react";
import * as jsx from "react/jsx-runtime";
import { createRoot } from "react-dom/client";
import * as imgSize from "../src/lib/img-size.ts";
import { createObjectUrlCache } from "../src/lib/object-url-cache.ts";
import { createRequestScheduler } from "../src/lib/request-scheduler.ts";
import { createThumbnailScheduler } from "../src/lib/thumbnail-scheduler.ts";
import * as readiness from "../src/lib/image-readiness.ts";

const POSTER = "https://image.tmdb.org/t/p/w500/title.jpg";
const SMALL = "https://image.tmdb.org/t/p/w300/title.jpg";
const LARGE = "https://image.tmdb.org/t/p/w500/title.jpg";
const COVER = "https://covers.example/title.jpg";
const address = (url, revision = 1) => `asset:${url}#${revision}`;

// Poster with the real image proxy: only the native side, the observers and the pixels are stand-ins.
async function withPosters(run) {
  const dom = new JSDOM("<div id='app'></div>", { url: "http://localhost/" });
  const previous = { window: globalThis.window, document: globalThis.document };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  window.__TAURI_INTERNALS__ = {};
  Object.defineProperties(dom.window.HTMLImageElement.prototype, {
    complete: { get: () => false, configurable: true },
    naturalWidth: { get: () => 0, configurable: true },
  });
  const settings = { posterEffect: "off", posterQuality: "high" };
  const observers = { near: new Set(), size: new Set() };
  const observe = (set) => (callback) => {
    set.add(callback);
    return () => set.delete(callback);
  };
  let answer = (url, width) => address(width ? `${url}@${width}` : url);
  const pool = createObjectUrlCache();
  const mocks = {
    react: React,
    "react/jsx-runtime": jsx,
    "./row": {
      ScrollRootContext: React.createContext(null),
      resolveRowScrollRoot: () => undefined,
    },
    "./object-url-cache": { createObjectUrlCache: () => pool },
    "./request-scheduler": { createRequestScheduler },
    "./thumbnail-scheduler": { createThumbnailScheduler },
    "./image-readiness": readiness,
    "./perf/diagnostics": { measureDiagnostic: () => () => {}, recordDiagnostic() {} },
    "@/lib/image-readiness": readiness,
    "@tauri-apps/api/core": {
      convertFileSrc: (path) => path,
      invoke: async (command, args) => {
        if (command === "clear_thumb_cache") return undefined;
        assert.equal(command, "cached_thumb_path");
        return answer(args.url, args.width);
      },
    },
    "@/lib/manga/sources/suwayomi/auth-registry": { suwayomiAuthFor: () => undefined },
    "@/lib/idb-cache": {
      idbCacheKeys: async () => [],
      idbCacheGet: async () => null,
      idbCacheDelete: async () => {},
    },
    "@/lib/settings": { useSettings: () => ({ settings }) },
    "@/lib/img-size": imgSize,
    "@/lib/visibility": {
      observeWithin: (_el, _margin, callback) => observe(observers.near)(callback),
      observeResize: (_el, callback) => observe(observers.size)(callback),
    },
    "@/lib/render-cause": { noteProbe: () => {}, recordRenderCause: () => {} },
  };
  const load = (file) => {
    const code = ts.transpileModule(
      readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8"),
      {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
          jsx: ts.JsxEmit.ReactJSX,
        },
      },
    ).outputText;
    const exports = {};
    new Function("require", "exports", code)((name) => mocks[name] ?? {}, exports);
    return exports;
  };
  mocks["@/lib/remote-image-proxy"] = load("lib/remote-image-proxy.ts");
  const { Poster } = load("components/poster.tsx");
  const root = createRoot(document.querySelector("#app"));
  const failures = [];
  const card = (props) =>
    React.act(() =>
      root.render(
        React.createElement(Poster, {
          src: POSTER,
          seed: "title",
          lazy: "release",
          onError: () => failures.push("poster failed"),
          ...props,
        }),
      ),
    );
  const image = () => document.querySelector(".harbor-poster-img");
  const poster = {
    // A row tells its width to the cards it shows. Nothing else does.
    inRow: (props) => card({ cardWidth: 150, ...props }),
    inGrid: (props) => card(props),
    alone: (props) => card({ lazy: false, ...props }),
    clearCache: () => React.act(() => mocks["@/lib/remote-image-proxy"].clearThumbCache()),
    leave: () => React.act(() => root.render(null)),
    measure: (width) =>
      React.act(() => observers.size.forEach((cb) => cb({ width, height: width * 1.5 }))),
    comeNear: () => React.act(() => observers.near.forEach((cb) => cb({ isIntersecting: true }))),
    dispatch: (type) => React.act(() => image().dispatchEvent(new dom.window.Event(type))),
    src: () => image()?.getAttribute("src"),
    revealed: () => document.querySelector(".harbor-poster").hasAttribute("data-loaded"),
    native: (next) => (answer = next),
    quality: (next) => (settings.posterQuality = next),
    failures,
  };
  try {
    await run(poster);
  } finally {
    await React.act(() => root.unmount());
    pool.clear();
    dom.window.close();
    Object.assign(globalThis, previous);
  }
}

async function showInRow(poster) {
  await poster.inRow();
  await poster.measure(150);
  await poster.dispatch("load");
}
async function showInGrid(poster) {
  await poster.inGrid();
  await poster.measure(150);
  await poster.comeNear();
  await poster.dispatch("load");
}
const silent = () => new Promise(() => {});

test("a card that knows its width from its row loads its poster without an observer", async () => {
  await withPosters(async (poster) => {
    await poster.inRow();
    assert.equal(poster.src(), address(SMALL));
    assert.equal(poster.revealed(), false);
    await poster.measure(150);
    assert.equal(poster.src(), address(SMALL), "the measured size asks for the same picture");
  });
});

test("a card without that width waits for its size and for the observer", async () => {
  await withPosters(async (poster) => {
    await poster.inGrid();
    await poster.measure(150);
    assert.equal(poster.src(), undefined);
    await poster.comeNear();
    assert.equal(poster.src(), address(SMALL));
  });
});

test("a poster that was shown before needs no native answer when its card is built again", async () => {
  await withPosters(async (poster) => {
    await showInRow(poster);
    assert.ok(poster.revealed());
    await poster.leave();
    poster.native(silent);
    await poster.inRow();
    assert.equal(poster.src(), address(SMALL));
    assert.ok(poster.revealed());
  });
});

test("a poster that was not shown before waits for the native answer", async () => {
  await withPosters(async (poster) => {
    await showInRow(poster);
    await poster.leave();
    poster.native(silent);
    await poster.inRow({ src: "https://image.tmdb.org/t/p/w500/other.jpg", seed: "other" });
    assert.equal(poster.src(), undefined);
  });
});

test("outside a row the observer still decides when a poster that was shown before loads", async () => {
  await withPosters(async (poster) => {
    await showInGrid(poster);
    await poster.leave();
    poster.native(silent);
    await poster.inGrid();
    await poster.measure(150);
    assert.equal(poster.src(), undefined);
    await poster.comeNear();
    assert.equal(poster.src(), address(SMALL));
    assert.ok(poster.revealed());
  });
});

test("the native answer replaces a remembered address", async () => {
  await withPosters(async (poster) => {
    await showInRow(poster);
    await poster.leave();
    poster.native((url) => address(url, 2));
    await poster.inRow();
    assert.equal(poster.src(), address(SMALL, 2));
  });
});

test("a remembered address that no longer loads waits for the native answer and does not fail the poster", async () => {
  await withPosters(async (poster) => {
    await showInRow(poster);
    await poster.leave();
    let resolve;
    poster.native(() => new Promise((done) => (resolve = done)));
    await poster.inRow();
    assert.equal(poster.src(), address(SMALL));
    await poster.dispatch("error");
    assert.equal(poster.src(), undefined);
    assert.equal(poster.revealed(), false);
    await React.act(async () => resolve(address(SMALL, 2)));
    assert.equal(poster.src(), address(SMALL, 2));
    assert.deepEqual(poster.failures, []);
  });
});

test("another poster quality does not use the picture of the old one", async () => {
  await withPosters(async (poster) => {
    await showInRow(poster);
    await poster.leave();
    poster.quality("balanced");
    poster.native(silent);
    await poster.inRow();
    assert.equal(poster.src(), undefined);
  });
});

test("a poster whose address arrives after its card was built starts from what was shown before", async () => {
  await withPosters(async (poster) => {
    await showInRow(poster);
    await poster.leave();
    poster.native(silent);
    // A localized poster is looked up by the card, so its first render has no address yet.
    await poster.inRow({ src: undefined });
    assert.equal(poster.src(), undefined);
    await poster.inRow();
    assert.equal(poster.src(), address(SMALL));
    assert.ok(poster.revealed());
  });
});

test("the size a poster was shown in does not decide its size in another place", async () => {
  await withPosters(async (poster) => {
    await poster.alone({ src: COVER });
    await poster.measure(44);
    await poster.dispatch("load");
    assert.ok(poster.revealed());
    const small = poster.src();
    await poster.leave();
    poster.native(silent);
    await poster.alone({ src: COVER });
    assert.equal(poster.src(), undefined, "its size here is not measured yet");
    await poster.measure(450);
    assert.equal(poster.src(), undefined);
    assert.equal(poster.revealed(), false, "the placeholder stays until this size is there");
    await poster.leave();
    await poster.alone({ src: COVER });
    await poster.measure(44);
    assert.equal(poster.src(), small);
  });
});

test("a large picture shown somewhere else does not make the cards of a row ask for it", async () => {
  await withPosters(async (poster) => {
    await poster.alone({ src: undefined, fallbacks: [POSTER] });
    await poster.measure(300);
    await poster.dispatch("load");
    assert.equal(poster.src(), address(LARGE));
    await poster.leave();
    await poster.inRow({ src: undefined });
    await poster.inRow();
    assert.equal(poster.src(), address(SMALL));
  });
});

test("clearing the image cache forgets the addresses too", async () => {
  await withPosters(async (poster) => {
    await showInRow(poster);
    await poster.leave();
    await poster.clearCache();
    poster.native(silent);
    await poster.inRow();
    assert.equal(poster.src(), undefined);
    assert.equal(poster.revealed(), false);
  });
});

test("the poster card hands the width its row tells it to its poster", () => {
  const card = readFileSync(new URL("../src/components/pick-card.tsx", import.meta.url), "utf8");
  assert.match(card, /const rowCardWidth = useContext\(RowCardWidthContext\);/);
  assert.match(card, /lazy="release"\s+cardWidth=\{rowCardWidth \?\? undefined\}/);
});
