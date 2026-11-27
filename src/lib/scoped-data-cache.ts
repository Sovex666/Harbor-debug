import { cacheInstallationSalt } from "./cache-scope";
import { loadMedia, MEDIA_TTL } from "./media-cache";

const BROWSE_TTL = 5 * 60_000;
let revision = 0;
let notifyTimer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();
export const browseCacheRevision = () => revision;
export function subscribeBrowseCache(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
function changed() {
  revision++;
  if (notifyTimer || !listeners.size) return;
  notifyTimer = setTimeout(() => {
    notifyTimer = undefined;
    for (const listener of listeners) listener();
  }, 200);
}

/** Public first pages only. Personal data requires a separately resolved identity. */
export async function cachedBrowsePage<T>(
  scope: readonly unknown[],
  loader: () => Promise<T | null>,
  valid: (value: T) => boolean,
): Promise<T | null> {
  const salt = cacheInstallationSalt();
  if (!salt) return loader();
  const result = await loadMedia("browse-catalog", [salt, ...scope], loader, {
    // A restart should be an instant read even when the last visit was a day
    // ago. The loader is still run in the background by media-cache when the
    // fresh window has elapsed, so this never blocks category navigation.
    ttl: BROWSE_TTL,
    stale: MEDIA_TTL.stale,
    staleWhileRevalidate: true,
    maxBytes: 512 * 1024,
    valid,
  });
  if (result.refresh)
    void result.refresh
      .then((fresh) => {
        if (fresh !== null && JSON.stringify(fresh) !== JSON.stringify(result.value)) changed();
      })
      .catch(() => {});
  return result.value;
}
