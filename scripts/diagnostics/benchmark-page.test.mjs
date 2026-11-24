import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import {
  activateView,
  configuredControls,
  coverageStep,
  pageState,
  preparePage,
} from "./benchmark-page.mjs";

function fixture(t, html) {
  const dom = new JSDOM(html);
  const previous = new Map();
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    innerWidth: 1600,
    innerHeight: 1000,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({
    width: 100,
    height: 100,
    top: 0,
    bottom: 100,
    left: 0,
    right: 100,
  });
  dom.window.HTMLElement.prototype.getClientRects = () => [{}];
  dom.window.__HARBOR_DEBUG__ = {
    clear: () => {},
    snapshot: () => ({ activeView: "calendar", events: [] }),
  };
  dom.window.__harborBench = {
    images: new WeakMap(),
    nextImage: 0,
    longTasks: [],
    gaps: [],
    errors: 0,
    rejections: 0,
  };
  t.after(() => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    dom.window.close();
  });
  return dom.window.document;
}

test("attributes only the active layer and counts a poster waiting for its source", (t) => {
  fixture(
    t,
    '<div data-layer-inactive><div class="harbor-layer-active"><img src="https://secret.invalid/credential"></div></div><div class="harbor-layer-active"><main data-calendar-complete="false" data-calendar-loading="true" data-calendar-items="3"><div data-poster-state="pending">Poster</div></main></div>',
  );
  const state = pageState();
  assert.equal(state.images.length, 0);
  assert.equal(state.pendingPosters, 1);
  assert.equal(state.calendar.complete, false);
  assert.equal(state.calendar.items, 3);
  assert.equal(JSON.stringify(state).includes("credential"), false);
});

test("clicks a dock button inside its nav wrapper and maps Collections to its control", (t) => {
  const doc = fixture(
    t,
    '<span data-harbor-nav="calendar"><button>Calendar</button></span><span data-harbor-nav="collections"><button>Collections</button></span>',
  );
  let clicked = 0;
  doc.querySelectorAll("button").forEach((el) => el.addEventListener("click", () => clicked++));
  assert.equal(typeof activateView("calendar"), "number");
  assert.equal(typeof activateView("collections-hub"), "number");
  assert.equal(clicked, 2);
  assert.equal(activateView("missing"), null);
  doc.querySelector("button").disabled = true;
  assert.equal(activateView("calendar"), null);
  assert.equal(clicked, 2);
});

test("inventories configured controls without treating missing buttons as disabled", (t) => {
  fixture(
    t,
    '<span data-harbor-nav="calendar"><button>Calendar</button></span><span data-harbor-nav="broken"></span><button data-harbor-nav="disabled" disabled>Disabled</button>',
  );
  assert.deepEqual(configuredControls(), [
    { id: "calendar", control: true, disabled: false },
    { id: "broken", control: false, disabled: false },
    { id: "disabled", control: true, disabled: true },
  ]);
});

test("does not count an exhausted poster as pending or hide visible skeletons", (t) => {
  fixture(
    t,
    '<div class="harbor-layer-active"><main><div data-poster-state="unavailable">No artwork</div><span class="harbor-skel">Loading</span></main></div>',
  );
  const state = pageState();
  assert.equal(state.pendingPosters, 0);
  assert.equal(state.unavailablePosters, 1);
  assert.equal(state.busy, true);
});

test("loaded current-view images report readiness without sources or alt text", (t) => {
  const doc = fixture(
    t,
    '<div class="harbor-layer-active"><main><img src="https://secret.invalid/token" alt="private title"></main></div>',
  );
  const img = doc.querySelector("img");
  Object.defineProperties(img, {
    complete: { value: true },
    naturalWidth: { value: 100 },
    currentSrc: { value: img.src },
  });
  const state = pageState();
  assert.deepEqual(state.images, [{ id: 1, loaded: true, failed: false, pending: false }]);
  assert.equal(JSON.stringify(state).includes("secret.invalid"), false);
  assert.equal(JSON.stringify(state).includes("private title"), false);
});

test("restores a reloaded fixture shell before navigation", async (t) => {
  const doc = fixture(
    t,
    '<div id="root" data-startup-hidden><button data-harbor-nav="home">Home</button></div><div id="harbor-boot"></div>',
  );
  window.__HARBOR_BROWSER_PROFILE__ = { libraryItems: 304 };
  doc.getElementById("root").inert = true;
  assert.equal(await preparePage(), true);
  assert.equal(doc.getElementById("root").hasAttribute("data-startup-hidden"), false);
  assert.equal(doc.getElementById("root").inert, false);
  assert.equal(doc.getElementById("harbor-boot"), null);
});

test("derives Calendar thumbnail expectations from rendered day cells", (t) => {
  fixture(
    t,
    '<div class="harbor-layer-active"><main data-calendar-complete="true" data-calendar-loading="false" data-calendar-items="9">' +
      '<div data-calendar-day="month" data-calendar-day-items="3" data-calendar-day-shown="2"><div data-poster-state="pending" data-loaded="1"></div><div data-poster-state="unavailable"></div></div>' +
      '<div data-calendar-day="adjacent" data-calendar-day-items="1" data-calendar-day-shown="1"><div data-poster-state="pending"></div></div>' +
      "</main></div>",
  );
  const { calendar } = pageState("calendar");
  assert.deepEqual(
    {
      monthItems: calendar.monthItems,
      expected: calendar.expectedThumbnails,
      month: calendar.expectedMonthThumbnails,
      hidden: calendar.hiddenBehindMore,
      rendered: calendar.renderedThumbnails,
      loaded: calendar.loadedThumbnails,
      unavailable: calendar.unavailableThumbnails,
    },
    { monthItems: 3, expected: 3, month: 2, hidden: 1, rendered: 3, loaded: 1, unavailable: 1 },
  );
});

test("rejects the previous view's layer as the destination", (t) => {
  const doc = fixture(
    t,
    '<span data-harbor-nav="library"><button>Library</button></span><div class="harbor-layer-active"><main>Old view</main></div>',
  );
  assert.equal(typeof activateView("library"), "number");
  assert.equal(pageState("library").layerReplaced, false);
  doc.querySelector(".harbor-layer-active").remove();
  doc.body.insertAdjacentHTML(
    "beforeend",
    '<div class="harbor-layer-active"><main data-harbor-library>New view</main></div>',
  );
  const state = pageState("library");
  assert.equal(state.layerReplaced, true);
  assert.equal(state.viewMarker, true);
});

function scroller(el, { width, height, scrollWidth, scrollHeight }) {
  let left = 0,
    top = 0;
  Object.defineProperties(el, {
    clientWidth: { value: width },
    clientHeight: { value: height },
    scrollWidth: { get: () => scrollWidth },
    scrollHeight: { get: () => scrollHeight(), configurable: true },
    scrollLeft: {
      get: () => left,
      set: (v) => {
        left = Math.max(0, Math.min(v, scrollWidth - width));
      },
    },
    scrollTop: {
      get: () => top,
      set: (v) => {
        top = Math.max(0, Math.min(v, scrollHeight() - height));
      },
    },
  });
}

test("covers each visible row horizontally within bounds before scrolling the page", (t) => {
  const doc = fixture(
    t,
    '<div class="harbor-layer-active"><main id="page" style="overflow-y:auto"><div id="row" style="overflow-x:auto"></div></main></div>',
  );
  scroller(doc.getElementById("page"), {
    width: 1600,
    height: 1000,
    scrollWidth: 1600,
    scrollHeight: () => 2600,
  });
  scroller(doc.getElementById("row"), {
    width: 1000,
    height: 300,
    scrollWidth: 10000,
    scrollHeight: () => 300,
  });
  const limits = { verticalSteps: 1, rows: 4, horizontalStepsPerRow: 2 };
  const moves = [];
  let last;
  for (let i = 0; i < 10 && !last?.done; i++) {
    last = coverageStep(limits);
    moves.push(last.moved ?? last.reason);
  }
  assert.deepEqual(moves, ["horizontal", "horizontal", "vertical", "vertical-limit"]);
  assert.equal(last.rowsScanned, 1);
  assert.equal(last.rowsBounded, 1);
  assert.equal(last.verticalBounded, true);
});

test("waits for an infinite feed to stop growing before declaring the bottom", (t) => {
  const doc = fixture(
    t,
    '<div class="harbor-layer-active"><main id="page" style="overflow-y:auto">Feed</main></div>',
  );
  let height = 1500;
  scroller(doc.getElementById("page"), {
    width: 1600,
    height: 1000,
    scrollWidth: 1600,
    scrollHeight: () => height,
  });
  const limits = { verticalSteps: 10, rows: 0, horizontalStepsPerRow: 0 };
  assert.equal(coverageStep(limits).moved, "vertical");
  assert.equal(coverageStep(limits).moved, "wait-bottom");
  height = 2300;
  assert.equal(coverageStep(limits).moved, "vertical");
  assert.equal(coverageStep(limits).moved, "wait-bottom");
  const done = coverageStep(limits);
  assert.equal(done.reason, "bottom");
  assert.equal(done.reachedBottom, true);
});
