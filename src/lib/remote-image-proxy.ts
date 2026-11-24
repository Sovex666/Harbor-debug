import { useEffect, useRef, useState, type RefObject } from "react";
import { createObjectUrlCache } from "./object-url-cache";
import { isImageLayerParked, onImageLayerResume } from "./image-readiness";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { suwayomiAuthFor } from "@/lib/manga/sources/suwayomi/auth-registry";
import { useSettings } from "@/lib/settings";
import { idbCacheGet, idbCacheDelete, idbCacheKeys } from "@/lib/idb-cache";
import { measureDiagnostic, recordDiagnostic } from "./perf/diagnostics";
import { createThumbnailScheduler, type ThumbnailPriority } from "./thumbnail-scheduler";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

type HarborFetchResponse = {
  status: number;
  ok: boolean;
  body: string;
  contentType?: string | null;
  headers?: Record<string, string>;
};

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.trim());
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Remote plain-HTTP images are blocked by the WebView as mixed content: the app
// page is a secure context, so http://localhost is exempt but http://<remote>
// is refused (https is fine). Route those through the Rust side and hand back a
// same-origin blob URL. Covers e.g. a Suwayomi server hosted on a VPS over HTTP.
export function needsImageProxy(url: string): boolean {
  if (!isTauri) return false;
  // An <img> tag cannot send an Authorization header, so any server behind
  // basic auth must be fetched through Rust regardless of scheme.
  if (suwayomiAuthFor(url)) return true;
  if (!url.startsWith("http://")) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return !(
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host.endsWith(".localhost")
    );
  } catch {
    return false;
  }
}

const blobCache = createObjectUrlCache();
type BlobEntry = NonNullable<ReturnType<typeof blobCache.get>>;
type ProxyImageResult = BlobEntry | string;
// Module scoped, like the blob cache beside it. A failure used to live in
// component state, so every remount re-invoked harbor_fetch for a url already
// known to be dead, and each of those is a bridge crossing carrying a base64
// image body. The in-flight map is for the row where twenty cells share a logo.
const deadUrls = new Map<string, number>();
function isDead(url: string): boolean {
  if ((deadUrls.get(url) ?? 0) > Date.now()) return true;
  deadUrls.delete(url);
  return false;
}
// A card's own retry must not be answered by the 60s failure memory, or every retry would fail instantly.
export function forgetFailedImage(url: string): void {
  for (const key of deadUrls.keys()) if (key.endsWith(`\n${url}`)) deadUrls.delete(key);
}
// Disk-cache hits come back as asset-protocol URLs, which the blob cache cannot hold. Without
// this, a re-shown parked layer re-requests every poster over IPC just to get the same string.
const assetUrls = new Map<string, string>();
function rememberAssetUrl(key: string, src: string): void {
  assetUrls.delete(key);
  assetUrls.set(key, src);
  while (assetUrls.size > 2000) assetUrls.delete(assetUrls.keys().next().value!);
}
const imageScheduler = createThumbnailScheduler<ProxyImageResult | null>();
export function deferBackgroundImages(ms = 1500): void {
  imageScheduler.pauseBackground(ms);
}
if (typeof window !== "undefined") {
  let lastDeferAt = 0;
  const deferOnInput = () => {
    const now = Date.now();
    // Timestamp only: a layout read here would force a reflow on every scroll frame.
    if (now - lastDeferAt < 200) return;
    lastDeferAt = now;
    deferBackgroundImages(600);
  };
  for (const type of ["scroll", "wheel", "pointerdown"]) {
    window.addEventListener(type, deferOnInput, { passive: true, capture: true });
  }
  window.addEventListener("harbor:reset-row-scrolls", () => deferBackgroundImages(1500));
  // Jobs held in a parked layer resume through one queue scan, off the switch commit's task.
  let pumpQueued = false;
  onImageLayerResume(() => {
    if (pumpQueued) return;
    pumpQueued = true;
    setTimeout(() => {
      pumpQueued = false;
      imageScheduler.pump();
    }, 0);
  });
}
export function clearSpeculativeArtwork(): void {
  imageScheduler.clearSpeculative();
}
// Parked (warmed) views are hidden, so their posters would otherwise be paused and never load.
let artworkWarmUntil = 0;
export function warmParkedArtwork(ms: number): void {
  artworkWarmUntil = Date.now() + ms;
  // Warm-eligible jobs held in parked layers can start now.
  imageScheduler.pump();
}
export function endParkedArtworkWarm(): void {
  artworkWarmUntil = 0;
}
export function isParkedArtworkWarm(): boolean {
  return Date.now() < artworkWarmUntil;
}
export function releaseUnusedArtworkMemory(): void {
  // A delayed release must not discard warm poster loads while the after-player window is open.
  if (!isParkedArtworkWarm()) imageScheduler.clearSpeculative();
  blobCache.releaseUnused();
}
export function artworkDiagnostics() {
  return { ...blobCache.stats(), ...imageScheduler.stats() };
}
// Legacy poster blobs share a database with pinned music; only this prefix is disposable.
const POSTER_PREFIX = "season-poster:v1:";
const POSTER_TTL = 7 * 24 * 60 * 60_000;
let legacyPruned = false;
let pruning: Promise<void> | undefined;
let cacheGeneration = 0;

function prunePosters(): void {
  if (pruning) return;
  pruning = (async () => {
    const keys = (await idbCacheKeys()).filter((key) => key.startsWith(POSTER_PREFIX));
    const entries = await Promise.all(
      keys.map(async (key) => ({ key, entry: await idbCacheGet(key) })),
    );
    entries.sort((a, b) => (b.entry?.at ?? 0) - (a.entry?.at ?? 0));
    await Promise.all(
      entries
        .filter(({ entry }, i) => i >= 120 || !entry || Date.now() - entry.at >= POSTER_TTL)
        .map(({ key }) => idbCacheDelete(key)),
    );
  })()
    .catch(() => {})
    .finally(() => {
      pruning = undefined;
    });
}

export async function clearThumbCache(): Promise<void> {
  cacheGeneration++;
  blobCache.clear();
  deadUrls.clear();
  assetUrls.clear();
  const keys = (await idbCacheKeys()).filter((key) => key.startsWith(POSTER_PREFIX));
  await Promise.all(keys.map(idbCacheDelete));
  await invoke("clear_thumb_cache");
}

export type ThumbCacheSize = { bytes: number; files: number };

export async function getThumbCacheSize(): Promise<ThumbCacheSize | null> {
  try {
    const size = await invoke<ThumbCacheSize>("thumb_cache_size");
    if (!size || typeof size.bytes !== "number" || typeof size.files !== "number") return null;
    return size;
  } catch {
    return null;
  }
}

// Shared by cards that ask for the same image at once. It bypasses the network scheduler, so a
// disk hit never waits behind slow downloads.
const diskLookups = new Map<string, Promise<string | null>>();
function lookupDisk(url: string, thumbWidthPx?: number): Promise<string | null> {
  const key = `${thumbWidthPx ?? 0}\n${url}`;
  const pending = diskLookups.get(key);
  if (pending) return pending;
  const lookup = measureDiagnostic("image:disk-lookup");
  const found = invoke<string | null>("cached_thumb_path", { url, width: thumbWidthPx ?? 0 })
    .catch(() => null)
    .then((path) => {
      lookup("ok", { hit: typeof path === "string" && !!path });
      return typeof path === "string" && path ? path : null;
    })
    .finally(() => {
      diskLookups.delete(key);
    });
  diskLookups.set(key, found);
  return found;
}

function proxyImage(
  url: string,
  thumbWidthPx?: number,
  persistent = false,
  migrateLegacy = true,
  signal?: AbortSignal,
  diskChecked = false,
): Promise<ProxyImageResult | null> {
  const generation = cacheGeneration;
  const key = cacheKeyFor(url, thumbWidthPx);
  const cached = blobCache.get(key);
  if (cached) {
    recordDiagnostic("image:memory-hit");
    return Promise.resolve(cached);
  }
  if (isDead(key)) {
    recordDiagnostic("image:failure-cached");
    return Promise.resolve(null);
  }
  const finish = measureDiagnostic("image:proxy", { persistent });
  const p = (async () => {
    try {
      const auth = suwayomiAuthFor(url);
      const diskKey = `${POSTER_PREFIX}${thumbWidthPx ?? 0}\n${url}`;
      const persist = persistent && !auth;
      if (persist && !legacyPruned) {
        legacyPruned = true;
        prunePosters();
      }
      if (persist && !diskChecked) {
        // A fresh native entry can be served straight through the asset
        // protocol; this avoids the base64 IPC + Blob path on warm posters.
        const path = await lookupDisk(url, thumbWidthPx);
        if (generation !== cacheGeneration) return null;
        if (path) return convertFileSrc(path);
      }
      if (persist && migrateLegacy) {
        const entry = await Promise.resolve()
          .then(() => idbCacheGet(diskKey))
          .catch(() => null);
        if (generation !== cacheGeneration) return null;
        if (entry && Date.now() - entry.at < POSTER_TTL && entry.data instanceof Blob) {
          const created = blobCache.set(key, entry.data);
          return created;
        }
      }
      signal?.throwIfAborted();
      const request = measureDiagnostic("image:fetch");
      const requestId = crypto.randomUUID();
      const cancel = () => {
        void invoke("harbor_image_cancel", { requestId }).catch(() => {});
      };
      signal?.addEventListener("abort", cancel, { once: true });
      const resp = await invoke<HarborFetchResponse>("harbor_image_fetch", {
        requestId,
        args: {
          url,
          method: "GET",
          responseType: "base64",
          timeoutMs: 30000,
          headers: auth ? { authorization: auth } : undefined,
          allowLocalNetwork: Boolean(auth),
          thumbWidthPx,
          cacheImage: persist,
          maxResponseBytes: 32 * 1024 * 1024,
        },
      })
        .finally(() => signal?.removeEventListener("abort", cancel))
        .then(
          (response) => {
            request(response.ok ? "ok" : "error", { status: response.status });
            return response;
          },
          (error: unknown) => {
            request("error");
            throw error;
          },
        );
      signal?.throwIfAborted();
      if (!resp.ok) throw new Error(`status ${resp.status}`);
      if (generation !== cacheGeneration) return null;
      if (persistent && typeof window !== "undefined")
        window.__harborProfiler?.mark("image-cache", {
          result: resp.headers?.["x-harbor-image-cache"] ?? "bypass",
        });
      const type = resp.headers?.["content-type"] || resp.contentType || "image/jpeg";
      if (type && !type.startsWith("image/")) throw new Error(`type ${type}`);
      const decode = measureDiagnostic("image:base64-decode");
      const blob = new Blob([base64ToBytes(resp.body)], { type });
      decode("ok", { bytes: blob.size });
      const control = resp.headers?.["cache-control"] ?? "";
      const age =
        resp.headers?.["x-harbor-image-max-age"] ?? /(?:^|,)\s*max-age="?(\d+)/i.exec(control)?.[1];
      const ttl = /(?:^|,)\s*(?:no-store|no-cache|private)(?:,|$)/i.test(control)
        ? 0
        : age !== undefined
          ? Number(age) * 1000
          : undefined;
      const created = blobCache.set(key, blob, Number.isFinite(ttl) ? ttl : undefined);
      return created;
    } catch {
      finish("error");
      if (generation !== cacheGeneration || signal?.aborted) return null;
      deadUrls.set(key, Date.now() + 60_000);
      while (deadUrls.size > 300) deadUrls.delete(deadUrls.keys().next().value!);
      return null;
    }
  })().finally(() => {
    finish(generation === cacheGeneration ? "ok" : "cancelled");
  });
  return p;
}

const cacheKeyFor = (url: string, thumbWidthPx?: number): string =>
  `${thumbWidthPx ?? 0}\n${suwayomiAuthFor(url) ?? ""}\n${url}`;

export function useProxiedImageSrc(
  url: string | undefined,
  opts?: {
    forceProxy?: boolean;
    persistent?: boolean;
    enabled?: boolean;
    originalSize?: boolean;
    priority?: ThumbnailPriority;
    paused?: boolean;
    /**
     * The element whose App layer gates new work: while that layer is parked, a fetch waits in the
     * queue instead of starting, and resumes when the layer becomes active. Read from the DOM at
     * scheduling time, so a layer switch never re-renders the caller.
     */
    layerRef?: RefObject<Element | null>;
    /** Let parked work run while `warmParkedArtwork` is in effect. */
    warmWhileParked?: boolean;
  },
): string | undefined {
  const need =
    isTauri &&
    !!url &&
    (opts?.forceProxy
      ? url.startsWith("http://") || url.startsWith("https://")
      : needsImageProxy(url));
  const { settings } = useSettings();
  const persistent = opts?.persistent === true;
  const thumbWidthPx =
    opts?.originalSize || settings.posterQuality === "max"
      ? undefined
      : settings.posterQuality === "high"
        ? 600
        : 400;
  const imageKey = cacheKeyFor(url ?? "", thumbWidthPx);
  const [blob, setBlob] = useState<{ key: string; src: string } | undefined>(() => {
    const cached = url && need ? blobCache.get(imageKey) : undefined;
    if (cached) return { key: imageKey, src: cached.src };
    const asset = url && need ? assetUrls.get(imageKey) : undefined;
    return asset ? { key: imageKey, src: asset } : undefined;
  });
  const [failed, setFailed] = useState(() =>
    url && need && isDead(imageKey) ? imageKey : undefined,
  );
  const leaseRef = useRef<{ setPriority: (priority: ThumbnailPriority) => void } | undefined>(
    undefined,
  );
  // The disk lookup is async, so a lease taken after it reads the priority at that moment.
  const priorityRef = useRef<ThumbnailPriority>("visible");
  priorityRef.current = opts?.priority ?? "visible";
  const layerRef = opts?.layerRef;
  const warmWhileParked = opts?.warmWhileParked === true;
  useEffect(() => {
    if (!url || !need || opts?.enabled === false) {
      setFailed(undefined);
      setBlob(undefined);
      return;
    }
    const cached = blobCache.get(cacheKeyFor(url, thumbWidthPx));
    if (cached) {
      setFailed(undefined);
      setBlob((previous) =>
        previous?.key === imageKey && previous.src === cached.src
          ? previous
          : { key: imageKey, src: cached.src },
      );
      return blobCache.retain(cached);
    }
    const asset = assetUrls.get(imageKey);
    if (asset) {
      setFailed(undefined);
      setBlob((previous) =>
        previous?.key === imageKey && previous.src === asset
          ? previous
          : { key: imageKey, src: asset },
      );
      return;
    }
    if (opts?.paused) return;
    if (isDead(imageKey)) {
      setBlob(undefined);
      setFailed(imageKey);
      return;
    }
    setFailed(undefined);
    let alive = true;
    const generation = cacheGeneration;
    let release: (() => void) | undefined;
    let lease: ReturnType<typeof imageScheduler.acquire> | undefined;
    let queueTime: ReturnType<typeof measureDiagnostic> | undefined;
    const hold = layerRef
      ? () => isImageLayerParked(layerRef.current) && !(warmWhileParked && isParkedArtworkWarm())
      : undefined;
    const heldNow = hold?.() ?? false;
    const startFetch = (diskChecked: boolean) => {
      // Keep the bitmap already showing this key, so a re-fetch does not blank the card.
      setBlob((previous) => (previous?.key === imageKey ? previous : undefined));
      const stats = imageScheduler.stats();
      // Only a real lease is measured; a disk hit never reaches this point. Time spent parked is
      // not queue time, so a lease that starts parked is not measured either.
      queueTime = heldNow
        ? undefined
        : measureDiagnostic("image:queue", {
            active: stats.active,
            pending: stats.queued,
          });
      const acquired = imageScheduler.acquire(
        imageKey,
        priorityRef.current,
        (signal) => {
          queueTime?.("ok");
          return proxyImage(url, thumbWidthPx, persistent, !opts?.originalSize, signal, diskChecked);
        },
        hold,
      );
      lease = acquired;
      leaseRef.current = acquired;
      void acquired.promise
        .then((created) => {
          if (!alive || generation !== cacheGeneration) return;
          if (typeof created === "string") {
            rememberAssetUrl(imageKey, created);
            setBlob({ key: imageKey, src: created });
            return;
          }
          if (created && !created.retired) {
            release = blobCache.retain(created);
            setBlob({ key: imageKey, src: created.src });
          } else setFailed(imageKey);
        })
        .catch(() => {
          if (alive) setFailed(imageKey);
        });
    };
    // Background cards skip this direct lookup. Hundreds of IPC calls at once queue behind visible
    // work on the native side, so their proxyImage call looks up inside a scheduler slot instead.
    // Parked cards do the same, so a parked page issues no IPC until its layer is active again.
    if (persistent && !suwayomiAuthFor(url) && priorityRef.current !== "background" && !heldNow) {
      void lookupDisk(url, thumbWidthPx).then((path) => {
        if (!alive || generation !== cacheGeneration) return;
        if (path) {
          const src = convertFileSrc(path);
          rememberAssetUrl(imageKey, src);
          setBlob({ key: imageKey, src });
          return;
        }
        startFetch(true);
      });
    } else startFetch(false);
    return () => {
      alive = false;
      queueTime?.("cancelled");
      if (lease && leaseRef.current === lease) leaseRef.current = undefined;
      lease?.release();
      release?.();
    };
  }, [
    url,
    imageKey,
    need,
    thumbWidthPx,
    persistent,
    opts?.enabled,
    opts?.originalSize,
    opts?.paused,
    layerRef,
    warmWhileParked,
  ]);
  useEffect(() => {
    leaseRef.current?.setPriority(opts?.priority ?? "visible");
  }, [imageKey, opts?.priority]);
  if (opts?.enabled === false) return undefined;
  if (!need) return url;
  // Loading -> undefined (caller shows its placeholder/shimmer). Failed -> the
  // original url so the <img> errors and the caller's fallback/plate logic runs.
  return blob?.key === imageKey ? blob.src : failed === imageKey ? url : undefined;
}
