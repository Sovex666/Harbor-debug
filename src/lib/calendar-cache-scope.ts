import { activeScopedProfileId, nuvioWatchedScope } from "./active-profile-id";
import { subscribeSession as subscribeTrakt } from "./trakt/session";
import { subscribeSession as subscribeSimkl } from "./simkl/session";
import { subscribeWatchlist } from "./watchlist";
import { listLocalCw, subscribeLocalCw } from "./local-cw";
import { subscribeManualWatched } from "./manual-watched";

const caches = new Set<(purgeSnapshots?: boolean) => void>();
const listeners = new Set<() => void>();
let revision = 0;

export function registerCalendarCache(clear: (purgeSnapshots?: boolean) => void): void {
  caches.add(clear);
}

export function invalidateCalendarCaches(purgeSnapshots = true): void {
  revision++;
  for (const clear of caches) clear(purgeSnapshots);
  for (const listener of listeners) listener();
}

export function calendarCacheRevision(): number {
  return revision;
}
export function subscribeCalendarCache(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Private identity stays in memory and must never be passed to diagnostics. */
export function calendarScopeKey(): string {
  return JSON.stringify([activeScopedProfileId(), nuvioWatchedScope(), revision]);
}

// None of these purge the saved calendar on disk. Durable keys already isolate
// accounts, profiles and filters, and the next load replaces the saved rows, so
// a library sync at launch must not discard the calendar the view opens with.
subscribeTrakt(() => invalidateCalendarCaches(false));
subscribeSimkl(() => invalidateCalendarCaches(false));
subscribeWatchlist(() => invalidateCalendarCaches(false));
let localCwMembership = "";
function localCwMembershipKey(): string {
  try {
    return listLocalCw()
      .map((entry) =>
        [entry.id, entry.type, entry.season ?? 0, entry.episode ?? 0, entry.videoId ?? ""].join(
          "|",
        ),
      )
      .sort()
      .join("\n");
  } catch {
    return "";
  }
}
localCwMembership = localCwMembershipKey();
subscribeLocalCw(() => {
  const next = localCwMembershipKey();
  if (next === localCwMembership) return;
  localCwMembership = next;
  invalidateCalendarCaches(false);
});
subscribeManualWatched(() => invalidateCalendarCaches(false));
if (typeof window !== "undefined") {
  for (const event of [
    "harbor:active-profile-changed",
    "harbor:profiles-updated",
    "harbor:nuvio-profile-changed",
    "harbor:nuvio-state-changed",
    "harbor:account-provider-changed",
    "harbor:settings-changed",
    "storage",
  ])
    window.addEventListener(event, () => invalidateCalendarCaches(false));
}
