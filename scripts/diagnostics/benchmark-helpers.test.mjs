import test from "node:test";
import assert from "node:assert/strict";
import {
  compareContent,
  imageSettlement,
  jaccard,
  networkError,
  explainArtwork,
  readEnvLimits,
  siteOf,
  timingSummary,
  summarizeVisit,
} from "./benchmark-helpers.mjs";

test("settlement requires a mounted view, no pending images, and a full quiet window", () => {
  const state = { mountedAt: 100, lastChangeAt: 120, pending: 0, now: 620, quietMs: 500 };
  assert.equal(imageSettlement(state), true);
  assert.equal(imageSettlement({ ...state, now: 619 }), false);
  assert.equal(imageSettlement({ ...state, pending: 1 }), false);
  assert.equal(imageSettlement({ ...state, mountedAt: 300 }), false);
  assert.equal(imageSettlement({ ...state, mountedAt: null }), false);
});

test("network error projection excludes URLs, messages and arbitrary types", () => {
  assert.deepEqual(
    networkError({
      status: 404,
      resourceType: "Image",
      failed: true,
      url: "secret",
      message: "secret",
    }),
    {
      status: 404,
      resourceType: "Image",
      failed: true,
    },
  );
  assert.deepEqual(networkError({ status: 0, resourceType: "secret" }), {
    status: null,
    resourceType: "Other",
    failed: false,
  });
});

test("limits default to minute-scale deadlines and reject a five-second deadline", () => {
  const limits = readEnvLimits({});
  assert.equal(limits.dataTimeoutMs, 180000);
  assert.equal(limits.verticalSteps, 1);
  assert.equal(limits.rows, 0);
  assert.throws(() => readEnvLimits({ HARBOR_BENCHMARK_TIMEOUT_MS: "5000" }));
});

const measured = {
  view: "movies",
  status: "measured",
  navigationMs: 80,
  viewportReadyMs: 900,
  fullCoverageMs: 4000,
  confirmedActiveView: "movies",
  documentVisibility: "visible",
  viewMarker: null,
  coverageMode: "full",
  coverage: { stalledSteps: 0 },
  artwork: { imagesPending: 0, postersPending: 0, imagesFailed: 0, postersUnavailable: 0 },
};

test("separates invalid samples from valid samples with app findings", () => {
  assert.equal(summarizeVisit(measured).status, "settled");
  const pending = summarizeVisit({
    ...measured,
    artwork: { ...measured.artwork, postersPending: 2 },
  });
  assert.equal(pending.valid, true);
  assert.match(pending.issues.join(), /2 artwork never resolved/);
  assert.equal(summarizeVisit({ ...measured, fullCoverageMs: null }).valid, false);
  assert.equal(
    summarizeVisit({ ...measured, coverageMode: "viewport", fullCoverageMs: null }).valid,
    true,
  );
  const failed = summarizeVisit({ ...measured, artwork: { ...measured.artwork, imagesFailed: 1 } });
  assert.equal(failed.valid, true);
  assert.equal(failed.status, "settled-with-issues");
  assert.equal(summarizeVisit({ ...measured, status: "data-timeout" }).status, "data-timeout");
  assert.equal(summarizeVisit({ ...measured, confirmedActiveView: "home" }).valid, false);
});

test("Calendar is valid only when every rendered thumbnail resolved", () => {
  const calendar = {
    ...measured,
    view: "calendar",
    confirmedActiveView: "calendar",
    calendar: {
      complete: true,
      expectedThumbnails: 30,
      renderedThumbnails: 30,
      loadedThumbnails: 28,
      unavailableThumbnails: 2,
      hiddenBehindMore: 4,
    },
  };
  const ok = summarizeVisit(calendar);
  assert.equal(ok.valid, true);
  assert.match(ok.issues.join(), /4 calendar items only behind/);
  assert.equal(
    summarizeVisit({ ...calendar, calendar: { ...calendar.calendar, renderedThumbnails: 21 } })
      .valid,
    false,
  );
});

test("restart comparison pairs each view with its first measured visit", () => {
  const first = {
    name: "a",
    cacheAfterApp: {
      databases: { "harbor-media-cache": { index: 10 } },
      browseCacheSalt: true,
      mediaCacheNamespaces: {},
    },
    views: [
      {
        view: "movies",
        phase: "first-visit",
        valid: true,
        navigationMs: 100,
        content: { headingHash: "x", posterCount: 4 },
      },
      { view: "movies", phase: "warm-return", valid: true, navigationMs: 10 },
    ],
  };
  const restart = {
    name: "b",
    cacheBeforeApp: {
      databases: { "harbor-media-cache": { index: 10 } },
      browseCacheSalt: true,
      mediaCacheNamespaces: { "browse-catalog": 8 },
    },
    views: [
      {
        view: "movies",
        phase: "restart",
        valid: true,
        navigationMs: 50,
        content: { headingHash: "x", posterCount: 4 },
      },
    ],
  };
  const hashes = new Map([
    ["a:movies:first-visit", ["1", "2", "3"]],
    ["b:movies:restart", ["2", "3", "4"]],
  ]);
  const result = compareContent(first, restart, hashes);
  assert.equal(result.persistedStorage.browseCacheSaltKept, true);
  assert.equal(result.persistedStorage.mediaCacheEntriesAfterRestart, 10);
  assert.deepEqual(result.views[0].navigationMs, [100, 50]);
  assert.equal(result.views[0].sameHeadings, true);
  assert.equal(result.views[0].imageSourceOverlap, 0.5);
  assert.equal(jaccard([], []), 1);
});

test("normal mode has a 20 s page budget; deep mode has none and waits longer", () => {
  assert.equal(readEnvLimits({}).pageBudgetMs, 20000);
  const deep = readEnvLimits({}, { deep: true });
  assert.equal(deep.pageBudgetMs, 0);
  assert.ok(deep.stallMs > readEnvLimits({}).stallMs && deep.rows > 0);
});

test("a missed page budget is a valid sample with a major finding", () => {
  const v = summarizeVisit({
    ...measured,
    fullCoverageMs: null,
    overBudget: { stage: "coverage", budgetMs: 20000 },
  });
  assert.equal(v.valid, true);
  assert.match(v.issues.join(), /MAJOR: not ready within 20 s/);
});

test("sites never include paths, queries or loopback ports", () => {
  assert.equal(
    siteOf("https://images.metahub.space/poster/medium/tt1/img?token=x"),
    "metahub.space",
  );
  assert.equal(siteOf("http://127.0.0.1:5173/a"), "loopback");
  assert.equal(siteOf("data:image/png;base64,AA"), "inline");
});

test("explains unresolved artwork from the poster gate and the network log", () => {
  const log = new Map([
    ["https://a.example.org/1", { done: false, startedAt: 1000 }],
    ["https://a.example.org/2", { done: true, failed: true, errorText: "net::ERR_TIMED_OUT" }],
    ["https://b.example.com/3", { done: true, status: 404 }],
  ]);
  const groups = explainArtwork(
    [
      { kind: "poster", src: null, wait: "unsized" },
      { kind: "poster", src: "https://a.example.org/1", complete: false },
      { kind: "poster", src: "https://a.example.org/2", complete: true, naturalWidth: 0 },
      { kind: "image", src: "https://b.example.com/3", complete: true, naturalWidth: 0 },
      { kind: "image", src: "https://c.example.net/4", complete: false },
    ],
    (url) => log.get(url),
    6000,
  );
  const reasons = Object.fromEntries(groups.map((g) => [g.reason, g]));
  assert.ok(reasons["poster has no measured size (targetPx 0)"]);
  assert.equal(reasons["request still in flight"].oldestMs, 5000);
  assert.ok(reasons["request failed (net::ERR_TIMED_OUT)"]);
  assert.ok(reasons["HTTP 404"]);
  assert.ok(reasons["image URL never requested"]);
  assert.ok(!JSON.stringify(groups).includes("/1"));
});

test("Home that misses its budget without all sections is still a valid sample", () => {
  const v = summarizeVisit({
    ...measured,
    view: "home",
    confirmedActiveView: "home",
    homeSections: ["a"],
    overBudget: { stage: "data", budgetMs: 20000 },
  });
  assert.equal(v.valid, true);
});

test("timing splits each pass into visit time and overhead", () => {
  const t = timingSummary({
    durationMs: 100000,
    timeline: [
      { step: "servers ready", atMs: 1000 },
      { step: "cold-and-warm done", atMs: 61000 },
      { step: "fixture restarted", atMs: 62000 },
      { step: "restart done", atMs: 82000 },
      { step: "warming done", atMs: 99000 },
    ],
    environment: { limits: { pageBudgetMs: 20000 } },
    passes: [
      {
        name: "cold-and-warm",
        shellReadyMs: 5000,
        views: [
          { view: "calendar", phase: "cold", elapsedMs: 20000, overBudget: {} },
          { view: "home", phase: "return", elapsedMs: 3000 },
        ],
      },
      {
        name: "browser-and-server-restart",
        views: [{ view: "calendar", phase: "restart", elapsedMs: 4000 }],
      },
    ],
  });
  assert.equal(t.serverStartMs, 1000);
  assert.deepEqual(
    t.passes.map((p) => [p.durationMs, p.visitsMs, p.overheadMs, p.overBudget]),
    [
      [60000, 23000, 37000, 1],
      [20000, 4000, 16000, 0],
    ],
  );
  assert.deepEqual(t.views[0], {
    view: "calendar",
    phases: { cold: 20000, restart: 4000 },
    totalMs: 24000,
  });
  assert.equal(t.slowest[0].view, "calendar");
});

test("timing lists per-tab responsiveness, image and smoothness numbers", () => {
  const t = timingSummary({
    timeline: [],
    environment: { limits: {} },
    passes: [
      {
        name: "cold-and-warm",
        views: [
          {
            view: "calendar",
            phase: "cold",
            valid: true,
            coverageMode: "full",
            clickToFrameMs: 12,
            navigationMs: 150,
            dataReadyMs: 900,
            calendarCompleteMs: 4000,
            viewportReadyMs: 5000,
            fullCoverageMs: 7000,
            imageTiming: { firstMs: 1000, medianMs: 3000, lastMs: 6000 },
            artwork: { imagesLoaded: 2, postersLoaded: 10, postersUnavailable: 1, postersPending: 2 },
            smoothness: { fps: 58, slowFrames: 3, maxFrameMs: 120, jankMs: 200 },
          },
          { view: "home", phase: "return", coverageMode: "viewport", navigationMs: 80 },
        ],
      },
    ],
  });
  const [calendar, home] = t.tabs;
  assert.equal(calendar.calendarMs, 4000);
  assert.equal(calendar.allImagesMs, 7000);
  assert.deepEqual(
    [calendar.imagesLoaded, calendar.imagesFailed, calendar.imagesUnresolved],
    [12, 1, 2],
  );
  assert.equal(calendar.smoothness.slowFrames, 3);
  assert.equal(home.calendarMs, undefined);
  assert.equal(home.allImagesMs, undefined);
  assert.equal(home.switchMs, 80);
});
