import { cacheInstallationSalt } from "./cache-scope";
import { registerCalendarCache } from "./calendar-cache-scope";
import {
  mediaCacheGeneration,
  readMediaValue,
  removeMediaNamespaces,
  saveMedia,
} from "./media-cache";
import type { CalendarItem } from "./calendar";

type Snapshot = { complete: boolean; items: CalendarItem[] };
const PREFIX = "calendar-snapshot-";
const STALE = 30 * 24 * 60 * 60_000;
let epoch = 0;
let removal: Promise<unknown> = Promise.resolve();

registerCalendarCache((purgeSnapshots = true) => {
  epoch++;
  // The media cache serializes removals after writes already in progress.
  if (purgeSnapshots) removal = removeMediaNamespaces(PREFIX).catch(() => {});
});

function valid(value: Snapshot | null): value is Snapshot {
  return (
    !!value &&
    typeof value.complete === "boolean" &&
    Array.isArray(value.items) &&
    value.items.every(
      (item) => !!item && typeof item.id === "string" && typeof item.name === "string",
    )
  );
}

/** Inputs remain private in memory; media-cache hashes the salted scope before storage. */
export function calendarSnapshot(scope: readonly unknown[], current: () => boolean) {
  const salt = cacheInstallationSalt();
  const generation = epoch;
  const mediaGeneration = mediaCacheGeneration();
  const active = () => !!salt && generation === epoch && current();
  const key = [salt, ...scope];
  let completed = false;
  return {
    async read(): Promise<Snapshot | null> {
      await removal;
      if (!active()) return null;
      const [complete, partial] = await Promise.all([
        readMediaValue<Snapshot>(`${PREFIX}complete`, key),
        readMediaValue<Snapshot>(`${PREFIX}partial`, key),
      ]);
      if (!active()) return null;
      return valid(complete) && complete.complete
        ? complete
        : valid(partial) && !partial.complete
          ? partial
          : null;
    },
    async save(items: CalendarItem[], complete: boolean): Promise<void> {
      if (complete) completed = true;
      if (!active() || (!complete && (!items.length || completed))) return;
      await removal;
      if (!active() || (!complete && completed)) return;
      await saveMedia(
        `${PREFIX}${complete ? "complete" : "partial"}`,
        key,
        { complete, items },
        {
          ttl: 60_000,
          stale: STALE,
          maxBytes: 1024 * 1024,
          valid,
          current: () => active() && (complete || !completed),
        },
        undefined,
        mediaGeneration,
      ).catch(() => false);
    },
  };
}
