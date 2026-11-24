const ms = (n) => (n == null ? "—" : Math.round(n).toLocaleString("en-US"));
const pair = ([a, b]) => `${ms(a)} → ${ms(b)}`;

export function renderMarkdown(report) {
  const env = report.environment;
  const lines = [
    "# Harbor browser benchmark",
    "",
    `Status: **${report.status}**  `,
    `Command: \`${report.command}\`  `,
    `Started ${report.startedAt}, finished ${report.finishedAt} (${ms((report.durationMs ?? 0) / 1000)} s)  `,
    `Timeline: ${(report.timeline ?? []).map((t) => `${t.step} at ${ms(t.atMs / 1000)} s`).join("; ") || "—"}`,
    "",
    "## Scope and approximations",
    "",
    `- Mode: **${report.mode ?? "normal"}**. ${env.limits.pageBudgetMs ? `Each page has a ${ms(env.limits.pageBudgetMs)} ms budget; a page that misses it is a major finding with its cause below. Run with \`-- --deep\` for unbounded waits and full scrolling.` : "No page budget; slow artwork is waited for up to the deadlines below."}`,
    `- Normal visible ${env.browser ?? "Chromium"} window behind other windows (never headless). Windows native occlusion tracking is disabled so a covered window keeps rendering; any hidden document still invalidates its sample.`,
    "- Without Tauri, posters load their image URLs directly; Harbor's native image proxy and disk thumbnail cache are not exercised.",
    "- The startup splash is bypassed in the disposable fixture page; startup-to-first-paint is not measured.",
    "- Passes `cold-and-warm` and `browser-and-server-restart` disable Harbor's speculative browse-data warming to attribute demand work. They are not normal app performance. Idle module preloading still runs. The `production-like-warming` pass leaves warming enabled and uses real pointer hover and click.",
    "- Native mpv/WASAPI playback is not exercised.",
    "- The restart pass restarts the browser and the profile fixture; the Vite dev server keeps running.",
    `- Coverage bounds: up to ${env.limits.verticalSteps} vertical steps per view, ${env.limits.rows} horizontal rows per view, ${env.limits.horizontalStepsPerRow} steps per row. Infinite feeds stop at these bounds. ${report.mode === "deep" ? "Every visit scrolls for full coverage." : "Only first visits scroll for full coverage; warm-return, restart and warming visits measure the viewport."} Artwork unchanged for ${ms(env.limits.stallMs)} ms is recorded as never resolved. Data deadline ${ms(env.limits.dataTimeoutMs)} ms, coverage deadline ${ms(env.limits.coverageTimeoutMs)} ms.`,
    "",
  ];
  const first = report.passes[0];
  if (first?.profile)
    lines.push(
      `Profile snapshot: ${first.profile.libraryItems} library entries, ${first.profile.accountAddons} addons, ${first.profile.snapshotAgeHours.toFixed(1)} h old. Cold cache verified empty: ${first.coldVerified ? "yes" : "no"}.`,
      "",
    );
  if (report.errors.length)
    lines.push("## Runner errors", "", ...report.errors.map((e) => `- ${e}`), "");
  lines.push("## Missing or failed measurements", "");
  lines.push(...(report.missing.length ? report.missing.map((m) => `- ${m}`) : ["- None."]), "");
  lines.push(...timingSection(report));
  lines.push(...diagnosisSection(report));
  for (const pass of report.passes) {
    lines.push(
      `## Pass: ${pass.name}`,
      "",
      `Shell ready ${ms(pass.shellReadyMs)} ms after navigation${pass.shellReloads ? ` (${pass.shellReloads} reload${pass.shellReloads === 1 ? "" : "s"} after Vite dependency re-optimization)` : ""}. Requests ${pass.totals?.requests ?? "—"}, failed ${pass.totals?.failed ?? "—"}, HTTP errors ${pass.totals?.httpErrors ?? "—"}, console errors ${pass.totals?.consoleErrors ?? "—"}, exceptions ${pass.totals?.exceptions ?? "—"}. Browser internal pages closed: ${pass.edgeInternalPagesClosed ?? 0}.`,
      "",
    );
    if (pass.warmingIdle)
      lines.push(
        `Warming idle on Home: ${ms(pass.warmingIdle.waitedMs)} ms, network quiet: ${pass.warmingIdle.networkQuiet ? "yes" : "no (bounded)"}, ${pass.warmingIdle.requests} requests before the first click.`,
        "",
      );
    lines.push(
      "| View | Phase | Status | Switch ms | Data ms | Viewport art ms | Full coverage ms | Art loaded / seen | Unavail. | Failed | V steps | Rows (end/bound/skip) | Long tasks (max ms) | Stalls (max ms) |",
      "|---|---|---|---:|---:|---:|---:|---:|---:|---:|---|---|---|---|",
    );
    for (const v of pass.views) {
      const a = v.artwork ?? {};
      const c = v.coverage ?? {};
      const loaded = (a.imagesLoaded ?? 0) + (a.postersLoaded ?? 0);
      const seenCount = (a.images ?? 0) + (a.posters ?? 0);
      const vertical = !c.verticalScroller
        ? "none"
        : `${c.vSteps ?? 0}${c.reachedBottom ? " bottom" : c.verticalBounded ? " bounded" : ""}`;
      lines.push(
        `| ${v.view} | ${v.phase} | ${v.status} | ${ms(v.navigationMs)} | ${ms(v.dataReadyMs)} | ${ms(v.viewportReadyMs)} | ${v.coverageMode === "viewport" ? "viewport only" : ms(v.fullCoverageMs)} | ${loaded} / ${seenCount} | ${a.postersUnavailable ?? 0} | ${a.imagesFailed ?? 0} | ${vertical} | ${c.rowsScanned ?? 0} (${c.rowsReachedEnd ?? 0}/${c.rowsBounded ?? 0}/${c.rowsSkipped ?? 0}) | ${v.longTasks?.count ?? "—"} (${ms(v.longTasks?.maxMs)}) | ${v.eventLoopStalls?.count ?? "—"} (${ms(v.eventLoopStalls?.maxMs)}) |`,
      );
    }
    const invalid = pass.views.filter((v) => !v.valid);
    if (invalid.length)
      lines.push(
        "",
        "Invalid samples:",
        ...invalid.map(
          (v) => `- ${v.view} (${v.phase}): ${(v.invalidReasons ?? [v.status]).join("; ")}`,
        ),
      );
    lines.push("");
  }
  const calendars = report.passes.flatMap((p) =>
    p.views.filter((v) => v.view === "calendar").map((v) => ({ pass: p.name, ...v })),
  );
  if (calendars.length) {
    lines.push(
      "## Calendar",
      "",
      '| Pass | Phase | Status | Switch ms | Resolution complete ms | Resolved items | Month items | Thumbnails expected | Rendered | Loaded | Unavailable | Behind "+N more" | Candidates → resolved |',
      "|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|",
    );
    for (const v of calendars) {
      const c = v.calendar ?? {};
      const candidates = v.calendarEvents?.find((e) => e.name === "calendar.library.candidates");
      const resolve = v.calendarEvents?.find((e) => e.name === "calendar.library.resolve");
      const cacheHit = v.calendarEvents?.some((e) => e.name === "calendar.cache" && e.fields?.hit);
      lines.push(
        `| ${v.pass} | ${v.phase} | ${v.status} | ${ms(v.navigationMs)} | ${ms(v.calendarCompleteMs)} | ${c.items ?? "—"} | ${c.monthItems ?? "—"} | ${c.expectedThumbnails ?? "—"} | ${c.renderedThumbnails ?? "—"} | ${c.loadedThumbnails ?? "—"} | ${c.unavailableThumbnails ?? "—"} | ${c.hiddenBehindMore ?? "—"} | ${candidates ? `${candidates.fields.candidates} → ${(resolve?.fields.series ?? 0) + (resolve?.fields.movies ?? 0)}` : cacheHit ? "memory cache hit" : "—"} |`,
      );
    }
    lines.push(
      "",
      'Thumbnails expected = the chips the month grid renders (two per day); items beyond that are only reachable through each day\'s "+N more" dialog and are counted separately, not opened.',
      "",
    );
  }
  const restart = report.comparisons.restart;
  if (restart) {
    const s = restart.persistedStorage;
    lines.push(
      "## Browser and server restart vs first visit",
      "",
      `Persisted storage: ${s.databasesBeforeRestart ?? "—"} Harbor databases before restart, ${s.databasesAfterRestart ?? "—"} after; media-cache entries ${s.mediaCacheEntriesBeforeRestart ?? "—"} → ${s.mediaCacheEntriesAfterRestart ?? "—"}; browse-cache salt kept: ${s.browseCacheSaltKept ? "yes" : "no"}.`,
      "",
      "| View | Reference | Switch ms | Viewport art ms | Full coverage ms | Calendar ms | Same headings | Posters | Image-source overlap |",
      "|---|---|---|---|---|---|---|---|---:|",
      ...restart.views.map(
        (v) =>
          `| ${v.view} | ${v.referencePhase ?? "—"} | ${pair(v.navigationMs)} | ${pair(v.viewportReadyMs)} | ${pair(v.fullCoverageMs)} | ${pair(v.calendarCompleteMs)} | ${v.sameHeadings == null ? "—" : v.sameHeadings ? "yes" : "no"} | ${v.posters[0] ?? "—"} → ${v.posters[1] ?? "—"} | ${v.imageSourceOverlap == null ? "—" : `${Math.round(v.imageSourceOverlap * 100)}%`} |`,
      ),
      "",
    );
  }
  if (report.comparisons.warming) {
    lines.push(
      "## Production-like warming vs demand-only first visit",
      "",
      "| View | Demand phase | Switch ms | Viewport art ms | Calendar ms |",
      "|---|---|---|---|---|",
      ...report.comparisons.warming.map(
        (w) =>
          `| ${w.view} | ${w.demandPhase ?? "—"} | ${ms(w.demandNavigationMs)} → ${ms(w.warmedNavigationMs)} | ${ms(w.demandViewportReadyMs)} → ${ms(w.warmedViewportReadyMs)} | ${ms(w.demandCalendarCompleteMs)} → ${ms(w.warmedCalendarCompleteMs)} |`,
      ),
      "",
    );
    const warming = report.passes.find((p) => p.kind === "warming");
    if (warming?.cacheAfterWarming)
      lines.push(
        `Media-cache namespaces after warming idle: ${
          Object.entries(warming.cacheAfterWarming.mediaCacheNamespaces)
            .map(([k, n]) => `${k} ${n}`)
            .join(", ") || "none"
        }.`,
        "",
      );
  }
  lines.push(
    "## Category coverage",
    "",
    "| View | Control | Valid / visits | Visits |",
    "|---|---|---:|---|",
    ...report.categoryCoverage.map(
      (c) =>
        `| ${c.view} | ${c.control} | ${c.validVisits} / ${c.visits} | ${c.phases.join(", ") || "—"} |`,
    ),
    "",
    "## App findings",
    "",
    ...(report.issues.length ? report.issues.map((i) => `- ${i}`) : ["- None."]),
    "",
    `Cleanup: ${report.cleanup.length && report.cleanup.every((c) => c.exited) ? "all owned browser and server processes exited" : "incomplete"} (${report.cleanup.length} owned processes stopped).`,
    "",
    "Only counts, durations and one-way hashes are exported. URLs, titles, console text and credentials are not. Keep `.diag` private: the browser profiles contain copied sign-in state.",
    "",
  );
  return lines.join("\n");
}

// Pages that missed their budget or had stuck artwork, with the cause a debugger
// can act on: which gate artwork waited on and which requests were still open.
function diagnosisSection(report) {
  const rows = report.passes.flatMap((pass) =>
    pass.views.filter((v) => v.diagnosis).map((v) => ({ pass: pass.name, v })),
  );
  const lines = ["## Major findings: budget misses and stuck artwork", ""];
  if (!rows.length) return [...lines, "- None.", ""];
  for (const { pass, v } of rows) {
    const d = v.diagnosis;
    const what = v.overBudget
      ? `**missed the ${ms(v.overBudget.budgetMs)} ms budget** at the ${v.overBudget.stage} stage`
      : v.calendarError
        ? "**Calendar ended in an error state**"
        : `artwork stalled at the ${d.stage} stage`;
    lines.push(`### ${v.view} (${v.phase}, ${pass}): ${what}`, "");
    if (v.calendar)
      lines.push(
        `- Calendar: complete ${v.calendar.complete ? "yes" : "no"}, loading ${v.calendar.loading ? "yes" : "no"}, error ${v.calendar.error ? "yes" : "no"}, ${v.calendar.items ?? "—"} items, ${v.calendar.renderedThumbnails ?? "—"}/${v.calendar.expectedThumbnails ?? "—"} thumbnails rendered.`,
      );
    if (d.busyIndicators?.length)
      lines.push(
        `- Still showing: ${d.busyIndicators.map((b) => `${b.count}× ${b.indicator}`).join("; ")}.`,
      );
    if (v.view === "home")
      lines.push(
        `- Home sections shown: ${v.homeSections?.length ?? 0} of 3 (Continue Watching, Popular: Movies, Popular: Series).`,
      );
    lines.push(`- Unresolved visible artwork: ${d.unresolvedArtwork}.`);
    for (const g of d.artwork) {
      const sites = Object.entries(g.sites)
        .map(([s, n]) => `${s} ${n}`)
        .join(", ");
      lines.push(
        `  - ${g.count} ${g.kind}${g.count === 1 ? "" : "s"}: ${g.reason}${g.oldestMs != null ? ` (oldest ${ms(g.oldestMs)} ms)` : ""}; sites: ${sites}${g.fallbacks ? `; ${g.fallbacks} failed fallback candidates` : ""}.`,
      );
    }
    lines.push(
      d.inflight.length
        ? `- Requests still open: ${d.inflight.map((r) => `${r.count}× ${r.request} (oldest ${ms(r.oldestMs)} ms)`).join("; ")}.`
        : "- No requests were still open, so the wait was inside Harbor, not the network.",
    );
    if (d.requestsDuringVisit?.length)
      lines.push(
        `- Requests made during the visit: ${d.requestsDuringVisit.map((r) => `${r.count}× ${r.request} (longest ${ms(r.longestMs)} ms${r.failed ? `, ${r.failed} failed` : ""}${r.open ? `, ${r.open} open` : ""})`).join("; ")}.`,
      );
    lines.push("");
  }
  return lines;
}

function frameCause(f) {
  if (!f) return "—";
  const scripts = f.scripts
    .map((x) => `${x.fn ?? x.type}${x.source ? ` ${x.source}` : ""} ${ms(x.ms)}`)
    .join(", ");
  return `${ms(f.durationMs)} ms at +${ms(f.startMs)}: script ${ms(f.scriptMs)} (forced layout ${ms(f.forcedLayoutMs)}), style + layout ${ms(f.styleLayoutMs)}${scripts ? `; ${scripts}` : ""}`;
}

// Wall-clock numbers for planning automated runs (also in report.json `timing`).
function timingSection(report) {
  const t = report.timing;
  if (!t) return [];
  const sec = (n) => (n == null ? "—" : (n / 1000).toFixed(1));
  const lines = [
    "## Timing",
    "",
    `Total ${sec(t.totalMs)} s. Server start ${sec(t.serverStartMs)} s. Page budget ${sec(t.pageBudgetMs)} s per visit.`,
    "",
    "| Pass | Wall s | Visits | In visits s | Overhead s | First page load s | Over budget |",
    "|---|---:|---:|---:|---:|---:|---:|",
    ...t.passes.map(
      (p) =>
        `| ${p.name} | ${sec(p.durationMs)} | ${p.visits} | ${sec(p.visitsMs)} | ${sec(p.overheadMs)} | ${sec(p.shellReadyMs)} | ${p.overBudget} |`,
    ),
    "",
  ];
  const phases = [...new Set(t.views.flatMap((v) => Object.keys(v.phases)))];
  lines.push(
    `| View | ${phases.join(" | ")} | Total s |`,
    `|---|${phases.map(() => "---:").join("|")}|---:|`,
    ...t.views.map(
      (v) =>
        `| ${v.view} | ${phases.map((p) => sec(v.phases[p])).join(" | ")} | ${sec(v.totalMs)} |`,
    ),
    "",
    `Slowest visits: ${t.slowest.map((v) => `${v.view} ${v.phase} ${sec(v.elapsedMs)} s${v.overBudget ? " (over budget)" : ""}`).join("; ")}.`,
    "",
  );
  if (!t.tabs?.length) return lines;
  const flag = (v) => (v.overBudget ? " ⚠" : v.valid ? "" : " ✗");
  lines.push(
    "## Per-tab performance",
    "",
    "All times in ms from the click on the tab. Click → frame: first rendered frame after the click (input lag). Switch: destination view mounted. Data: content ready (Calendar: resolution complete). Images: viewport artwork settled, all artwork after scrolling, then first / median / last image loaded from the click. Click → frame is exact; other timings come from ~100 ms polls; ⚠ missed the page budget, ✗ invalid sample.",
    "",
    "| Tab | Phase | Click → frame | Switch | Data | Viewport images | All images | Image first / median / last | Loaded / failed / stuck | Total |",
    "|---|---|---:|---:|---:|---:|---:|---|---|---:|",
    ...t.tabs.map(
      (v) =>
        `| ${v.view}${flag(v)} | ${v.phase} | ${ms(v.clickToFrameMs)} | ${ms(v.switchMs)} | ${ms(v.calendarMs !== undefined ? v.calendarMs : v.dataMs)} | ${ms(v.viewportImagesMs)} | ${v.allImagesMs === undefined ? "n/a" : ms(v.allImagesMs)} | ${v.images ? `${ms(v.images.firstMs)} / ${ms(v.images.medianMs)} / ${ms(v.images.lastMs)}` : "—"} | ${v.imagesLoaded} / ${v.imagesFailed} / ${v.imagesUnresolved} | ${ms(v.elapsedMs)} |`,
    ),
    "",
    "Lag and smoothness during each visit. Long tasks: main-thread tasks over 50 ms. Stalls: event-loop gaps over 400 ms. Slow frames: over 50 ms between frames; jank is the time beyond 60 Hz spent in them. Worst frame cause: the longest animation frame after the click, split into script time and style + layout time, with its costliest scripts.",
    "",
    "| Tab | Phase | FPS | Slow frames | Worst frame | Jank | Long tasks (max) | Stalls (max) | Worst frame cause |",
    "|---|---|---:|---:|---:|---:|---|---|---|",
    ...t.tabs.map(
      (v) =>
        `| ${v.view}${flag(v)} | ${v.phase} | ${v.smoothness?.fps ?? "—"} | ${v.smoothness?.slowFrames ?? "—"} | ${ms(v.smoothness?.maxFrameMs)} | ${ms(v.smoothness?.jankMs)} | ${v.longTasks?.count ?? "—"} (${ms(v.longTasks?.maxMs)}) | ${v.eventLoopStalls?.count ?? "—"} (${ms(v.eventLoopStalls?.maxMs)}) | ${frameCause(v.worstFrame)} |`,
    ),
    "",
  );
  return lines;
}
