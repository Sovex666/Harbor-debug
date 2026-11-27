#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { boundedNumber, Cdp, listTargets } from "./diagnostics/cdp.mjs";
export { Cdp, listTargets } from "./diagnostics/cdp.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const VIEWS = Object.freeze([
  "home",
  "settings",
  "anime",
  "discover",
  "catalogs",
  "plugins",
  "addons",
  "calendar",
  "movies",
  "shows",
  "music",
  "games",
  "kids",
  "library",
  "collections-hub",
  "live",
  "sports",
  "vod",
  "downloads",
  "wrapped",
  "manga",
  "ebook",
  "people",
]);

export function requireUnsafe() {
  if (process.env.HARBOR_DIAG_UNSAFE !== "1")
    throw new Error(
      "Sensitive command disabled. Set HARBOR_DIAG_UNSAFE=1 explicitly to enable arbitrary eval and heap snapshots; output may contain credentials, URLs, and private data.",
    );
}

async function evaluate(expression) {
  const cdp = await Cdp.connect();
  try {
    const result = await cdp.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails)
      throw new Error(
        "Harbor page evaluation failed; check that the diagnostics API is installed and ready",
      );
    return result.result?.value;
  } finally {
    cdp.close();
  }
}

export async function evalInPage(expression) {
  requireUnsafe();
  if (typeof expression !== "string" || !expression.trim() || expression.length > 65536)
    throw new Error("expression must contain 1–65536 characters");
  return evaluate(expression);
}

export async function pages() {
  return (await listTargets()).map((_, index) => ({ index, harbor: true }));
}

export async function contextIdentity(expectedNonce = process.env.HARBOR_DIAG_RUN_NONCE) {
  const cdp = await Cdp.connect({ requireIdentity: true, expectedNonce });
  try {
    return { supported: true, appId: cdp.identity.appId, windowRole: cdp.identity.windowRole };
  } finally {
    cdp.close();
  }
}

// Fixed projection: the debug API owns redaction of its bounded event ring. The transport
// additionally removes unrecognized fields and all free-text strings before returning it.
const SAFE_KEYS = new Set(
  `
  version startedAt capturedAt activeView retention overwritten returnedEvents name fields
  totalMs maxMs bytes cached error cancelled hit candidates series movies enabled supported
  persistent position load live normalized allowPaused advancing cacheSeconds
  navigation view topKind stackKinds navDepth canGoBack canGoForward playing paused buffering
  active visible counts counters events performance timing memory playback calendar diagnostics
  durationMs timestamp timeMs elapsedMs ageMs count total dropped limit capacity size nodes imgs
  imgsLoaded videos canvases jsHeapMB estImgDecodeMB estCanvasMB longTasks longTaskCount
  longTaskDurationMs frameCount fps frames droppedFrames totalFrames ready status reason state
  kind type at ms duration startTime totalDurationMs maxDurationMs averageDurationMs p50Ms p95Ms
  renderCount commitCount mounts unmounts requests failures pending cacheSize cacheHits
  cacheMisses items days loading errorCount errors warnings sequence navigationCount
  transitionCount mountedLayers activeLayers parkedLayers traces samples metrics totals maximum
  average latest resources resourceCount transferSize encodedBodySize decodedBodySize
  domContentLoadedMs loadMs responseMs uptimeMs
  hasSnapshot high rssMB local insecure fallback
  navigationId rows resolved complete failed stopped suppressed cache cause event retry
  underrun gapMs decoder frameDrops idle
`
    .trim()
    .split(/\s+/),
);
const SAFE_EVENT_NAMES = new Set([
  "calendar.library.candidates",
  "calendar.library.resolve",
  "calendar.load",
  "calendar.cache",
  "calendar.library.partial",
  "calendar:fetch",
  "ui:longtask",
  "ui:event-loop-stall",
  "image:loaded",
  "image:queue",
  "image:error",
  "image:proxy",
  "image:fetch",
  "image:disk-lookup",
  "image:base64-decode",
  "image:memory-hit",
  "image:failure-cached",
  "image:coalesced",
  "runtime:error",
  "runtime:unhandled-rejection",
  "runtime:started",
  "playback:audio-reload",
  "playback:audio-resync",
  "playback:failure",
  "playback:buffering",
  "playback:end-file",
  "playback:file-loaded",
  "playback:loaded",
  "playback:restart",
  "playback:load",
  "playback:timer-gap",
  "playback:wake-reconnect",
  "playback:wake-reconnect-error",
  "image:art-error",
  "memory:pressure",
  "navigation:scroll-memory",
  "view:discover:mount",
  "view:home:mount",
  ...["img", "fetch", "xmlhttprequest", "script", "css", "other"].map((kind) => `resource:${kind}`),
  ...["direct", "directfail", "harborfetch", "pluginhttp"].flatMap((kind) =>
    ["ok", "error", "timeout", "abort"].map((outcome) => `bridge:${kind}:${outcome}`),
  ),
  ...VIEWS.flatMap((view) =>
    ["requested", "superseded", "shell-paint", "first-paint"].map((phase) => `navigation:${view}:${phase}`),
  ),
]);
const SAFE_STRINGS = new Set([
  ...VIEWS,
  "player",
  "picker",
  "meta",
  "episode-detail",
  "collections",
  "queue",
  "addon-detail",
  "person",
  "profile",
  "feed",
  "groups",
  "group",
  "list",
  "collection",
  "service",
  "grid",
  "filter",
  "brands",
  "folder-hub",
  "match-detail",
  "award",
  "anime-award",
  "curated-list",
  "idle",
  "loading",
  "ready",
  "playing",
  "paused",
  "buffering",
  "stopped",
  "error",
  "unsupported",
  "hidden",
  "visible",
  "active",
  "parked",
]);
export function safeState(value, depth = 0, key = "") {
  if (depth > 8) return undefined;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && key === "name")
    return SAFE_EVENT_NAMES.has(value) ? value : undefined;
  if (typeof value === "string")
    return [
      "activeView",
      "view",
      "topKind",
      "stackKinds",
      "state",
      "status",
      "kind",
      "type",
    ].includes(key) && SAFE_STRINGS.has(value)
      ? value
      : undefined;
  if (Array.isArray(value))
    return value
      .slice(-200)
      .map((item) => safeState(item, depth + 1, key))
      .filter((item) => item !== undefined);
  if (!value || typeof value !== "object") return undefined;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([name]) => SAFE_KEYS.has(name))
      .map(([name, item]) => [name, safeState(item, depth + 1, name)])
      .filter(([, item]) => item !== undefined),
  );
}

async function debugCall(method, argument) {
  const result = await evaluate(`(async () => {
    const api = window.__HARBOR_DEBUG__;
    if (!api || api.version !== 1 || typeof api[${JSON.stringify(method)}] !== "function") return { supported: false };
    const value = await api[${JSON.stringify(method)}](${argument === undefined ? "" : JSON.stringify(argument)});
    return { supported: true, value };
  })()`);
  if (!result?.supported)
    throw new Error(
      "Harbor diagnostics API v1 unavailable. Run a development build exposing window.__HARBOR_DEBUG__ with snapshot(), clear(), and navigate(view); reload the Harbor page after updating.",
    );
  return result.value;
}

export async function state() {
  const snapshot = await debugCall("snapshot");
  if (
    !snapshot ||
    typeof snapshot !== "object" ||
    Array.isArray(snapshot) ||
    snapshot.version !== 1
  )
    throw new Error(
      "Harbor diagnostics snapshot must be an object with version: 1; update the frontend diagnostics API",
    );
  return safeState(snapshot);
}
export async function clear() {
  await debugCall("clear");
  return { cleared: true };
}
export async function navigate(view) {
  if (!VIEWS.includes(view)) throw new Error(`view must be one of: ${VIEWS.join(", ")}`);
  await debugCall("navigate", view);
  return { requestedView: view, accepted: true };
}

export async function performanceSummary() {
  const result = await evaluate(`(async () => {
    const navigation = performance.getEntriesByType("navigation")[0];
    const resources = performance.getEntriesByType("resource");
    const paints = performance.getEntriesByType("paint");
    const memory = performance.memory;
    const round = (value) => Number.isFinite(value) ? Math.round(value * 10) / 10 : null;
    const api = window.__HARBOR_DEBUG__;
    const supported = api?.version === 1 && typeof api.snapshot === "function";
    const diagnostics = supported ? await api.snapshot() : null;
    return { supported, diagnostics, browser: {
      uptimeMs: round(performance.now()),
      navigation: navigation ? {
        responseMs: round(navigation.responseEnd - navigation.requestStart),
        domContentLoadedMs: round(navigation.domContentLoadedEventEnd),
        loadMs: round(navigation.loadEventEnd),
      } : null,
      paint: {
        firstPaintMs: round(paints.find((entry) => entry.name === "first-paint")?.startTime),
        firstContentfulPaintMs: round(paints.find((entry) => entry.name === "first-contentful-paint")?.startTime),
      },
      resources: { count: resources.length, transferBytes: resources.reduce((sum, entry) => sum + entry.transferSize, 0), durationMs: round(resources.reduce((sum, entry) => sum + entry.duration, 0)) },
      memory: memory ? { usedJSHeapMB: round(memory.usedJSHeapSize / 1048576), totalJSHeapMB: round(memory.totalJSHeapSize / 1048576) } : null,
    } };
  })()`);
  return {
    ...result.browser,
    diagnostics: result.supported
      ? safeState(result.diagnostics)
      : {
          supported: false,
          reason:
            "Install the Harbor diagnostics API v1 for app event and metric summaries; browser timing remains available",
        },
  };
}

export const COUNTS_EXPR = `(() => {
  const imgs = [...document.images];
  const loaded = imgs.filter((i) => i.currentSrc && i.naturalWidth > 0);
  const est = loaded.reduce((s, i) => s + i.naturalWidth * i.naturalHeight * 4, 0);
  const canv = [...document.querySelectorAll("canvas")];
  const canvPx = canv.reduce((s, c) => s + c.width * c.height * 4, 0);
  const m = performance.memory;
  return {
    nodes: document.querySelectorAll("*").length,
    imgs: imgs.length,
    imgsLoaded: loaded.length,
    estImgDecodeMB: +(est / 1048576).toFixed(1),
    videos: document.querySelectorAll("video").length,
    canvases: canv.length,
    estCanvasMB: +(canvPx / 1048576).toFixed(1),
    jsHeapMB: m ? +(m.usedJSHeapSize / 1048576).toFixed(1) : null,
  };
})()`;

export const LAYERS_EXPR = `(() => {
  const active = document.querySelector(".harbor-layer-active");
  const stack = active ? active.parentElement : null;
  if (!stack) return { error: "layer stack not found" };
  const rows = [...stack.children].map((c, i) => {
    const cs = getComputedStyle(c);
    const imgs = [...c.querySelectorAll("img")];
    const loaded = imgs.filter((x) => x.currentSrc && x.naturalWidth > 0);
    const est = loaded.reduce((s, x) => s + x.naturalWidth * x.naturalHeight * 4, 0);
    return {
      i,
      active: c.classList.contains("harbor-layer-active"),
      display: cs.display,
      visibility: cs.visibility,
      contentVisibility: cs.contentVisibility ?? "",
      nodes: c.querySelectorAll("*").length,
      imgs: imgs.length,
      loaded: loaded.length,
      estMB: +(est / 1048576).toFixed(1),
      videos: c.querySelectorAll("video").length,
    };
  });
  const inStack = rows.reduce((s, r) => s + r.imgs, 0);
  return { rows, imgsOutsideStack: document.images.length - inStack };
})()`;

export const BIGIMGS_EXPR = `(() =>
  [...document.images]
    .filter((i) => i.currentSrc && i.naturalWidth > 0)
    .map((i) => ({
      mb: +((i.naturalWidth * i.naturalHeight * 4) / 1048576).toFixed(2),
      px: i.naturalWidth + "x" + i.naturalHeight,
    }))
    .sort((a, b) => b.mb - a.mb)
    .slice(0, 25))()`;

export function rss() {
  if (process.platform !== "win32") return unixRss();
  const ps = [
    "$procs = Get-CimInstance Win32_Process -Filter \"Name='msedgewebview2.exe' or Name='Harbor.exe'\";",
    "$rows = foreach ($w in $procs) {",
    "  if ($w.Name -eq 'msedgewebview2.exe' -and $w.CommandLine -notmatch 'Harbor') { continue }",
    "  $p = Get-Process -Id $w.ProcessId -ErrorAction SilentlyContinue; if (-not $p) { continue }",
    "  $type = 'browser'; if ($w.CommandLine -match '--type=([a-z-]+)') { $type = $Matches[1] }",
    "  if ($w.Name -eq 'Harbor.exe') { $type = 'harbor-exe' }",
    "  [PSCustomObject]@{ pid = $w.ProcessId; type = $type; wsMB = [math]::Round($p.WorkingSet64 / 1MB); privMB = [math]::Round($p.PrivateMemorySize64 / 1MB) }",
    "}",
    "@($rows) | ConvertTo-Json -Depth 3",
  ].join(" ");
  const out = spawnSync("powershell", ["-NoProfile", "-Command", ps], {
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (out.error || out.status !== 0)
    return { error: "Windows RSS collection failed; ensure PowerShell is installed" };
  let rows = [];
  try {
    rows = JSON.parse(out.stdout || "[]");
  } catch {
    return { error: "RSS response could not be parsed" };
  }
  if (!Array.isArray(rows)) rows = rows ? [rows] : [];
  const roles = new Set([
    "browser",
    "renderer",
    "gpu-process",
    "utility",
    "harbor-exe",
    "crashpad-handler",
  ]);
  rows = rows
    .filter(
      (row) =>
        Number.isInteger(row?.pid) && Number.isFinite(row.wsMB) && Number.isFinite(row.privMB),
    )
    .map((row) => ({
      pid: row.pid,
      type: roles.has(row.type) ? row.type : "other",
      wsMB: row.wsMB,
      privMB: row.privMB,
    }));
  const byType = {};
  for (const r of rows) {
    byType[r.type] = byType[r.type] ?? { count: 0, wsMB: 0, privMB: 0 };
    byType[r.type].count++;
    byType[r.type].wsMB += r.wsMB;
    byType[r.type].privMB += r.privMB;
  }
  const totalMB = rows.reduce((s, r) => s + r.wsMB, 0);
  return { totalMB, byType, procs: rows.sort((a, b) => b.wsMB - a.wsMB) };
}

function unixRss() {
  if (!["darwin", "linux"].includes(process.platform))
    return { error: "RSS is supported on Windows, macOS, and Linux" };
  const result = spawnSync("ps", ["-axo", "pid=,ppid=,rss=,comm="], {
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0)
    return { error: "RSS collection failed; ps is required" };
  const processes = result.stdout.split("\n").flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
    return match
      ? [
          {
            pid: Number(match[1]),
            ppid: Number(match[2]),
            rssKB: Number(match[3]),
            command: match[4],
          },
        ]
      : [];
  });
  const roots = processes.filter((row) =>
    /(?:^|\/)harbor(?:\.app\/Contents\/MacOS\/harbor)?$/i.test(row.command),
  );
  const selected = new Set(roots.map((row) => row.pid));
  let previous = -1;
  while (previous !== selected.size) {
    previous = selected.size;
    for (const row of processes) if (selected.has(row.ppid)) selected.add(row.pid);
  }
  const procs = processes
    .filter((row) => selected.has(row.pid))
    .map((row) => ({
      pid: row.pid,
      type: roots.some((root) => root.pid === row.pid) ? "harbor-exe" : "child",
      wsMB: Math.round((row.rssKB / 1024) * 10) / 10,
    }));
  return {
    totalMB: Math.round(procs.reduce((sum, row) => sum + row.wsMB, 0) * 10) / 10,
    procs,
    scope:
      "Harbor process and descendants; shared WebKit services and external Chromium preview excluded",
  };
}

export async function counts() {
  return evaluate(COUNTS_EXPR);
}

export async function layers() {
  return evaluate(LAYERS_EXPR);
}

export async function bigimgs() {
  return evaluate(BIGIMGS_EXPR);
}

export async function watch(seconds = 30, intervalSec = 5) {
  seconds = boundedNumber(seconds, "seconds", 1, 120);
  intervalSec = boundedNumber(intervalSec, "interval", 1, 30);
  if (intervalSec > seconds) throw new Error("interval must not exceed seconds");
  const ticks = Math.floor(seconds / intervalSec);
  const samples = [];
  const startedAt = performance.now();
  for (let i = 0; i <= ticks; i++) {
    const elapsedMs = performance.now() - startedAt;
    if (i > 0 && elapsedMs > seconds * 1000 + 10) break;
    const c = await counts().catch((e) => ({ error: e.message }));
    const r = rss();
    samples.push({
      t: +(elapsedMs / 1000).toFixed(2),
      ...(c.error ? { error: c.error } : {}),
      ...(r.error ? { rssError: r.error } : {}),
      jsHeapMB: c.jsHeapMB ?? null,
      nodes: c.nodes,
      imgsLoaded: c.imgsLoaded,
      estImgDecodeMB: c.estImgDecodeMB,
      rssTotalMB: r.totalMB ?? null,
    });
    const delayMs = startedAt + (i + 1) * intervalSec * 1000 - performance.now();
    if (i < ticks && delayMs > 0) await new Promise((res) => setTimeout(res, delayMs));
  }
  const first = samples[0];
  const last = samples[samples.length - 1];
  const delta = {};
  for (const k of ["jsHeapMB", "nodes", "imgsLoaded", "estImgDecodeMB", "rssTotalMB"]) {
    if (first[k] != null && last[k] != null) delta[k] = +(last[k] - first[k]).toFixed(1);
  }
  return { samples, delta };
}

export async function snapshot() {
  requireUnsafe();
  const cdp = await Cdp.connect();
  const dir = join(ROOT, ".diag");
  const file = join(dir, `heap-${Date.now()}.heapsnapshot`);
  let bytes = 0;
  let detachedRefs = 0;
  cdp.on("HeapProfiler.addHeapSnapshotChunk", ({ chunk }) => {
    bytes += chunk.length;
    detachedRefs += (chunk.match(/Detached /g) ?? []).length;
    appendFileSync(file, chunk);
  });
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, "", { mode: 0o600, flag: "wx" });
    await cdp.send("HeapProfiler.enable");
    await cdp.send("HeapProfiler.collectGarbage");
    await cdp.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false });
    await new Promise((r) => setTimeout(r, 600));
  } finally {
    cdp.close();
  }
  return { file, sizeMB: +(bytes / 1048576).toFixed(1), detachedRefs };
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const print = (v) => console.log(typeof v === "string" ? v : JSON.stringify(v, null, 2));
  switch (cmd) {
    case "pages":
      return print(await pages());
    case "identity":
      return print(await contextIdentity(args[0]));
    case "state":
      return print(await state());
    case "clear":
      return print(await clear());
    case "navigate":
      return print(await navigate(args[0]));
    case "perf":
      return print(await performanceSummary());
    case "eval":
      return print(await evalInPage(args.join(" ")));
    case "counts":
      return print(await counts());
    case "layers":
      return print(await layers());
    case "bigimgs":
      return print(await bigimgs());
    case "rss":
      return print(rss());
    case "watch":
      return print(await watch(Number(args[0] ?? 30), Number(args[1] ?? 5)));
    case "snapshot":
      return print(await snapshot());
    default:
      return print(
        "usage: harbor-diag <pages|identity [nonce]|state|clear|navigate <view>|perf|counts|layers|bigimgs|rss|watch [sec] [interval]|eval <js>|snapshot> (eval/snapshot require HARBOR_DIAG_UNSAFE=1)",
      );
  }
}

if (process.argv[1]?.endsWith("harbor-diag.mjs")) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
