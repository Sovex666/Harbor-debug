import { enqueueDiagnostic } from "../diagnostics/session";
import { imageReadinessFields } from "../image-readiness";

// Always-on numeric breadcrumbs; the detailed React/frame profiler remains opt-in.
// Never pass media identifiers, URLs, error messages, or account data here.
export type DiagnosticFields = Record<string, number | boolean>;
type Outcome = "ok" | "error" | "cancelled";
type Event = { sequence: number; at: number; name: string; fields: DiagnosticFields };
type Metric = { count: number; errors: number; totalMs: number; maxMs: number; recent: number[] };

const MAX_EVENTS = 2000;
const MAX_METRICS = 128;
const events: Event[] = [];
const metrics = new Map<string, Metric>();
let sequence = 0;
let cursor = 0;
let overwritten = 0;
let startedAt = Date.now();
let navigator: ((view: string) => void) | undefined;
let activeView: string | null = null;
let navigationId = 0;
let pendingNav: { view: string; at: number; navigationId: number } | undefined;
let stopCapture: (() => void) | undefined;

export const DEBUG_VIEWS = [
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
] as const;

function now(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

export function recordDiagnostic(name: string, fields: DiagnosticFields = {}): void {
  if (!/^[a-z][a-z0-9:._-]{0,95}$/.test(name)) return;
  const safe: DiagnosticFields = {};
  for (const [key, value] of Object.entries(fields).slice(0, 16)) {
    if (
      /^[a-zA-Z][a-zA-Z0-9_]{0,31}$/.test(key) &&
      (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)))
    ) {
      safe[key] =
        typeof value === "number" && Math.abs(value) < Number.MAX_SAFE_INTEGER / 100
          ? Math.round(value * 100) / 100
          : value;
    }
  }
  const entry = { sequence: ++sequence, at: Date.now(), name, fields: safe };
  enqueueDiagnostic(name, safe);
  if (events.length < MAX_EVENTS) events.push(entry);
  else {
    overwritten++;
    events[cursor] = entry;
    cursor = (cursor + 1) % MAX_EVENTS;
  }
  collectMetric(name, safe);
}

function collectMetric(name: string, safe: DiagnosticFields): void {
  let metric = metrics.get(name);
  if (!metric && metrics.size < MAX_METRICS) {
    metric = { count: 0, errors: 0, totalMs: 0, maxMs: 0, recent: [] };
    metrics.set(name, metric);
  }
  if (!metric) return;
  metric.count++;
  if (safe.error === true) metric.errors++;
  if (typeof safe.elapsedMs === "number") {
    metric.totalMs += safe.elapsedMs;
    metric.maxMs = Math.max(metric.maxMs, safe.elapsedMs);
    metric.recent.push(safe.elapsedMs);
    if (metric.recent.length > 64) metric.recent.shift();
  }
}

export function measureDiagnostic(name: string, fields: DiagnosticFields = {}) {
  const at = now();
  let finished = false;
  return (outcome: Outcome = "ok", extra: DiagnosticFields = {}): void => {
    if (finished) return;
    finished = true;
    recordDiagnostic(name, {
      ...fields,
      ...extra,
      elapsedMs: Math.max(0, now() - at),
      error: outcome === "error",
      cancelled: outcome === "cancelled",
    });
  };
}

export function diagnosticSnapshot() {
  return {
    version: 1,
    startedAt,
    capturedAt: Date.now(),
    activeView,
    retention: { capacity: MAX_EVENTS, overwritten, events: events.length },
    metrics: [...metrics].map(([name, m]) => {
      const sorted = m.recent.slice().sort((a, b) => a - b);
      const pct = (p: number) => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? 0;
      return {
        name,
        count: m.count,
        errors: m.errors,
        totalMs: Math.round(m.totalMs),
        maxMs: Math.round(m.maxMs),
        p50Ms: pct(0.5),
        p95Ms: pct(0.95),
        samples: sorted.length,
      };
    }),
    events: events
      .slice()
      .sort((a, b) => a.sequence - b.sequence)
      .map((event) => ({ ...event, fields: { ...event.fields } })),
  };
}

export function clearDiagnostics(): void {
  events.length = 0;
  metrics.clear();
  // Keep sequence monotonic so concurrent export acknowledgements cannot
  // mistake post-clear events for older captured events.
  cursor = 0;
  overwritten = 0;
  startedAt = Date.now();
}

/** Advance only after the native export succeeds; retain events arriving during its write. */
export function acknowledgeDiagnosticExport(throughSequence: number): void {
  const retained = events
    .filter((event) => event.sequence > throughSequence)
    .sort((a, b) => a.sequence - b.sequence);
  events.length = 0;
  events.push(...retained);
  cursor = 0;
  metrics.clear();
  for (const event of retained) collectMetric(event.name, event.fields);
  overwritten = 0;
  startedAt = retained[0]?.at ?? Date.now();
}

export function registerDiagnosticNavigator(fn: (view: string) => void): () => void {
  navigator = fn;
  return () => {
    if (navigator === fn) navigator = undefined;
  };
}

export function beginDiagnosticNavigation(view: string): void {
  if (!DEBUG_VIEWS.some((item) => item === view)) return;
  if (pendingNav)
    recordDiagnostic(`navigation:${pendingNav.view}:superseded`, {
      navigationId: pendingNav.navigationId,
    });
  pendingNav = { view, at: now(), navigationId: ++navigationId };
  recordDiagnostic(`navigation:${view}:requested`, { navigationId });
}

export function commitDiagnosticNavigation(view: string): () => void {
  activeView = DEBUG_VIEWS.some((item) => item === view) ? view : null;
  if (!pendingNav || pendingNav.view !== view || typeof requestAnimationFrame !== "function") {
    return () => {};
  }
  const nav = pendingNav;
  let second = 0;
  const first = requestAnimationFrame(() => {
    second = requestAnimationFrame(() => {
      if (pendingNav !== nav) return;
      pendingNav = undefined;
      // A shell paint is distinct from provider data and image readiness.
      recordDiagnostic(`navigation:${view}:shell-paint`, {
        elapsedMs: now() - nav.at,
        navigationId: nav.navigationId,
      });
    });
  });
  return () => {
    cancelAnimationFrame(first);
    cancelAnimationFrame(second);
  };
}

declare global {
  interface Window {
    __HARBOR_DEBUG__?: {
      version: 1;
      snapshot: typeof diagnosticSnapshot;
      clear: typeof clearDiagnostics;
      navigate: (view: string) => { requested: string };
      views: readonly string[];
    };
  }
}

export function installDiagnostics(): () => void {
  if (typeof window === "undefined") return () => {};
  if (stopCapture) return stopCapture;
  window.__HARBOR_DEBUG__ = {
    version: 1,
    snapshot: diagnosticSnapshot,
    clear: clearDiagnostics,
    views: DEBUG_VIEWS,
    navigate(view) {
      if (!DEBUG_VIEWS.some((item) => item === view)) throw new Error("Unknown Harbor view");
      if (!navigator) throw new Error("Harbor navigation is not ready in this window");
      navigator(view);
      return { requested: view };
    },
  };
  const observers: PerformanceObserver[] = [];
  if (typeof PerformanceObserver !== "undefined") {
    for (const type of ["longtask", "resource"]) {
      if (!PerformanceObserver.supportedEntryTypes?.includes(type)) continue;
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (type === "longtask") recordDiagnostic("ui:longtask", { elapsedMs: entry.duration });
          else {
            const resource = entry as PerformanceResourceTiming;
            const kind = ["img", "fetch", "xmlhttprequest", "script", "css"].includes(
              resource.initiatorType,
            )
              ? resource.initiatorType
              : "other";
            recordDiagnostic(`resource:${kind}`, {
              elapsedMs: entry.duration,
              bytes: resource.transferSize,
              cached: resource.transferSize === 0 && resource.decodedBodySize > 0,
            });
          }
        }
      });
      try {
        observer.observe({ type });
        observers.push(observer);
      } catch {
        observer.disconnect();
      }
    }
  }
  const resourceEvent = (event: globalThis.Event) => {
    if (event.target instanceof HTMLImageElement) {
      recordDiagnostic(
        event.type === "load" ? "image:loaded" : "image:error",
        imageReadinessFields(event.target),
      );
    } else if (event.type === "error") recordDiagnostic("runtime:error");
  };
  const rejected = () => recordDiagnostic("runtime:unhandled-rejection");
  let lastTick = now();
  const visibility = () => {
    lastTick = now();
  };
  const heartbeat = window.setInterval(() => {
    const at = now();
    if (document.visibilityState === "visible" && at - lastTick > 400) {
      recordDiagnostic("ui:event-loop-stall", { elapsedMs: at - lastTick - 250 });
    }
    lastTick = at;
  }, 250);
  window.addEventListener("load", resourceEvent, true);
  window.addEventListener("error", resourceEvent, true);
  window.addEventListener("unhandledrejection", rejected);
  document.addEventListener("visibilitychange", visibility);
  recordDiagnostic("runtime:started");
  stopCapture = () => {
    observers.forEach((observer) => observer.disconnect());
    window.clearInterval(heartbeat);
    window.removeEventListener("load", resourceEvent, true);
    window.removeEventListener("error", resourceEvent, true);
    window.removeEventListener("unhandledrejection", rejected);
    document.removeEventListener("visibilitychange", visibility);
    delete window.__HARBOR_DEBUG__;
    stopCapture = undefined;
  };
  return stopCapture;
}
