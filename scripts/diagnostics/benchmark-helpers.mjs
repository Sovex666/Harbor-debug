import { boundedNumber } from "./cdp.mjs";

// A quiet window must begin after both the last image change and view mount.
export function imageSettlement({ mountedAt, lastChangeAt, pending, now, quietMs }) {
  if (![mountedAt, lastChangeAt, pending, now, quietMs].every(Number.isFinite)) return false;
  return pending === 0 && quietMs >= 0 && now - Math.max(mountedAt, lastChangeAt) >= quietMs;
}

// URLs, including their paths, and error messages may contain credentials.
export function networkError({ status, resourceType, failed }) {
  const types = new Set([
    "Document",
    "Stylesheet",
    "Image",
    "Media",
    "Font",
    "Script",
    "XHR",
    "Fetch",
    "WebSocket",
  ]);
  return {
    status: Number.isInteger(status) && status >= 100 && status <= 599 ? status : null,
    resourceType: types.has(resourceType) ? resourceType : "Other",
    failed: failed === true,
  };
}

// Cold Calendar alone has taken ~37 s, so deadlines are minutes, not seconds.
// Infinite feeds and rows are explored only up to these explicit bounds.
// The normal run caps each page at 20 s; deep mode has no page budget and
// waits up to the minute-scale deadlines.
export function readEnvLimits(env, { deep = false } = {}) {
  const read = (name, fallback, min, max) =>
    boundedNumber(env[name] ?? fallback, name, min, max, true);
  return {
    pageBudgetMs: deep ? 0 : read("HARBOR_BENCHMARK_PAGE_BUDGET_MS", 20000, 5000, 300000),
    dataTimeoutMs: read("HARBOR_BENCHMARK_TIMEOUT_MS", 180000, 10000, 900000),
    coverageTimeoutMs: read("HARBOR_BENCHMARK_COVERAGE_MS", 300000, 10000, 1800000),
    stallMs: read("HARBOR_BENCHMARK_STALL_MS", deep ? 30000 : 2000, 1000, 300000),
    verticalSteps: read("HARBOR_BENCHMARK_VERTICAL_STEPS", deep ? 12 : 1, 0, 200),
    rows: read("HARBOR_BENCHMARK_ROWS", deep ? 8 : 0, 0, 200),
    horizontalStepsPerRow: read("HARBOR_BENCHMARK_ROW_STEPS", deep ? 3 : 0, 0, 50),
    warmingIdleMs: read("HARBOR_BENCHMARK_WARMING_IDLE_MS", deep ? 120000 : 10000, 5000, 600000),
  };
}

// Separates harness validity (was the sample measured correctly?) from app
// findings (failed artwork, errors), which are reported but remain valid.
export function summarizeVisit(v) {
  const invalid = [];
  const issues = [];
  if (v.status !== "measured") invalid.push(v.status);
  else {
    if (v.navigationMs == null) invalid.push("no switch time");
    if (v.coverageMode === "full" && v.fullCoverageMs == null && !v.overBudget && !v.calendarError)
      invalid.push("coverage incomplete");
    if (v.confirmedActiveView !== v.view) invalid.push("wrong active view");
    if (v.documentVisibility !== "visible") invalid.push("document hidden");
    if (v.viewMarker === false && !v.startPage) invalid.push("view marker missing");
    if (v.view === "home" && v.homeSections?.length !== 3 && !v.overBudget)
      invalid.push("home sections missing");
    const c = v.calendar;
    if (v.view === "calendar" && !v.overBudget && !v.calendarError) {
      if (!c?.complete) invalid.push("calendar not complete");
      else if (c.renderedThumbnails !== c.expectedThumbnails)
        invalid.push(
          `calendar rendered ${c.renderedThumbnails}/${c.expectedThumbnails} thumbnails`,
        );
    }
  }
  if (v.overBudget)
    issues.push(
      `MAJOR: not ready within ${Math.round(v.overBudget.budgetMs / 1000)} s (stopped at ${v.overBudget.stage})`,
    );
  if (v.calendarError) issues.push("MAJOR: Calendar ended in an error state");
  else if (v.calendarErrorSeen) issues.push("Calendar briefly reported an error");
  const a = v.artwork ?? {};
  // Stalled artwork is an app finding: the sample still measured what happened.
  const pending = (a.imagesPending ?? 0) + (a.postersPending ?? 0);
  if (pending) issues.push(`${pending} artwork never resolved`);
  if (v.viewportStalled) issues.push("viewport artwork stalled; no readiness time");
  const cal = v.calendar;
  if (cal?.complete && cal.loadedThumbnails + cal.unavailableThumbnails !== cal.expectedThumbnails)
    issues.push("calendar thumbnails unresolved");
  if (a.imagesFailed) issues.push(`${a.imagesFailed} image failures`);
  if (a.postersUnavailable) issues.push(`${a.postersUnavailable} posters without artwork`);
  if (v.calendar?.hiddenBehindMore)
    issues.push(`${v.calendar.hiddenBehindMore} calendar items only behind "+N more"`);
  if (v.network?.failed) issues.push(`${v.network.failed} failed requests`);
  if (v.network?.httpErrors) issues.push(`${v.network.httpErrors} HTTP error responses`);
  if (v.network?.inflightAtEnd) issues.push(`${v.network.inflightAtEnd} requests still in flight`);
  if (v.console?.errors) issues.push(`${v.console.errors} console errors`);
  if (v.console?.exceptions) issues.push(`${v.console.exceptions} uncaught exceptions`);
  if (v.eventLoopStalls?.count)
    issues.push(
      `${v.eventLoopStalls.count} event-loop stalls (max ${Math.round(v.eventLoopStalls.maxMs)} ms)`,
    );
  const valid = invalid.length === 0;
  return {
    valid,
    invalidReasons: invalid,
    issues,
    status: valid
      ? issues.length
        ? "settled-with-issues"
        : "settled"
      : v.status === "measured"
        ? "invalid"
        : v.status,
  };
}

export function jaccard(a, b) {
  if (!a || !b) return null;
  const left = new Set(a),
    right = new Set(b);
  const union = new Set([...left, ...right]);
  if (!union.size) return 1;
  let shared = 0;
  for (const x of left) if (right.has(x)) shared++;
  return shared / union.size;
}

const basePhase = (phase) => phase.replace(/-retry$/, "");

// Restart results are compared with the first measured visit of the same view,
// using hashed content so equality can be shown without exporting content.
export function compareContent(first, restart, hashes) {
  const views = restart.views
    .filter((v) => v.valid)
    .map((v) => {
      const reference = first.views.find(
        (f) =>
          f.view === v.view &&
          f.valid &&
          ["cold", "first-visit", "return"].includes(basePhase(f.phase)),
      );
      return {
        view: v.view,
        referencePhase: reference?.phase ?? null,
        navigationMs: [reference?.navigationMs ?? null, v.navigationMs],
        viewportReadyMs: [reference?.viewportReadyMs ?? null, v.viewportReadyMs],
        fullCoverageMs: [reference?.fullCoverageMs ?? null, v.fullCoverageMs],
        calendarCompleteMs: [reference?.calendarCompleteMs ?? null, v.calendarCompleteMs ?? null],
        sameHeadings: reference ? reference.content?.headingHash === v.content?.headingHash : null,
        posters: [reference?.content?.posterCount ?? null, v.content?.posterCount ?? null],
        imageSourceOverlap: reference
          ? jaccard(
              hashes.get(`${first.name}:${v.view}:${reference.phase}`),
              hashes.get(`${restart.name}:${v.view}:${v.phase}`),
            )
          : null,
      };
    });
  const before = restart.cacheBeforeApp,
    after = first.cacheAfterApp;
  return {
    persistedStorage: {
      databasesBeforeRestart: after ? Object.keys(after.databases).length : null,
      databasesAfterRestart: before ? Object.keys(before.databases).length : null,
      mediaCacheEntriesBeforeRestart: after?.databases["harbor-media-cache"]?.index ?? null,
      mediaCacheEntriesAfterRestart: before?.databases["harbor-media-cache"]?.index ?? null,
      browseCacheSaltKept: Boolean(after?.browseCacheSalt && before?.browseCacheSalt),
      namespacesAfterRestart: before?.mediaCacheNamespaces ?? null,
    },
    views,
  };
}

// Only the site (last two host labels) leaves the runner; never paths or queries.
export function siteOf(url) {
  if (!url) return "none";
  if (url.startsWith("data:")) return "inline";
  if (url.startsWith("blob:")) return "blob";
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return "invalid";
  }
  if (/^(localhost|127\.|\[?::1\]?$)/.test(host) || host.endsWith(".localhost")) return "loopback";
  if (/^\d+(\.\d+){3}$/.test(host)) return "ip-address";
  return host.split(".").slice(-2).join(".");
}

const waitReasons = {
  lazy: "poster not enabled yet (lazy gate never opened)",
  unsized: "poster has no measured size (targetPx 0)",
  paused: "poster's layer is paused",
  source: "no image source yet (Harbor image proxy pending)",
  image: "no image element rendered",
};

// Classifies each unresolved item using the runner's network log. `lookup(url)`
// returns { done, failed, errorText, status, startedAt } or undefined.
export function explainArtwork(items, lookup, now) {
  const groups = new Map();
  for (const item of items) {
    let reason, ageMs;
    if (!item.src) reason = waitReasons[item.wait] ?? "no image element rendered";
    else {
      const r = item.src.startsWith("http") ? lookup(item.src) : undefined;
      if (!item.src.startsWith("http"))
        reason = item.complete ? "inline image failed to decode" : "inline image not decoded yet";
      else if (!r) reason = "image URL never requested";
      else if (r.failed)
        reason = `request failed (${/^net::[A-Z_]+$/.test(r.errorText ?? "") ? r.errorText : "network error"})`;
      else if (r.status >= 400) reason = `HTTP ${r.status}`;
      else if (!r.done) {
        reason = "request still in flight";
        ageMs = now - r.startedAt;
      } else if (item.complete && item.naturalWidth === 0) reason = "downloaded but decode failed";
      else if (!item.complete) reason = "downloaded but image not complete";
      else if (item.kind === "poster") reason = "image shown but poster never marked loaded";
      else reason = "image loaded, decode still pending";
    }
    const key = `${item.kind}|${reason}`;
    const g = groups.get(key) ?? { kind: item.kind, reason, count: 0, sites: {}, fallbacks: 0 };
    g.count++;
    g.fallbacks += item.fallback ?? 0;
    const site = item.src ? siteOf(item.src) : "none";
    g.sites[site] = (g.sites[site] ?? 0) + 1;
    if (ageMs != null) g.oldestMs = Math.max(g.oldestMs ?? 0, ageMs);
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

// Hard wall-clock numbers an agent can plan around: each run step, each pass
// split into visit time and overhead, and every visit by view and phase.
export function timingSummary(report) {
  const at = Object.fromEntries((report.timeline ?? []).map((t) => [t.step, t.atMs]));
  const span = (from, to) =>
    at[to] != null && (from === 0 || at[from] != null)
      ? at[to] - (from === 0 ? 0 : at[from])
      : null;
  const passSpans = {
    "cold-and-warm": span("servers ready", "cold-and-warm done"),
    "browser-and-server-restart": span("fixture restarted", "restart done"),
    "production-like-warming": span("restart done", "warming done"),
    "switch-ping-pong": span("servers ready", "switch-ping-pong done"),
  };
  const passes = report.passes.map((p) => {
    const visitsMs = p.views.reduce((n, v) => n + (v.elapsedMs ?? 0), 0);
    const durationMs = passSpans[p.name] ?? null;
    return {
      name: p.name,
      durationMs,
      visits: p.views.length,
      visitsMs,
      overheadMs: durationMs == null ? null : durationMs - visitsMs,
      shellReadyMs: p.shellReadyMs ?? null,
      overBudget: p.views.filter((v) => v.overBudget).length,
    };
  });
  const views = new Map();
  for (const p of report.passes)
    for (const v of p.views) {
      const row = views.get(v.view) ?? { view: v.view, phases: {}, totalMs: 0 };
      row.phases[v.phase] = v.elapsedMs ?? null;
      row.totalMs += v.elapsedMs ?? 0;
      views.set(v.view, row);
    }
  const slowest = report.passes
    .flatMap((p) =>
      p.views.map((v) => ({
        pass: p.name,
        view: v.view,
        phase: v.phase,
        elapsedMs: v.elapsedMs ?? 0,
        overBudget: Boolean(v.overBudget),
      })),
    )
    .sort((a, b) => b.elapsedMs - a.elapsedMs)
    .slice(0, 8);
  // One row per visit with every per-tab number an agent compares across runs.
  const tabs = report.passes.flatMap((p) =>
    p.views.map((v) => {
      const a = v.artwork ?? {};
      return {
        pass: p.name,
        view: v.view,
        phase: v.phase,
        valid: Boolean(v.valid),
        overBudget: Boolean(v.overBudget),
        clickToFrameMs: v.clickToFrameMs ?? null,
        switchMs: v.navigationMs ?? null,
        dataMs: v.dataReadyMs ?? null,
        calendarMs: v.view === "calendar" ? (v.calendarCompleteMs ?? null) : undefined,
        viewportImagesMs: v.viewportReadyMs ?? null,
        allImagesMs: v.coverageMode === "full" ? (v.fullCoverageMs ?? null) : undefined,
        images: v.imageTiming ?? null,
        imagesLoaded: (a.imagesLoaded ?? 0) + (a.postersLoaded ?? 0),
        imagesFailed: (a.imagesFailed ?? 0) + (a.postersUnavailable ?? 0),
        imagesUnresolved: (a.imagesPending ?? 0) + (a.postersPending ?? 0),
        longTasks: v.longTasks ?? null,
        eventLoopStalls: v.eventLoopStalls ?? null,
        smoothness: v.smoothness ?? null,
        worstFrame: v.worstFrame ?? null,
        elapsedMs: v.elapsedMs ?? null,
      };
    }),
  );
  return {
    totalMs: report.durationMs ?? null,
    serverStartMs: span(0, "servers ready"),
    pageBudgetMs: report.environment?.limits?.pageBudgetMs ?? null,
    passes,
    views: [...views.values()].sort((a, b) => b.totalMs - a.totalMs),
    slowest,
    tabs,
  };
}
