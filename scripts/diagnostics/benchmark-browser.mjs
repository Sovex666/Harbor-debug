#!/usr/bin/env node
// A project runner, not a production profile/browser controller.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Cdp } from "./cdp.mjs";
import {
  activateView,
  artworkDiagnosis,
  busyDiagnosis,
  cacheEvidence,
  configuredControls,
  contentEvidence,
  coverageStep,
  leaveSettings,
  navControlPoint,
  pageState,
  preparePage,
  resetScroll,
} from "./benchmark-page.mjs";
import {
  compareContent,
  explainArtwork,
  imageSettlement,
  networkError,
  readEnvLimits,
  siteOf,
  summarizeVisit,
  timingSummary,
} from "./benchmark-helpers.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
// The normal run caps each page at 20 s and explains what missed it; `--deep`
// waits for slow artwork, scrolls rows and feeds, and covers every visit.
const deep = process.argv.includes("--deep");
const runStarted = Date.now();
const stamp = () => `${Math.round((Date.now() - runStarted) / 1000)} s`.padStart(5);
// Wall-clock milestones, so a slow run shows where its time went.
const mark = (step) => {
  report.timeline.push({ step, atMs: Date.now() - runStarted });
  process.stdout.write(`[${stamp()}] ${step}\n`);
};
const limits = readEnvLimits(process.env, { deep });
// Debugging aid: "view:phase" pairs whose visit is CPU-profiled into the run
// directory, e.g. HARBOR_BENCHMARK_PROFILE=catalogs:warm-return.
const profiledVisits = new Set(
  (process.env.HARBOR_BENCHMARK_PROFILE ?? "").split(",").filter(Boolean),
);
const quietMs = 600;
const stepQuietMs = 300;
if (process.argv.includes("--headless"))
  throw new Error("This benchmark requires a visible browser");
const calendarOnly = process.argv.includes("--calendar-only");
const fastReturn = process.argv.includes("--fast-return");
const switchOnly = process.argv.includes("--switch-only") || fastReturn;
// Pause between ping-pong switches; under the app's 10 s idle-evict so the
// revisited view is still mounted (HARBOR_BENCHMARK_SWITCH_GAP_MS).
const switchGapMs = Number(process.env.HARBOR_BENCHMARK_SWITCH_GAP_MS || 2500);
// Time spent on Home before returning to Discover in --fast-return
// (HARBOR_BENCHMARK_FAST_RETURN_GAP_MS).
const fastReturnGapMs = Number(process.env.HARBOR_BENCHMARK_FAST_RETURN_GAP_MS || 2000);
// The view the fast return comes back to; Home is always the view it leaves
// (HARBOR_BENCHMARK_FAST_RETURN_VIEW).
const fastReturnView = process.env.HARBOR_BENCHMARK_FAST_RETURN_VIEW || "discover";
// Holds off page probes after the fast-return click so their forced layout does not count against the app.
const fastReturnQuietMs = Number(process.env.HARBOR_BENCHMARK_FAST_RETURN_QUIET_MS || 3000);
// Eight switches from a settled Home; the run ends back on Home.
const pingPong = ["discover", "home", "discover", "home", "catalogs", "home", "catalogs", "home"];
const warmDevServerFirst = process.argv.includes("--warm-dev-server");
// Every view Harbor can expose as a navigation category. Configured controls
// are discovered at runtime; the rest are reported as not configured.
// Games is left out by request: it replaces Harbor's navigation with its own.
const omittedViews = ["games"];
const knownViews = [
  "home",
  "discover",
  "catalogs",
  "plugins",
  "movies",
  "shows",
  "anime",
  "manga",
  "ebook",
  "music",
  "games",
  "kids",
  "live",
  "sports",
  "vod",
  "library",
  "collections-hub",
  "downloads",
  "addons",
  "calendar",
  "settings",
];
const viewFor = (navId) => (navId === "collections" ? "collections-hub" : navId);
const warmedViews = deep ? ["calendar", "movies", "shows", "discover"] : ["calendar", "movies"];
const quick = deep ? {} : { full: false };
const runDir = path.join(root, ".diag", `benchmark-${Date.now()}`);
const demandProfile = path.join(runDir, "browser-profile");
const warmingProfile = path.join(runDir, "browser-profile-warming");
const report = {
  schemaVersion: 2,
  status: "running",
  startedAt: new Date().toISOString(),
  command: [
    "pnpm run diag:benchmark",
    ...(calendarOnly || deep || switchOnly ? ["--"] : []),
    ...(calendarOnly ? ["--calendar-only"] : []),
    ...(switchOnly && !fastReturn ? ["--switch-only"] : []),
    ...(fastReturn ? ["--fast-return"] : []),
    ...(deep ? ["--deep"] : []),
  ].join(" "),
  mode: deep ? "deep" : "normal",
  environment: {
    imageProxyBypassed: true,
    devServerKeptAcrossRestart: true,
    headless: false,
    nativePlaybackTested: false,
    startupSplashBypassed: true,
    demandPassesDisableBrowseWarming: true,
    idleModulePreloadingActive: true,
    nativeWindowOcclusionDisabled: true,
    limits,
  },
  passes: [],
  timeline: [],
  comparisons: {},
  categoryCoverage: [],
  missing: [],
  issues: [],
  cleanup: [],
  errors: [],
};
const owned = new Set();
const sourceHashes = new Map();
let browser, cdp, vite, fixture, fixturePort, vitePort;
let stopping = false;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, ms = 30000, label = "benchmark readiness") {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (stopping) throw new Error("Benchmark interrupted");
    const result = await fn();
    if (result) return result;
    await pause(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
function start(exe, args, env = {}, visible = false, log = null) {
  const proc = spawn(exe, args, {
    cwd: root,
    env: { ...process.env, ...env },
    windowsHide: !visible,
    stdio: log ? ["ignore", "pipe", "pipe"] : "ignore",
  });
  if (log) {
    // Dev-server output names modules and dependencies, never profile data.
    const chunks = [];
    const keep = (data) => {
      chunks.push(String(data));
      void writeFile(log, chunks.join("")).catch(() => {});
    };
    proc.stdout.on("data", keep);
    proc.stderr.on("data", keep);
    proc.logText = () => chunks.join("");
  }
  proc.on("error", () => {
    proc.benchmarkSpawnFailed = true;
  });
  owned.add(proc);
  return proc;
}
async function stop(proc, role) {
  if (!proc) return;
  if (proc.exitCode === null && proc.signalCode === null) {
    const exited = new Promise((resolve) => proc.once("exit", resolve));
    // Kill only this owned tree; Vite may own an esbuild child on Windows.
    if (process.platform === "win32") {
      await new Promise((resolve) => {
        const killer = spawn("taskkill", ["/PID", String(proc.pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        });
        killer.once("error", resolve);
        killer.once("exit", resolve);
      });
    } else proc.kill();
    await Promise.race([exited, pause(5000)]);
  }
  const exited =
    proc.exitCode !== null || proc.signalCode !== null || proc.benchmarkSpawnFailed === true;
  report.cleanup.push({ role, exited });
  if (exited) owned.delete(proc);
  else throw new Error(`Owned ${role} process did not exit`);
}
let serverStarts = 0;
async function servers() {
  // An emitted, ignored vite.config.js would otherwise take precedence.
  vite = start(
    process.execPath,
    [
      "node_modules/vite/bin/vite.js",
      "--config",
      "scripts/diagnostics/benchmark-vite.config.ts",
      "--host",
      "127.0.0.1",
      "--port",
      String(vitePort),
      "--strictPort",
    ],
    {},
    false,
    path.join(runDir, `vite-${++serverStarts}.log`),
  );
  fixture = startFixture();
  await untilServing();
  // Optional: the dependency cache normally persists, and a Vite reload during
  // a visit is detected and retried, so the 30 s crawl is not paid by default.
  if (warmDevServerFirst) {
    report.devServerWarmup ??= [];
    report.devServerWarmup.push(await warmDevServer());
  }
}
function startFixture() {
  return start(process.execPath, ["scripts/diagnostics/browser-profile-server.cjs"], {
    HARBOR_FIXTURE_PORT: String(fixturePort),
    HARBOR_FIXTURE_VITE_PORT: String(vitePort),
  });
}
async function untilServing() {
  await until(
    async () => {
      if (
        vite.benchmarkSpawnFailed ||
        fixture.benchmarkSpawnFailed ||
        vite.exitCode !== null ||
        fixture.exitCode !== null
      )
        throw new Error("Owned fixture or Vite failed to start");
      try {
        const r = await fetch(`http://127.0.0.1:${fixturePort}/`, {
          signal: AbortSignal.timeout(2000),
        });
        return r.ok && (await r.text()).includes("/__snapshot.js");
      } catch {
        return false;
      }
    },
    60000,
    "owned servers",
  );
}
// Vite discovers dependencies of lazy routes only when a browser first
// requests them and then force-reloads the page, which destroys the sample.
// Walking the app's module graph over HTTP first makes discovery finish before
// any browser loads, and keeps dev-server compile time out of app timings.
async function warmDevServer() {
  const startedAt = Date.now();
  const base = `http://127.0.0.1:${vitePort}`;
  const seen = new Set(["/src/main.tsx"]);
  const queue = ["/src/main.tsx"];
  let failed = 0;
  const importPattern = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["'](\/(?:src|@id)\/[^"'?]+)/g;
  const worker = async () => {
    while (queue.length && !stopping) {
      const modulePath = queue.shift();
      try {
        const r = await fetch(base + modulePath, { signal: AbortSignal.timeout(60000) });
        const text = r.ok ? await r.text() : "";
        if (!r.ok) failed++;
        for (const [, next] of text.matchAll(importPattern))
          if (!seen.has(next) && seen.size < 12000) {
            seen.add(next);
            queue.push(next);
          }
      } catch {
        failed++;
      }
    }
  };
  // The queue grows while workers run; restart workers until it drains.
  while (queue.length && !stopping) await Promise.all(Array.from({ length: 12 }, worker));
  // Re-optimization runs after discovery; wait for the dev server to go quiet.
  let length = vite.logText().length,
    quietSince = Date.now();
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline && Date.now() - quietSince < 4000 && !stopping) {
    await pause(250);
    if (vite.logText().length !== length) {
      length = vite.logText().length;
      quietSince = Date.now();
    }
  }
  return {
    modules: seen.size,
    failed,
    ms: Date.now() - startedAt,
    optimizerMessages: (vite.logText().match(/optimiz/gi) ?? []).length,
  };
}
// The browser and the profile fixture restart; Vite keeps running, since
// restarting the dev server tests nothing about Harbor's persisted cache.
async function restartFixture(label) {
  await stop(fixture, `fixture-${label}`);
  fixture = startFixture();
  await untilServing();
}
// Chrome first: a fresh Chrome profile never signs in implicitly. Edge is the
// fallback; its sign-in and sync features are disabled in the launch flags.
function browserExecutable() {
  return [
    process.env.HARBOR_BROWSER,
    `${process.env.PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env["PROGRAMFILES(X86)"]}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env.PROGRAMFILES}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${process.env["PROGRAMFILES(X86)"]}\\Microsoft\\Edge\\Application\\msedge.exe`,
  ].find((p) => p && existsSync(p));
}
async function openSocket(socketUrl) {
  const parsed = new URL(socketUrl);
  if (parsed.protocol !== "ws:" || !["127.0.0.1", "localhost"].includes(parsed.hostname))
    throw new Error("Non-loopback CDP endpoint rejected");
  const client = new Cdp(new WebSocket(socketUrl), {}, 15000);
  await client.open();
  return client;
}
async function evaluate(fn, ...args) {
  const r = await cdp.send("Runtime.evaluate", {
    expression: `(${fn.toString()})(${args.map((x) => JSON.stringify(x)).join(",")})`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.exceptionDetails) throw new Error("Benchmark page evaluation failed (details withheld)");
  return r.result?.value;
}
// Installed before Harbor runs. Only counts/durations leave this page.
function instrumentation(demandOnly) {
  if (demandOnly) window.__HARBOR_BENCHMARK__ = true;
  const state = (window.__harborBench = {
    longTasks: [],
    gaps: [],
    frames: {
      count: 0,
      gaps: [],
      slow: [],
      long: [],
      clickAt: null,
      countAtClick: 0,
      afterClick: null,
    },
    errors: 0,
    rejections: 0,
    images: new WeakMap(),
    decoded: new WeakMap(),
    nextImage: 0,
  });
  if (PerformanceObserver.supportedEntryTypes.includes("longtask"))
    new PerformanceObserver((list) => {
      for (const e of list.getEntries())
        state.longTasks.push({ at: e.startTime, duration: e.duration });
    }).observe({ type: "longtask", buffered: true });
  // Long animation frames split a slow frame into script and rendering time so
  // a freeze can be attributed. Only app module paths and dependency file
  // names are kept, never origins or queries.
  const sourceOf = (url) =>
    /\/src\/[^?#]+/.exec(url)?.[0] ??
    /\/node_modules\/(?:\.vite\/deps\/)?([^/?#]+)/.exec(url)?.[1] ??
    (url ? "other" : null);
  if (PerformanceObserver.supportedEntryTypes.includes("long-animation-frame"))
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        const end = e.startTime + e.duration;
        state.frames.long.push({
          at: e.startTime,
          duration: e.duration,
          scriptMs: e.scripts.reduce((n, s) => n + s.duration, 0),
          forcedLayoutMs: e.scripts.reduce((n, s) => n + s.forcedStyleAndLayoutDuration, 0),
          styleLayoutMs: e.styleAndLayoutStart ? end - e.styleAndLayoutStart : 0,
          renderMs: e.renderStart ? end - e.renderStart : 0,
          scripts: [...e.scripts]
            .sort((a, b) => b.duration - a.duration)
            .slice(0, 3)
            .map((s) => ({
              ms: Math.round(s.duration),
              type: s.invokerType,
              fn: s.sourceFunctionName || null,
              source: sourceOf(s.sourceURL),
            })),
        });
      }
    }).observe({ type: "long-animation-frame", buffered: true });
  let last = performance.now();
  setInterval(() => {
    const at = performance.now();
    if (at - last > 400) state.gaps.push({ at, duration: at - last - 100 });
    last = at;
  }, 100);
  // Frames prove the compositor kept rendering; a hidden page produces none.
  // Frames over 50 ms (three missed 60 Hz frames) are the visible stutter.
  let lastFrame = performance.now();
  const frame = () => {
    const at = performance.now();
    const f = state.frames;
    f.count++;
    if (at - lastFrame > 250) f.gaps.push({ at, duration: at - lastFrame });
    if (at - lastFrame > 50) f.slow.push({ at, duration: at - lastFrame });
    if (f.clickAt != null && f.afterClick == null && at > f.clickAt) f.afterClick = at;
    lastFrame = at;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  // The runner clears clickAt before each tab click; the first pointerdown or
  // click after that starts the visit's input-lag and smoothness window.
  const click = (e) => {
    const f = state.frames;
    if (f.clickAt != null) return;
    f.clickAt = e.timeStamp;
    f.countAtClick = f.count;
    f.afterClick = null;
  };
  addEventListener("pointerdown", click, true);
  addEventListener("click", click, true);
  addEventListener("error", () => state.errors++, true);
  addEventListener("unhandledrejection", () => state.rejections++);
}
async function launch(profile, demandOnly) {
  const exe = browserExecutable();
  if (!exe)
    throw new Error("Chrome or Edge not found; set HARBOR_BROWSER to a Chromium executable");
  report.environment.browser = path.basename(exe);
  await mkdir(profile, { recursive: true });
  const args = [
    `--user-data-dir=${profile}`,
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-mode",
    "--disable-sync",
    "--enable-automation",
    // Windows native occlusion marks a covered, non-minimized window's
    // document hidden, which suspends rendering and invalidates samples when
    // the run is left in the background. The window itself stays visible.
    "--disable-features=msImplicitSignin,msEdgeSignin,msEdgeSync,msEdgeFirstRunExperience,CalculateNativeWinOcclusion",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-background-timer-throttling",
    "--window-size=1600,1000",
    // The window is created inactive over CDP so the run never takes focus.
    "--no-startup-window",
  ];
  const previousPort = await readFile(path.join(profile, "DevToolsActivePort"), "utf8").catch(
    () => null,
  );
  browser = start(exe, args, {}, true);
  const port = await until(
    async () => {
      if (browser.benchmarkSpawnFailed || browser.exitCode !== null)
        throw new Error("Owned browser exited before CDP became ready");
      try {
        const contents = await readFile(path.join(profile, "DevToolsActivePort"), "utf8");
        if (contents === previousPort) return false;
        const n = Number(contents.split("\n")[0]);
        return Number.isInteger(n) && n > 0 && n < 65536 ? n : false;
      } catch {
        return false;
      }
    },
    30000,
    "browser debugging port",
  );
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const browserSocket = await openSocket(version.webSocketDebuggerUrl);
  let targetId;
  try {
    ({ targetId } = await browserSocket.send("Target.createTarget", {
      url: "about:blank",
      newWindow: true,
      background: true,
    }));
  } finally {
    browserSocket.close();
  }
  const page = await until(
    async () =>
      (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(
        (t) => t.id === targetId,
      ),
    15000,
    "benchmark window",
  );
  cdp = await openSocket(page.webSocketDebuggerUrl);
  cdp.edgePagesClosed = 0;
  // Sign-in, sync and first-run pages belong to this owned browser only.
  cdp.on("Target.targetCreated", (p) => {
    if (p.targetInfo.type === "page" && /^(edge|chrome):/.test(p.targetInfo.url)) {
      cdp.edgePagesClosed++;
      void cdp?.send("Target.closeTarget", { targetId: p.targetInfo.targetId }).catch(() => {});
    }
  });
  await cdp.send("Target.setDiscoverTargets", { discover: true });
  await cdp.send("Page.enable");
  await cdp.send("Network.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Log.enable");
  const { windowId } = await cdp.send("Browser.getWindowForTarget");
  cdp.windowId = windowId;
  await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
  if (process.platform === "win32")
    await until(() => nativeWindowVisible(true), 15000, "a normal visible Windows window").catch(
      () => {
        throw new Error("Owned browser has no normal visible Windows window");
      },
    );
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1600,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `(${instrumentation.toString()})(${JSON.stringify(demandOnly)})`,
  });
}
function nativeWindowVisible(sendToBack = false) {
  return new Promise((resolve) => {
    const probe = start("powershell.exe", [
      "-NoProfile",
      "-File",
      "scripts/diagnostics/benchmark-visible-window.ps1",
      "-BrowserProcessId",
      String(browser.pid),
      ...(sendToBack ? ["-SendToBack"] : []),
    ]);
    probe.once("error", () => resolve(false));
    probe.once("exit", (code) => resolve(code === 0));
  });
}
async function closeBrowser() {
  if (cdp) {
    try {
      await cdp.send("Browser.close");
    } catch {}
    cdp.close();
    cdp = null;
  }
  // Let Chromium flush IndexedDB before killing an unresponsive owned process.
  if (browser && browser.exitCode === null && browser.signalCode === null)
    await Promise.race([new Promise((resolve) => browser.once("exit", resolve)), pause(8000)]);
  await stop(browser, "browser");
  browser = null;
}
// A minimized window is genuinely hidden. Restore it and require the document
// to report visible again; nothing in the page is overridden.
async function ensureVisible() {
  if ((await evaluate(() => document.visibilityState)) === "visible") return { recovered: false };
  const { bounds } = await cdp.send("Browser.getWindowBounds", { windowId: cdp.windowId });
  await cdp.send("Browser.setWindowBounds", {
    windowId: cdp.windowId,
    bounds: { windowState: "normal" },
  });
  try {
    await until(
      async () => (await evaluate(() => document.visibilityState)) === "visible",
      10000,
      "document visibility",
    );
  } catch {
    const native = process.platform === "win32" ? await nativeWindowVisible() : null;
    throw Object.assign(new Error("visibility"), {
      blocker: { windowState: bounds.windowState, nativeWindowVisible: native },
    });
  }
  return { recovered: true, previousWindowState: bounds.windowState };
}
function trackPass(pass) {
  const counters = (pass.counters = {
    requests: 0,
    finished: 0,
    failed: 0,
    httpErrors: 0,
    consoleErrors: 0,
    exceptions: 0,
    inflight: new Set(),
  });
  const recordNetworkError = (fields) => {
    if (fields.resourceType === "Script" && fields.status >= 500) pass.scriptServerErrors++;
    if (pass.networkErrors.length < 512) pass.networkErrors.push(networkError(fields));
    else pass.networkErrorsOmitted++;
  };
  pass.reloadInitiators = [];
  // URLs stay in memory for diagnosis only; this property is never serialized.
  const log = { byId: new Map(), byUrl: new Map() };
  Object.defineProperty(pass, "requestLog", { value: log, enumerable: false });
  cdp.on("Network.requestWillBeSent", (p) => {
    counters.requests++;
    counters.inflight.add(p.requestId);
    const entry = { url: p.request.url, type: p.type, startedAt: Date.now(), done: false };
    log.byId.set(p.requestId, entry);
    log.byUrl.set(p.request.url, entry);
    // A script-initiated document load is a reload by app code; keep only the
    // app source frames (module path and function), never origins or queries.
    if (p.type === "Document" && p.initiator?.stack && pass.reloadInitiators.length < 8) {
      const frames = [];
      for (let stack = p.initiator.stack; stack && frames.length < 6; stack = stack.parent)
        for (const f of stack.callFrames) {
          const source = /\/src\/[^?#]+/.exec(f.url)?.[0];
          if (source && frames.length < 6)
            frames.push(`${f.functionName || "(anonymous)"} ${source}:${f.lineNumber + 1}`);
        }
      pass.reloadInitiators.push(frames);
    }
  });
  cdp.on("Network.loadingFinished", (p) => {
    counters.finished++;
    counters.inflight.delete(p.requestId);
    const entry = log.byId.get(p.requestId);
    if (entry) Object.assign(entry, { done: true, doneAt: Date.now() });
  });
  cdp.on("Network.responseReceived", (p) => {
    const entry = log.byId.get(p.requestId);
    if (entry) entry.status = p.response.status;
    if (p.response.status >= 400) {
      counters.httpErrors++;
      recordNetworkError({ status: p.response.status, resourceType: p.type });
    }
  });
  cdp.on("Network.loadingFailed", (p) => {
    counters.inflight.delete(p.requestId);
    const entry = log.byId.get(p.requestId);
    if (entry)
      Object.assign(entry, {
        done: true,
        doneAt: Date.now(),
        failed: !p.canceled,
        errorText: p.errorText,
      });
    // Aborts from superseded work are cancellations, not failures.
    if (p.canceled) return;
    counters.failed++;
    recordNetworkError({ resourceType: p.type, failed: true });
  });
  cdp.on("Runtime.consoleAPICalled", (p) => {
    if (p.type === "error") counters.consoleErrors++;
  });
  cdp.on("Runtime.exceptionThrown", () => counters.exceptions++);
  // Reasons only (for example "reload" or "scriptInitiated"), never URLs.
  pass.navigationRequests = {};
  cdp.on("Page.frameRequestedNavigation", (p) => {
    const key = `${p.reason}/${p.disposition}`;
    pass.navigationRequests[key] = (pass.navigationRequests[key] ?? 0) + 1;
  });
}
// What a debugger needs to see why a page missed its budget or artwork stalled:
// unresolved artwork by cause and site, and the requests still open by type and site.
async function diagnose(pass, stage, since) {
  const log = pass.requestLog;
  const now = Date.now();
  // Every request this visit made, per site: shows serial chains of short
  // requests that no single open request would reveal.
  const made = new Map();
  for (const r of log.byId.values()) {
    if (r.startedAt < since) continue;
    const key = `${r.type ?? "Other"} ${siteOf(r.url)}`;
    const g = made.get(key) ?? { request: key, count: 0, open: 0, failed: 0, longestMs: 0 };
    g.count++;
    if (!r.done) g.open++;
    if (r.failed || r.status >= 400) g.failed++;
    g.longestMs = Math.max(g.longestMs, (r.doneAt ?? now) - r.startedAt);
    made.set(key, g);
  }
  const items = await evaluate(artworkDiagnosis).catch(() => []);
  const inflight = new Map();
  for (const id of pass.counters.inflight) {
    const r = log.byId.get(id);
    if (!r) continue;
    const key = `${r.type ?? "Other"} ${siteOf(r.url)}`;
    const g = inflight.get(key) ?? { request: key, count: 0, oldestMs: 0 };
    g.count++;
    g.oldestMs = Math.max(g.oldestMs, now - r.startedAt);
    inflight.set(key, g);
  }
  return {
    stage,
    busyIndicators: await evaluate(busyDiagnosis).catch(() => []),
    unresolvedArtwork: items.length,
    artwork: explainArtwork(items, (url) => log.byUrl.get(url), now),
    inflight: [...inflight.values()].sort((a, b) => b.oldestMs - a.oldestMs).slice(0, 12),
    requestsDuringVisit: [...made.values()].sort((a, b) => b.count - a.count).slice(0, 12),
  };
}
const counterSnapshot = (pass) => ({
  requests: pass.counters.requests,
  failed: pass.counters.failed,
  httpErrors: pass.counters.httpErrors,
  consoleErrors: pass.counters.consoleErrors,
  exceptions: pass.counters.exceptions,
});
async function activate(view, pointer) {
  if (!pointer) return evaluate(activateView, view);
  const point = await evaluate(navControlPoint, view);
  if (!point) return null;
  // Real pointer input lets hover intent warm the destination, as in the app.
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
  await pause(400);
  const at = await evaluate(() => {
    window.__harborBench.frames.clickAt = null;
    return performance.now();
  });
  for (const type of ["mousePressed", "mouseReleased"])
    await cdp.send("Input.dispatchMouseEvent", {
      type,
      x: point.x,
      y: point.y,
      button: "left",
      clickCount: 1,
    });
  return at;
}
async function visit(view, phase, pass, { pointer = false, full = true, quietMs: holdMs = 0 } = {}) {
  const result = {
    view,
    phase,
    status: "running",
    valid: false,
    navigationMs: null,
    dataReadyMs: null,
    viewportReadyMs: null,
    fullCoverageMs: null,
    coverageMode: full ? "full" : "viewport",
  };
  pass.views.push(result);
  process.stdout.write(`[${stamp()}] [${pass.name}] ${view} (${phase})\n`);
  try {
    const visibility = await ensureVisible();
    if (visibility.recovered) result.visibilityRecoveredBeforeVisit = visibility;
    await until(() => evaluate(preparePage), 60000, "page shell");
  } catch (error) {
    if (stopping) throw new Error("Benchmark interrupted");
    result.status = error.blocker ? "visibility-blocker" : "page-unavailable";
    result.blocker = error.blocker;
    return result;
  }
  const timeOrigin = await evaluate(() => performance.timeOrigin);
  const before = counterSnapshot(pass);
  const visitStarted = Date.now();
  const profiled = profiledVisits.has(`${view}:${phase}`);
  if (profiled) {
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.setSamplingInterval", { interval: 250 });
    await cdp.send("Profiler.start");
  }
  const begin = await activate(view, pointer);
  if (begin === null) {
    if (profiled) await cdp.send("Profiler.stop");
    result.status = "control-unavailable";
    return result;
  }
  if (holdMs > 0) await pause(holdMs);
  const seen = new Map();
  // Harbor's diagnostic ring buffer can overflow during a cold resolve, so
  // Calendar events are accumulated across polls rather than read at the end.
  const calendarEvents = new Map();
  let stage = "switch",
    state,
    lastChange = begin,
    signature = "",
    stepStarted = 0,
    stalledSteps = 0,
    // A spinner that already outlasted one stall window is not waited for again.
    busyStuck = false,
    coverage = null,
    dataSince = null,
    framesStart = null,
    probeMaxMs = 0;
  // Artwork already seen stalled is not waited for again after each scroll.
  const stuck = new Set();
  const dataDeadline = Date.now() + limits.dataTimeoutMs;
  let coverageDeadline = Infinity;
  // First-seen and loaded times are poll times, so image timings resolve to
  // about one poll (~100 ms).
  const record = (items, now) =>
    items.forEach((item) => {
      const prev = seen.get(item.id);
      seen.set(item.id, {
        ...prev,
        ...item,
        firstSeenAt: prev?.firstSeenAt ?? now,
        loadedAt: prev?.loadedAt ?? (item.loaded ? now : null),
      });
    });
  while (!stopping) {
    if (stage !== "coverage" && Date.now() > dataDeadline) {
      result.status = `${stage}-timeout`;
      break;
    }
    if (Date.now() > coverageDeadline) {
      result.status = "coverage-timeout";
      break;
    }
    if (limits.pageBudgetMs && Date.now() - visitStarted > limits.pageBudgetMs) {
      // Missing the page budget is a major app finding, not a harness failure;
      // a view that never opened is still an invalid sample.
      result.overBudget = { stage, budgetMs: limits.pageBudgetMs };
      result.diagnosis = await diagnose(pass, stage, visitStarted);
      result.status = stage === "switch" ? "switch-timeout" : "measured";
      break;
    }
    state = await evaluate(pageState, view);
    probeMaxMs = Math.max(probeMaxMs, state.probeMs);
    if (state.timeOrigin !== timeOrigin) {
      result.status = "page-reloaded";
      break;
    }
    framesStart ??= { count: state.frames.count, at: state.now };
    if (state.visibility !== "visible") {
      result.status = "visibility-interrupted";
      try {
        result.visibilityRecovery = await ensureVisible();
      } catch (error) {
        result.status = "visibility-blocker";
        result.blocker = error.blocker;
      }
      break;
    }
    if (stage === "switch") {
      // The destination's diagnostic view and a replaced layer with content
      // must both be present; the previous view's layer is never accepted.
      if (state.activeView !== view || !state.layerReplaced || !state.mounted) {
        await pause(50);
        continue;
      }
      result.navigationMs = state.now - begin;
      result.navActive = state.navActive;
      stage = "data";
      lastChange = state.now;
    }
    if (state.activeView !== view) {
      result.status = "view-changed";
      break;
    }
    // A Calendar error is an app finding; the view may still finish loading.
    if (state.calendar?.error) result.calendarErrorSeen = true;
    if (state.calendar?.error && !state.calendar.loading && !state.calendar.complete) {
      result.calendarError = true;
      result.diagnosis = await diagnose(pass, stage, visitStarted);
      result.status = "measured";
      break;
    }
    if (state.calendar?.complete && result.calendarCompleteMs == null)
      result.calendarCompleteMs = state.now - begin;
    if (state.calendar && !state.calendar.complete) result.calendarCompleteMs = null;
    const nextSignature = JSON.stringify([state.images, state.posters, state.calendar, state.busy]);
    if (nextSignature !== signature) {
      signature = nextSignature;
      lastChange = state.now;
    }
    for (const e of state.calendarEvents ?? []) calendarEvents.set(e.sequence, e);
    record(
      state.images.map((i) => ({ ...i, kind: "image" })),
      state.now,
    );
    record(
      state.posters.map((p) => ({ ...p, kind: "poster" })),
      state.now,
    );
    const pendingIds = [
      ...state.images.filter((i) => i.pending).map((i) => `image:${i.id}`),
      ...state.posters.filter((p) => !p.loaded && !p.unavailable).map((p) => `poster:${p.id}`),
    ];
    const pending = pendingIds.filter((id) => !stuck.has(id)).length;
    if (stage === "data") {
      const ready =
        view === "calendar"
          ? state.calendar?.complete && !state.calendar.loading
          : view === "home"
            ? state.homeSections.length === 3 && !state.busy
            : state.startPage || !state.busy;
      if (!ready) dataSince = null;
      else dataSince ??= state.now;
      // Calendar completion must survive a quiet window; a stale snapshot can
      // briefly report complete before the network publish replaces it.
      if (ready && state.now - dataSince >= (view === "calendar" ? quietMs : 0)) {
        result.dataReadyMs = dataSince - begin;
        result.startPage = state.startPage;
        stage = "viewport";
      }
    }
    // Artwork that has not changed for the stall window will not resolve on
    // its own; it is recorded as an app finding and the visit moves on.
    const stalled = state.now - lastChange >= limits.stallMs;
    if (stalled && state.busy && stage !== "data") busyStuck = true;
    const idle = busyStuck || !state.busy;
    if (stage === "viewport") {
      const settled =
        idle &&
        imageSettlement({
          mountedAt: begin + result.navigationMs,
          lastChangeAt: lastChange,
          pending,
          now: state.now,
          quietMs,
        });
      if (settled || stalled) {
        if (settled) result.viewportReadyMs = lastChange - begin;
        else {
          result.viewportStalled = { pending, busy: state.busy };
          result.diagnosis ??= await diagnose(pass, "viewport", visitStarted);
          pendingIds.forEach((id) => stuck.add(id));
        }
        result.viewport = {
          images: state.images.length,
          posters: state.posters.length,
          loaded:
            state.images.filter((i) => i.loaded).length +
            state.posters.filter((p) => p.loaded).length,
          unavailablePosters: state.unavailablePosters,
        };
        if (!full) {
          result.status = "measured";
          break;
        }
        stage = "coverage";
        coverageDeadline = Date.now() + limits.coverageTimeoutMs;
        stepStarted = state.now;
        lastChange = state.now;
      }
    } else if (stage === "coverage") {
      const settled =
        idle &&
        imageSettlement({
          mountedAt: stepStarted,
          lastChangeAt: lastChange,
          pending,
          now: state.now,
          quietMs: stepQuietMs,
        });
      if (settled || stalled) {
        if (!settled) {
          stalledSteps++;
          result.diagnosis ??= await diagnose(pass, "coverage", visitStarted);
          pendingIds.forEach((id) => stuck.add(id));
        }
        coverage = await evaluate(coverageStep, limits);
        if (coverage.done) {
          result.fullCoverageMs = (settled ? lastChange : state.now) - begin;
          result.status = "measured";
          break;
        }
        stepStarted = state.now;
        lastChange = state.now;
      }
    }
    await pause(100);
  }
  if (stopping) result.status = "interrupted";
  const end = state?.now ?? begin;
  if (state) {
    result.confirmedActiveView = state.activeView;
    result.viewMarker = state.viewMarker;
    result.documentVisibility = state.visibility;
    result.coverage = coverage && { ...coverage, stalledSteps };
    const all = [...seen.values()];
    const images = all.filter((i) => i.kind === "image"),
      posters = all.filter((i) => i.kind === "poster");
    result.artwork = {
      images: images.length,
      imagesLoaded: images.filter((i) => i.loaded).length,
      imagesFailed: images.filter((i) => i.failed).length,
      imagesPending: images.filter((i) => i.pending && !i.loaded).length,
      posters: posters.length,
      postersLoaded: posters.filter((p) => p.loaded).length,
      postersUnavailable: posters.filter((p) => p.unavailable && !p.loaded).length,
      postersPending: posters.filter((p) => !p.loaded && !p.unavailable).length,
    };
    if (view === "home") result.homeSections = state.homeSections;
    if (state.calendar) {
      result.calendar = state.calendar;
      result.calendarEvents = [...calendarEvents.values()]
        .sort((a, b) => a.sequence - b.sequence)
        .map(({ name, fields }) => ({ name, fields }));
    }
    const inWindow = (list) => list.filter((t) => t.at >= begin && t.at <= end + 1);
    const tasks = inWindow(state.tasks),
      gaps = inWindow(state.gaps),
      frameGaps = inWindow(state.frames.gaps);
    result.longTasks = { count: tasks.length, maxMs: Math.max(0, ...tasks.map((t) => t.duration)) };
    result.eventLoopStalls = {
      count: gaps.length,
      maxMs: Math.max(0, ...gaps.map((t) => t.duration)),
    };
    result.frameGaps = {
      count: frameGaps.length,
      maxMs: Math.max(0, ...frameGaps.map((t) => t.duration)),
    };
    const { clickAt, afterClick, countAtClick } = state.frames;
    if (clickAt != null && afterClick != null) result.clickToFrameMs = afterClick - clickAt;
    const from = clickAt ?? framesStart?.at ?? begin;
    const worst = (state.frames.long ?? [])
      .filter((f) => f.at + f.duration >= from && f.at <= end + 1)
      .sort((a, b) => b.duration - a.duration)[0];
    result.worstFrame = worst && {
      startMs: Math.round(worst.at - from),
      durationMs: Math.round(worst.duration),
      scriptMs: Math.round(worst.scriptMs),
      forcedLayoutMs: Math.round(worst.forcedLayoutMs),
      styleLayoutMs: Math.round(worst.styleLayoutMs),
      renderMs: Math.round(worst.renderMs),
      scripts: worst.scripts,
    };
    // Measured from the click itself; the first poll is the fallback.
    result.smoothness = smoothness(
      state.frames,
      clickAt != null ? { count: countAtClick, at: clickAt } : framesStart,
      end,
    );
    result.imageTiming = imageTiming(all, begin);
    result.diagnosticsOverwritten = state.diagnosticsOverwritten;
    // Harness probes run on the measured main thread; expose their worst cost.
    result.probeMaxMs = probeMaxMs;
  }
  const after = counterSnapshot(pass);
  result.network = {
    requests: after.requests - before.requests,
    failed: after.failed - before.failed,
    httpErrors: after.httpErrors - before.httpErrors,
    inflightAtEnd: pass.counters.inflight.size,
  };
  result.console = {
    errors: after.consoleErrors - before.consoleErrors,
    exceptions: after.exceptions - before.exceptions,
  };
  if (result.status === "measured") {
    const content = await evaluate(contentEvidence);
    if (content) {
      const { imageSourceHashes, ...rest } = content;
      result.content = { ...rest, imageSources: imageSourceHashes.length };
      // Hashes stay in memory for comparisons and are never written out.
      sourceHashes.set(`${pass.name}:${view}:${phase}`, imageSourceHashes);
    }
  }
  if (profiled) {
    const { profile } = await cdp.send("Profiler.stop");
    result.cpuProfile = `profile-${pass.name}-${view}-${phase}.cpuprofile`;
    await writeFile(path.join(runDir, result.cpuProfile), JSON.stringify(profile));
  }
  result.elapsedMs = Date.now() - visitStarted;
  Object.assign(result, summarizeVisit(result));
  await evaluate(resetScroll).catch(() => {});
  await writeFile(path.join(runDir, "report.json"), JSON.stringify(report, null, 2));
  return result;
}
// Frame rate and stutter from the click to the end of the visit.
function smoothness(frames, start, end) {
  if (!start || end <= start.at) return null;
  const slow = (frames.slow ?? []).filter((f) => f.at > start.at && f.at <= end + 1);
  const seconds = (end - start.at) / 1000;
  return {
    fps: Math.round(((frames.count - start.count) / seconds) * 10) / 10,
    slowFrames: slow.length,
    maxFrameMs: Math.round(Math.max(0, ...slow.map((f) => f.duration))),
    // Time beyond a 60 Hz frame spent in slow frames.
    jankMs: Math.round(slow.reduce((n, f) => n + f.duration - 1000 / 60, 0)),
  };
}
// Click-to-loaded per artwork item, and how long each took once it was in the
// page. Items already loaded when first seen took at most one poll.
function imageTiming(items, begin) {
  const loaded = items.filter((i) => i.loadedAt != null);
  if (!loaded.length) return null;
  const sorted = (list) => list.sort((a, b) => a - b);
  const fromClick = sorted(loaded.map((i) => i.loadedAt - begin));
  const own = sorted(loaded.map((i) => i.loadedAt - i.firstSeenAt));
  const at = (list, q) => Math.round(list[Math.min(list.length - 1, Math.floor(q * list.length))]);
  return {
    loaded: loaded.length,
    firstMs: Math.round(fromClick[0]),
    medianMs: at(fromClick, 0.5),
    p95Ms: at(fromClick, 0.95),
    lastMs: Math.round(fromClick.at(-1)),
    loadMedianMs: at(own, 0.5),
    loadP95Ms: at(own, 0.95),
    loadMaxMs: Math.round(own.at(-1)),
  };
}
// Retries once after a recovered visibility interruption or a Vite reload,
// leaving the interrupted sample in the report as invalid.
async function measure(view, phase, pass, options) {
  let result = await visit(view, phase, pass, options);
  if (["visibility-interrupted", "page-reloaded"].includes(result.status)) {
    await until(() => evaluate(preparePage), 60000, "page shell").catch(() => {});
    const current = await evaluate(pageState, view).catch(() => null);
    if (current?.activeView === view)
      await visit(view === "home" ? "library" : "home", "recovery", pass);
    result = await visit(view, `${phase}-retry`, pass, options);
  }
  if (result.status === "visibility-blocker") pass.visibilityBlocker = result.blocker ?? true;
  return result;
}
async function exitSettings(pass) {
  let at = await evaluate(leaveSettings);
  const exit = { method: "back-control", ok: false };
  // Only some layouts render a Back button in Settings; Escape is Harbor's
  // global Back key, pressed here as real keyboard input.
  if (at === null) {
    exit.method = "escape-key";
    at = await evaluate(() => performance.now());
    for (const type of ["keyDown", "keyUp"])
      await cdp.send("Input.dispatchKeyEvent", {
        type,
        key: "Escape",
        code: "Escape",
        windowsVirtualKeyCode: 27,
        nativeVirtualKeyCode: 27,
      });
  }
  if (at !== null)
    exit.ok = await until(
      () =>
        evaluate(
          () =>
            window.__HARBOR_DEBUG__?.snapshot().activeView !== "settings" &&
            [...document.querySelectorAll("[data-harbor-nav]")].some(
              (e) => e.getClientRects().length > 0,
            ),
        ),
      15000,
      "settings exit",
    ).catch(() => false);
  pass.settingsExit = exit;
  return exit.ok;
}
// Page.navigate can answer late while the dev server builds render-blocking
// CSS; a navigation that already committed is fine, since callers wait for the
// page themselves. One that never commits is reported with where the page is
// stuck (path, load state and visibility only).
async function navigateTo(pathname) {
  try {
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${fixturePort}${pathname}` });
  } catch (error) {
    if (!/timed out/.test(error.message)) throw error;
    // The page can be too busy to answer while the dev server rebuilds after a source edit.
    let at = [];
    const committed = await until(
      async () => {
        at = await evaluate(() => [
          location.pathname,
          document.readyState,
          document.visibilityState,
        ]).catch((e) => [e.message]);
        return at[0] === pathname;
      },
      60000,
      "navigation commit",
    ).catch(() => false);
    if (committed) return;
    throw new Error(`Navigation to ${pathname} did not commit; page: ${at.join(" ")}`);
  }
}
async function openApp(pass, { cold }) {
  await navigateTo("/__benchmark-empty");
  await until(
    async () =>
      evaluate(
        () => location.pathname === "/__benchmark-empty" && document.readyState === "complete",
      ),
    30000,
    "empty fixture page",
  );
  pass.cacheBeforeApp = await evaluate(cacheEvidence);
  const empty =
    pass.cacheBeforeApp.localStorageEntries === 0 &&
    Object.keys(pass.cacheBeforeApp.databases).length === 0 &&
    pass.cacheBeforeApp.cacheStorageEntries === 0;
  if (cold && !empty) throw new Error("Cold cache isolation failed; refusing timing claims");
  pass.coldVerified = cold && empty;
  if (cold) await cdp.send("Network.clearBrowserCache");
  await navigateTo("/");
  // The browser fixture has no Tauri startup-ready command. Reveal its shell
  // after React mounts so the same controls as the desktop app are usable.
  const startedAt = Date.now();
  // Vite answers module requests with 5xx while it re-optimizes dependencies
  // and then relies on HMR to reload the page, which the benchmark config
  // disables. A failed module leaves the shell dead, so the page is reloaded.
  let scriptErrors = pass.scriptServerErrors;
  pass.shellReloads = 0;
  await until(
    async () => {
      if (pass.scriptServerErrors > scriptErrors && pass.shellReloads < 3) {
        await pause(2000);
        scriptErrors = pass.scriptServerErrors;
        pass.shellReloads++;
        await cdp.send("Page.reload");
        return false;
      }
      return evaluate(async () => {
        const root = document.getElementById("root");
        if (!root?.querySelector("[data-harbor-nav]")) return false;
        root.removeAttribute("data-startup-hidden");
        root.inert = false;
        document.getElementById("harbor-boot")?.remove();
        document.getElementById("harbor-boot-chrome")?.remove();
        if (
          ![...document.querySelectorAll("[data-harbor-nav]")].some(
            (e) => e.getClientRects().length > 0 && getComputedStyle(e).display !== "none",
          )
        )
          return false;
        if (!window.__HARBOR_DEBUG__)
          (await import("/src/lib/perf/diagnostics.ts")).installDiagnostics();
        return Boolean(window.__HARBOR_DEBUG__ && window.__HARBOR_BROWSER_PROFILE__?.libraryItems);
      });
    },
    90000,
    "visible navigation",
  );
  pass.shellReadyMs = Date.now() - startedAt;
  pass.profile = await evaluate(() => ({
    libraryItems: window.__HARBOR_BROWSER_PROFILE__.libraryItems,
    accountAddons: window.__HARBOR_BROWSER_PROFILE__.accountAddons,
    snapshotAgeHours: Math.max(
      0,
      (Date.now() - Date.parse(window.__HARBOR_BROWSER_PROFILE__.createdAt)) / 3600000,
    ),
  }));
  pass.configuredControls = await evaluate(configuredControls);
}
function newPass(name, kind) {
  const pass = {
    name,
    kind,
    views: [],
    networkErrors: [],
    networkErrorsOmitted: 0,
    scriptServerErrors: 0,
  };
  report.passes.push(pass);
  return pass;
}
async function finishPass(pass) {
  pass.cacheAfterApp = await evaluate(cacheEvidence).catch(() => null);
  pass.edgeInternalPagesClosed = cdp?.edgePagesClosed ?? 0;
  pass.totals = counterSnapshot(pass);
  delete pass.counters;
  await closeBrowser();
}
const usable = (pass) =>
  pass.configuredControls
    .filter((c) => c.control && !c.disabled)
    .map((c) => viewFor(c.id))
    .filter((v) => knownViews.includes(v) && !omittedViews.includes(v));
async function sweep(pass, phase, views, options) {
  for (const view of views) {
    if (stopping || pass.visibilityBlocker) return;
    await measure(view, phase, pass, options);
  }
}
async function demandPass() {
  const pass = newPass("cold-and-warm", "demand");
  await launch(demandProfile, true);
  trackPass(pass);
  await openApp(pass, { cold: true });
  const views = usable(pass);
  const middle = views.filter((v) => !["home", "calendar", "settings"].includes(v));
  // Calendar goes first, before any category visit can warm its data.
  await measure("calendar", "cold", pass);
  if (!pass.visibilityBlocker) await measure("home", "return", pass);
  if (!pass.visibilityBlocker) await measure("calendar", "warm-return", pass);
  if (!calendarOnly) {
    await sweep(pass, "first-visit", middle);
    if (views.includes("settings") && !pass.visibilityBlocker) {
      await measure("settings", "first-visit", pass);
      await exitSettings(pass);
    }
    await sweep(pass, "warm-return", ["home", ...middle], quick);
    if (views.includes("settings") && !pass.visibilityBlocker && pass.settingsExit?.ok) {
      await measure("settings", "warm-return", pass, quick);
      await exitSettings(pass);
    }
  }
  await finishPass(pass);
  return pass;
}
// Back-and-forth tab switches on a settled Home. Each switch is a normal visit,
// so it reports click → frame, switch, worst frame and smoothness like the others.
async function switchPass() {
  const pass = newPass("switch-ping-pong", "switch");
  await launch(demandProfile, true);
  trackPass(pass);
  await openApp(pass, { cold: true });
  await until(
    () => evaluate(pageState, "home").then((state) => state?.activeView === "home"),
    60000,
    "home to settle",
  );
  await pause(quietMs);
  for (const [index, view] of pingPong.entries()) {
    if (stopping || pass.visibilityBlocker) break;
    await measure(view, `ping-${index + 1}`, pass, quick);
    await pause(switchGapMs);
  }
  await finishPass(pass);
  return pass;
}
// Discover → Home → Discover within the app's idle-evict window, so each return
// lands on a Discover that is still mounted. Home is switched to without
// waiting for its data; only the Discover returns are measured.
async function fastReturnPass() {
  const pass = newPass("fast-return", "switch");
  await launch(demandProfile, true);
  trackPass(pass);
  await openApp(pass, { cold: true });
  await until(
    () => evaluate(pageState, "home").then((state) => state?.activeView === "home"),
    60000,
    "home to settle",
  );
  await pause(quietMs);
  await measure(fastReturnView, "first", pass, quick);
  await pause(5000);
  for (let i = 1; i <= 3; i++) {
    if (stopping || pass.visibilityBlocker) break;
    const current = await evaluate(pageState, fastReturnView);
    if (current?.activeView !== fastReturnView)
      throw new Error(`${fastReturnView} was not the active view before fast return ${i}`);
    const begin = await activate("home", true);
    if (begin === null) throw new Error("Home control unavailable for fast return");
    await pause(fastReturnGapMs);
    await measure(fastReturnView, `fast-return-${i}`, pass, {
      ...quick,
      pointer: true,
      quietMs: fastReturnQuietMs,
    });
    await pause(3000);
  }
  await finishPass(pass);
  return pass;
}
async function restartPass(first) {
  const pass = newPass("browser-and-server-restart", "demand");
  await launch(demandProfile, true);
  trackPass(pass);
  await openApp(pass, { cold: false });
  await measure("calendar", "restart", pass);
  if (!pass.visibilityBlocker) await measure("home", "restart", pass, quick);
  if (!calendarOnly) {
    const views = usable(pass).filter((v) => !["home", "calendar", "settings"].includes(v));
    await sweep(pass, "restart", views, quick);
    if (usable(pass).includes("settings") && !pass.visibilityBlocker) {
      await measure("settings", "restart", pass, quick);
      await exitSettings(pass);
    }
  }
  await finishPass(pass);
  report.comparisons.restart = compareContent(first, pass, sourceHashes);
  return pass;
}
async function warmingPass(first) {
  const pass = newPass("production-like-warming", "warming");
  await launch(warmingProfile, false);
  trackPass(pass);
  await openApp(pass, { cold: true });
  // Production warming runs from Home while idle. Wait until the network has
  // been quiet for 3 s (bounded), then measure the warmed destinations.
  const idleStart = Date.now();
  let quietSince = Date.now(),
    requests = pass.counters.requests;
  while (Date.now() - idleStart < limits.warmingIdleMs && !stopping) {
    if (pass.counters.inflight.size > 0 || pass.counters.requests !== requests) {
      quietSince = Date.now();
      requests = pass.counters.requests;
    }
    if (Date.now() - idleStart >= 5000 && Date.now() - quietSince >= 2000) break;
    await pause(250);
  }
  pass.warmingIdle = {
    waitedMs: Date.now() - idleStart,
    networkQuiet: Date.now() - quietSince >= 2000,
    requests: pass.counters.requests,
  };
  pass.cacheAfterWarming = await evaluate(cacheEvidence);
  const views = usable(pass);
  for (const view of warmedViews)
    if (views.includes(view) && !pass.visibilityBlocker)
      await measure(view, "after-warming", pass, { pointer: true, ...quick });
  await finishPass(pass);
  report.comparisons.warming = warmedViews.map((view) => {
    const demand = first.views.find(
      (v) => v.view === view && ["cold", "first-visit"].includes(v.phase) && v.valid,
    );
    const warmed = pass.views.find((v) => v.view === view && v.phase.startsWith("after-warming"));
    return {
      view,
      demandPhase: demand?.phase ?? null,
      demandNavigationMs: demand?.navigationMs ?? null,
      warmedNavigationMs: warmed?.valid ? warmed.navigationMs : null,
      demandViewportReadyMs: demand?.viewportReadyMs ?? null,
      warmedViewportReadyMs: warmed?.valid ? warmed.viewportReadyMs : null,
      demandCalendarCompleteMs: demand?.calendarCompleteMs ?? null,
      warmedCalendarCompleteMs: warmed?.valid ? (warmed.calendarCompleteMs ?? null) : null,
    };
  });
  return pass;
}
function finalizeCoverage() {
  const [first, restart] = report.passes;
  if (switchOnly || !first?.configuredControls) return;
  const configured = new Map(first.configuredControls.map((c) => [viewFor(c.id), c]));
  for (const view of knownViews) {
    const control = configured.get(view);
    const visits = report.passes.flatMap((p) =>
      p.views.filter((v) => v.view === view).map((v) => ({ pass: p.name, ...v })),
    );
    const entry = {
      view,
      configured: Boolean(control),
      control: omittedViews.includes(view)
        ? "omitted"
        : control
          ? control.control
            ? control.disabled
              ? "disabled"
              : "enabled"
            : "missing-button"
          : "not-configured",
      visits: visits.length,
      validVisits: visits.filter((v) => v.valid).length,
      phases: visits.map((v) => `${v.pass}/${v.phase}:${v.status}`),
    };
    report.categoryCoverage.push(entry);
    if (omittedViews.includes(view)) continue;
    if (control && control.control && !control.disabled && !calendarOnly && view !== "calendar") {
      for (const phase of ["first-visit-or-cold", "warm-return", "restart"]) {
        const want =
          phase === "first-visit-or-cold"
            ? (v) =>
                v.pass === first.name &&
                ["cold", "first-visit", "return"].includes(v.phase.replace(/-retry$/, ""))
            : phase === "warm-return"
              ? (v) => v.pass === first.name && v.phase.replace(/-retry$/, "") === "warm-return"
              : (v) => v.pass === restart?.name;
        if (view === "home" && phase === "first-visit-or-cold") continue;
        if (!visits.some((v) => want(v) && v.valid))
          report.missing.push(`${view}: no valid ${phase} measurement`);
      }
    } else if (control && (!control.control || control.disabled))
      report.missing.push(`${view}: navigation control ${entry.control}`);
  }
  // Calendar must be measured validly cold, on a warm return and after restart.
  for (const [phase, passName] of [
    ["cold", first.name],
    ["warm-return", first.name],
    ["restart", restart?.name],
  ])
    if (
      !report.passes.some(
        (p) =>
          p.name === passName &&
          p.views.some(
            (v) => v.view === "calendar" && v.valid && v.phase.replace(/-retry$/, "") === phase,
          ),
      )
    )
      report.missing.push(`calendar: no valid ${phase} measurement`);
  for (const pass of report.passes)
    for (const v of pass.views)
      for (const issue of v.issues ?? [])
        report.issues.push(`${pass.name}/${v.view}/${v.phase}: ${issue}`);
}
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    stopping = true;
    void cdp?.send("Browser.close").catch(() => {});
  });
try {
  await mkdir(runDir, { recursive: true });
  if (!existsSync(path.join(root, ".diag/browser-inject.json")))
    throw new Error("Run diag:browser-profile to prepare your real profile snapshot first");
  // The restart pass must reuse the same origin, or persisted storage is
  // invisible to it; both ports therefore stay fixed for the whole run.
  fixturePort = await freePort();
  vitePort = await freePort();
  await servers();
  mark("servers ready");
  if (fastReturn) {
    await fastReturnPass();
    mark("fast-return done");
  } else if (switchOnly) {
    await switchPass();
    mark("switch-ping-pong done");
  } else {
    const first = await demandPass();
    mark("cold-and-warm done");
    if (stopping) throw new Error("Benchmark interrupted");
    await restartFixture("restart");
    mark("fixture restarted");
    if (!first.visibilityBlocker) await restartPass(first);
    mark("restart done");
    if (stopping) throw new Error("Benchmark interrupted");
    // Warming uses a fresh, empty browser profile on the running servers: the
    // installed app has no dev server to restart, so a warm one is closer to it.
    if (!first.visibilityBlocker && !calendarOnly) await warmingPass(first);
    mark("warming done");
  }
} catch (error) {
  report.status = stopping ? "interrupted" : "failed";
  // Messages are generated by this runner; page errors are withheld upstream.
  report.errors.push(String(error?.message ?? "Benchmark failed").slice(0, 200));
} finally {
  await cleanup();
  finalizeCoverage();
  if (report.status === "running")
    report.status =
      report.missing.length === 0 &&
      report.passes.length === (switchOnly ? 1 : calendarOnly ? 2 : 3) &&
      report.passes.every((p) => !p.visibilityBlocker && p.views.length > 0)
        ? "complete"
        : "incomplete";
  if (report.cleanup.some((c) => !c.exited)) report.status = "cleanup-failed";
  report.finishedAt = new Date().toISOString();
  report.durationMs = Date.now() - runStarted;
  report.timing = timingSummary(report);
  await writeFile(path.join(runDir, "report.json"), JSON.stringify(report, null, 2));
  const { renderMarkdown } = await import("./benchmark-report.mjs");
  await writeFile(path.join(runDir, "report.md"), renderMarkdown(report));
  console.log(`Benchmark ${report.status}: ${path.join(runDir, "report.md")}`);
  if (report.status !== "complete") process.exitCode = 1;
}
async function cleanup() {
  try {
    await closeBrowser();
  } catch {
    report.errors.push("Owned browser cleanup failed");
  }
  for (const proc of owned) {
    try {
      await stop(proc, "owned-process");
    } catch {
      report.errors.push("Owned process cleanup failed");
    }
  }
}
