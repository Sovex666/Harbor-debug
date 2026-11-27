/** Projection at the structured-capture trust boundary. Never persist raw inputs. */
export type DiagnosticValue = number | boolean;
export type StructuredDiagnostic = {
  name: string;
  fields: Record<string, DiagnosticValue>;
};

const EVENTS = new Set([
  "calendar.load",
  "calendar.cache",
  "calendar.library.candidates",
  "calendar.library.resolve",
  "calendar.library.partial",
  "calendar:fetch",
  "ui:longtask",
  "ui:event-loop-stall",
  "image:loaded",
  "image:error",
  "image:memory-hit",
  "image:failure-cached",
  "image:coalesced",
  "image:proxy",
  "image:disk-lookup",
  "image:fetch",
  "image:base64-decode",
  "image:queue",
  "runtime:started",
  "runtime:error",
  "runtime:unhandled-rejection",
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
  ...["img", "fetch", "xmlhttprequest", "script", "css", "other"].map((v) => `resource:${v}`),
  ...["direct", "directfail", "harborfetch", "pluginhttp"].flatMap((kind) =>
    ["ok", "error", "timeout", "abort"].map((outcome) => `bridge:${kind}:${outcome}`),
  ),
  ...[
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
  ].flatMap((view) =>
    ["requested", "superseded", "shell-paint", "first-paint"].map(
      (stage) => `navigation:${view}:${stage}`,
    ),
  ),
]);

const FIELDS = new Set([
  "elapsedMs",
  "error",
  "cancelled",
  "bytes",
  "cached",
  "hit",
  "items",
  "candidates",
  "rows",
  "series",
  "movies",
  "persistent",
  "load",
  "allowPaused",
  "normalized",
  "position",
  "active",
  "cache",
  "stopped",
  "failed",
  "suppressed",
  "buffering",
  "live",
  "advancing",
  "status",
  "resolved",
  "pending",
  "complete",
  "count",
  "cause",
  "event",
  "reason",
  "underrun",
  "retry",
  "gapMs",
  "dropped",
  "decoder",
  "frameDrops",
  "idle",
  "paused",
  "navigationId",
  "hasSnapshot",
  "high",
  "rssMB",
  "local",
  "insecure",
  "fallback",
]);

export function projectDiagnostic(
  name: string,
  fields: Record<string, unknown>,
): StructuredDiagnostic | null {
  if (!EVENTS.has(name)) return null;
  const safe: Record<string, DiagnosticValue> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!FIELDS.has(key)) continue;
    if (typeof value === "boolean") safe[key] = value;
    else if (
      typeof value === "number" &&
      Number.isFinite(value) &&
      Math.abs(value) <= Number.MAX_SAFE_INTEGER
    )
      safe[key] = Math.round(value * 100) / 100;
  }
  return { name, fields: safe };
}
