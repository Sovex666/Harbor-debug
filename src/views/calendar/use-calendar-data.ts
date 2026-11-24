import { CalendarCache } from "@/lib/calendar-cache";
import { useBrowseCacheUpdates } from "@/hooks/use-browse-cache-updates";
import { calendarSnapshot } from "@/lib/calendar-snapshot-cache";
import { getSession as getTraktSession } from "@/lib/trakt/session";
import { getSession as getSimklSession } from "@/lib/simkl/session";
import {
  calendarScopeKey,
  calendarCacheRevision,
  subscribeCalendarCache,
  registerCalendarCache,
} from "@/lib/calendar-cache-scope";
import { recordDiagnostic, measureDiagnostic } from "@/lib/perf/diagnostics";
import { useEffect, useState, useSyncExternalStore } from "react";
import {
  fetchCalendarRange,
  fetchCustomCalendar,
  monthRangeISO,
  type CalendarItem,
} from "@/lib/calendar";
import {
  fetchAnticipatedCalendar,
  fetchAniListAiringCalendar,
  fetchAnimeDubCalendar,
  fetchLibraryCalendar,
  fetchSimklCalendar,
  fetchSimklPremieresCalendar,
  fetchTraktCalendar,
  subscribeCalendarSourceCache,
  calendarSourceCacheRevision,
} from "@/lib/calendar-sources";
import type { Settings } from "@/lib/settings";
import { t } from "@/lib/i18n";
import type { CalendarResolutionStatus } from "@/lib/calendar-library";

type Args = {
  source: Settings["calendarSource"];
  authKey: string | null;
  traktConnected: boolean;
  simklConnected: boolean;
  settings: Settings;
  year: number;
  month: number;
  animeDub: boolean;
};

/** Same lifetime as the library resolver's own cache. */
const warmCalendar = new CalendarCache<CalendarItem[]>(18, 30 * 60 * 1000);
registerCalendarCache(() => warmCalendar.clear());

export type CalendarRequest = Args & {
  identity: string;
  revision: number;
  traktIdentity: string | null;
  simklIdentity: string | null;
};

type Fetcher = (
  signal: AbortSignal,
  onSnapshot?: (items: CalendarItem[], status: CalendarResolutionStatus) => void,
) => Promise<CalendarItem[]>;

type SharedEvent =
  | { type: "progress"; items: CalendarItem[]; status: CalendarResolutionStatus }
  | { type: "complete"; items: CalendarItem[] }
  | {
      type: "error";
      message: string;
      items: CalendarItem[];
      status?: CalendarResolutionStatus;
    };

type SharedLoad = {
  source: Settings["calendarSource"];
  controller: AbortController;
  /** Replayed to subscribers that attach after the load has started. */
  last: SharedEvent | null;
  /** Once true, no progress may be saved or emitted for this load. */
  settled: boolean;
  listeners: Set<(event: SharedEvent) => void>;
};

// Keyed by warmKey. An entry keeps running after its hooks unmount, so a return visit joins it.
const sharedLoads = new Map<string, SharedLoad>();

/** Shared by the hook and startup preloading so both compute identical request keys. */
export function calendarProviderIdentities(traktConnected: boolean, simklConnected: boolean) {
  const traktSession = traktConnected ? getTraktSession() : null;
  const simklSession = simklConnected ? getSimklSession() : null;
  // Tokens are private fallbacks when a provider has not supplied a username.
  return {
    traktIdentity: traktSession?.username || traktSession?.accessToken || null,
    simklIdentity: simklSession?.username || simklSession?.accessToken || null,
  };
}

export function calendarRequestKey(request: CalendarRequest): string {
  // Include every provider/filter input, even when two accounts have the same connection flags.
  // This key is private memory only; diagnostics must never receive it.
  return JSON.stringify([
    request.identity,
    request.revision,
    request.authKey,
    request.source,
    request.traktConnected,
    request.simklConnected,
    request.traktIdentity,
    request.simklIdentity,
    request.settings.tmdbKey,
    request.settings.tmdbLanguage,
    request.settings.tmdbImageLangs,
    request.settings.region,
    request.settings.customCalendar,
    request.year,
    request.month,
    request.animeDub,
  ]);
}

export function calendarWarmKey(
  requestKey: string,
  browseRevision: number,
  sourceRefreshRevision: number,
): string {
  return JSON.stringify([requestKey, browseRevision, sourceRefreshRevision]);
}

function sessionsCurrent(request: CalendarRequest): boolean {
  return (
    (!request.traktConnected || !!getTraktSession()?.accessToken) &&
    (!request.simklConnected || !!getSimklSession()?.accessToken)
  );
}

function openCalendarSnapshot(request: CalendarRequest, current: () => boolean) {
  // The revision is a process-local fence, not part of the durable identity.
  let durableIdentity: unknown = request.identity;
  try {
    const parsed = JSON.parse(request.identity);
    durableIdentity = Array.isArray(parsed) ? parsed.slice(0, 2) : parsed;
  } catch {
    // Keep test/legacy scope providers usable without weakening the media hash.
  }
  return calendarSnapshot(
    [
      durableIdentity,
      request.authKey,
      request.source,
      request.traktConnected,
      request.simklConnected,
      request.traktIdentity,
      request.simklIdentity,
      request.settings.tmdbKey,
      request.settings.tmdbLanguage,
      request.settings.tmdbImageLangs,
      request.settings.region,
      request.settings.customCalendar,
      request.year,
      request.month,
      request.animeDub,
    ],
    current,
  );
}

function startSharedLoad(request: CalendarRequest, warmKey: string, fetcher: Fetcher): SharedLoad {
  // Only one heavy load per source: a superseded load nobody watches is cancelled.
  for (const [key, other] of sharedLoads) {
    if (key === warmKey || other.source !== request.source || other.listeners.size) continue;
    other.controller.abort();
    sharedLoads.delete(key);
  }
  const revision = calendarCacheRevision();
  const controller = new AbortController();
  const snapshot = openCalendarSnapshot(
    request,
    () =>
      !controller.signal.aborted && calendarCacheRevision() === revision && sessionsCurrent(request),
  );
  const entry: SharedLoad = {
    source: request.source,
    controller,
    last: null,
    settled: false,
    listeners: new Set(),
  };
  const emit = (event: SharedEvent) => {
    entry.last = event;
    for (const listener of entry.listeners) listener(event);
  };
  sharedLoads.set(warmKey, entry);
  fetcher(controller.signal, (items, status) => {
    // A late progress callback must never save or emit over a settled result.
    if (controller.signal.aborted || entry.settled) return;
    if (!status.complete) void snapshot.save(items, false);
    emit({ type: "progress", items, status });
  })
    .then(
      (rows) => {
        entry.settled = true;
        void snapshot.save(rows, true);
        emit({ type: "complete", items: rows });
        // Written before the entry is removed, so a new mount finds one or the other.
        return warmCalendar.fetch(warmKey, async () => rows);
      },
      (e) => {
        entry.settled = true;
        const status: CalendarResolutionStatus | undefined = e?.status;
        const partial: CalendarItem[] =
          status?.complete === false && Array.isArray(e.items) ? e.items : [];
        if (partial.length) void snapshot.save(partial, false);
        emit({
          type: "error",
          message: e instanceof Error ? e.message : t("Failed to load"),
          items: partial,
          status,
        });
      },
    )
    .finally(() => {
      if (sharedLoads.get(warmKey) === entry) sharedLoads.delete(warmKey);
    });
  return entry;
}

function subscribeSharedLoad(entry: SharedLoad, listener: (event: SharedEvent) => void) {
  entry.listeners.add(listener);
  if (entry.last) listener(entry.last);
  return () => {
    entry.listeners.delete(listener);
  };
}

export function useCalendarData({
  source,
  authKey,
  traktConnected,
  simklConnected,
  settings,
  year,
  month,
  animeDub,
}: Args) {
  const revision = useSyncExternalStore(subscribeCalendarCache, calendarCacheRevision);
  const sourceKey =
    source === "anime"
      ? `${animeDub ? "anime-dub" : "anilist-airing"}:${year}-${month}`
      : source === "simkl-anticipated"
        ? `simkl-premieres:${year}-${month}`
        : undefined;
  const sourceRevision = useSyncExternalStore(subscribeCalendarSourceCache, () =>
    calendarSourceCacheRevision(sourceKey),
  );
  const sourceRefreshRevision = sourceKey === undefined ? 0 : sourceRevision;
  const browseCacheNow = useBrowseCacheUpdates(source !== "library" && source !== "simkl");
  // Library and simkl do not read the browse cache, so their warm key must not follow it.
  const browseRevision = source === "library" || source === "simkl" ? 0 : browseCacheNow;
  const identity = calendarScopeKey();
  const { traktIdentity, simklIdentity } = calendarProviderIdentities(
    traktConnected,
    simklConnected,
  );
  const request: CalendarRequest = {
    source,
    authKey,
    traktConnected,
    simklConnected,
    traktIdentity,
    simklIdentity,
    settings,
    year,
    month,
    animeDub,
    identity,
    revision,
  };
  const requestKey = calendarRequestKey(request);
  const warmKey = calendarWarmKey(requestKey, browseRevision, sourceRefreshRevision);
  const [state, setState] = useState<{
    key: string;
    items: CalendarItem[];
    loading: boolean;
    error: string | null;
  }>(() => ({
    key: requestKey,
    items: warmCalendar.peek(warmKey) ?? [],
    loading: warmCalendar.peek(warmKey) === undefined,
    error: null,
  }));

  const [progress, setProgress] = useState<CalendarResolutionStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    let unsubscribe: (() => void) | undefined;
    const snapshot = openCalendarSnapshot(
      request,
      () =>
        !cancelled &&
        !controller.signal.aborted &&
        calendarCacheRevision() === request.revision &&
        sessionsCurrent(request),
    );
    setProgress(null);
    const finish = measureDiagnostic("calendar.load");
    const run = (fetcher: Fetcher) => {
      const cached = warmCalendar.peek(warmKey);
      recordDiagnostic("calendar.cache", { hit: cached !== undefined });
      setState((previous) => ({
        key: requestKey,
        items: cached ?? (previous.key === requestKey ? previous.items : []),
        loading: cached === undefined && !(previous.key === requestKey && previous.items.length),
        error: null,
      }));
      const progressive = source === "library" || source === "simkl";
      if (progressive && cached !== undefined) {
        finish("ok", { items: cached.length });
        return;
      }
      let settled = false;
      let savedRows: CalendarItem[] = [];
      const diskRead = snapshot
        .read()
        .then((saved) => {
          if (cancelled || settled || !saved) return;
          savedRows = saved.items;
          setState((previous) => ({
            key: requestKey,
            items: mergeCalendarRows(
              saved.items,
              previous.key === requestKey ? previous.items : [],
            ),
            loading: false,
            error: previous.key === requestKey ? previous.error : null,
          }));
        })
        .catch(() => {});
      if (progressive) {
        const entry = sharedLoads.get(warmKey) ?? startSharedLoad(request, warmKey, fetcher);
        unsubscribe = subscribeSharedLoad(entry, (event) => {
          if (cancelled) return;
          if (event.type === "progress") {
            // Progress that arrives after a settled event must never merge into it.
            if (settled) return;
            setProgress(event.status);
            setState((previous) => ({
              key: requestKey,
              items: mergeCalendarRows(
                previous.key === requestKey ? previous.items : (cached ?? savedRows),
                event.items,
              ),
              loading: true,
              error: null,
            }));
            return;
          }
          settled = true;
          if (event.type === "complete") {
            setState({ key: requestKey, items: event.items, loading: false, error: null });
            finish("ok", { items: event.items.length });
            return;
          }
          const { items, status, message } = event;
          void diskRead.then(() => {
            if (cancelled) return;
            if (status) setProgress(status);
            setState((previous) => ({
              key: requestKey,
              items: mergeCalendarRows(
                previous.key === requestKey ? previous.items : (cached ?? []),
                items,
              ),
              loading: false,
              error: message,
            }));
            finish("error");
          });
        });
        return;
      }
      (sourceKey
        ? fetcher(controller.signal)
        : warmCalendar.fetch(
            warmKey,
            () => fetcher(controller.signal),
            (rows) => rows.length > 0,
          )
      )
        .then(async (rows) => {
          if (!cancelled) {
            settled = true;
            void snapshot.save(rows, true);
            setState({ key: requestKey, items: rows, loading: false, error: null });
            finish("ok", { items: rows.length });
          }
        })
        .catch(async (e) => {
          await diskRead;
          if (!cancelled) {
            settled = true;
            if (e?.status) setProgress(e.status);
            const partial: CalendarItem[] =
              e?.status?.complete === false && Array.isArray(e.items) ? e.items : [];
            if (partial.length) void snapshot.save(partial, false);
            setState((previous) => ({
              key: requestKey,
              items: mergeCalendarRows(
                previous.key === requestKey ? previous.items : (cached ?? []),
                partial,
              ),
              loading: false,
              error: e instanceof Error ? e.message : t("Failed to load"),
            }));
            finish("error");
          }
        });
    };
    const stop = () => {
      setState({ key: requestKey, items: [], loading: false, error: null });
      finish("ok", { items: 0 });
    };

    const dispatch = () => {
      if (source === "games") return stop();
      if (source === "library") {
        if (!authKey) return stop();
        return run((signal, onSnapshot) =>
          fetchLibraryCalendar(authKey, year, month, {
            tmdbKey: settings.tmdbKey,
            includeTrakt: traktConnected,
            signal,
            onSnapshot,
            // Resolve the whole library progressively; its size must not impose
            // a cutoff. Preparation and individual titles have their own deadlines.
          }),
        );
      }
      if (source === "trakt") {
        if (!traktConnected) return stop();
        return run(() => fetchTraktCalendar(year, month, true));
      }
      if (source === "simkl") {
        if (!simklConnected) return stop();
        return run((signal, onSnapshot) =>
          fetchSimklCalendar(year, month, {
            tmdbKey: settings.tmdbKey,
            signal,
            onSnapshot,
            maxMs: 15000,
          }),
        );
      }
      if (source === "simkl-anticipated") {
        return run(() => fetchSimklPremieresCalendar(year, month));
      }
      if (source === "anime") {
        return run(() =>
          animeDub ? fetchAnimeDubCalendar(year, month) : fetchAniListAiringCalendar(year, month),
        );
      }
      if (source === "anticipated") {
        return run(() => fetchAnticipatedCalendar(year, month, true));
      }
      if (source === "custom") {
        if (!settings.tmdbKey) return stop();
        const { start, end } = monthRangeISO(year, month);
        return run(() => {
          const extras: Promise<CalendarItem[]>[] = [];
          if (settings.customCalendar.includeTraktAnticipated) {
            extras.push(fetchAnticipatedCalendar(year, month, true));
          }
          if (settings.customCalendar.includeTraktWatchlist && traktConnected) {
            extras.push(fetchTraktCalendar(year, month, true));
          }
          return fetchCustomCalendar({
            apiKey: settings.tmdbKey,
            region: settings.region,
            filters: settings.customCalendar,
            start,
            end,
            extra: Promise.all(extras).then((batches) => batches.flat()),
            strict: true,
          });
        });
      }
      if (!settings.tmdbKey) return stop();
      const { start, end } = monthRangeISO(year, month);
      return run(() => fetchCalendarRange(settings.tmdbKey, start, end, settings.region, true));
    };

    dispatch();
    return () => {
      cancelled = true;
      // A shared load keeps running for other subscribers and for the warm cache.
      if (unsubscribe) unsubscribe();
      else {
        controller.abort();
        finish("cancelled");
      }
    };
    // requestKey contains the complete value-based dependency set above.
  }, [requestKey, warmKey]);

  useEffect(() => {
    if (simklConnected && source !== "games") {
      void fetchSimklPremieresCalendar(year, month).catch(() => {});
    }
  }, [simklConnected, year, month, source]);

  if (state.key !== requestKey) {
    const cached = warmCalendar.peek(warmKey);
    return { items: cached ?? [], loading: cached === undefined, error: null, progress: null };
  }
  return { items: state.items, loading: state.loading, error: state.error, progress };
}

/**
 * Starts the current month's library calendar before the Calendar view opens, so a
 * later visit can join or read it. Fire-and-forget: it never throws and never waits.
 */
export async function preloadLibraryCalendar(opts: {
  authKey: string;
  settings: Settings;
  traktConnected: boolean;
  simklConnected: boolean;
  signal?: AbortSignal;
}): Promise<void> {
  try {
    const authKey = opts.authKey;
    if (!authKey || opts.signal?.aborted) return;
    // Same defaults as the Calendar view: the current month and the non-dub anime mode.
    const today = new Date();
    const year = today.getFullYear();
    const month = today.getMonth();
    const { traktIdentity, simklIdentity } = calendarProviderIdentities(
      opts.traktConnected,
      opts.simklConnected,
    );
    const request: CalendarRequest = {
      source: "library",
      authKey,
      traktConnected: opts.traktConnected,
      simklConnected: opts.simklConnected,
      traktIdentity,
      simklIdentity,
      settings: opts.settings,
      year,
      month,
      animeDub: false,
      identity: calendarScopeKey(),
      revision: calendarCacheRevision(),
    };
    // Library has no browse or source-refresh revision, so its warm key is fixed per identity.
    const warmKey = calendarWarmKey(calendarRequestKey(request), 0, 0);
    if (warmCalendar.peek(warmKey) !== undefined) return;
    const entry =
      sharedLoads.get(warmKey) ??
      startSharedLoad(request, warmKey, (signal, onSnapshot) =>
        fetchLibraryCalendar(authKey, year, month, {
          tmdbKey: opts.settings.tmdbKey,
          includeTrakt: opts.traktConnected,
          signal,
          onSnapshot,
        }),
      );
    // The preload signal only cancels a load that nothing has joined.
    opts.signal?.addEventListener(
      "abort",
      () => {
        if (entry.listeners.size) return;
        entry.controller.abort();
        // A Calendar mount must not join a load that is already being cancelled.
        if (sharedLoads.get(warmKey) === entry) sharedLoads.delete(warmKey);
      },
      { once: true },
    );
  } catch {
    // Best effort: the view loads the library itself when it opens.
  }
}

function mergeCalendarRows(previous: CalendarItem[], next: CalendarItem[]): CalendarItem[] {
  const key = (item: CalendarItem) =>
    JSON.stringify([item.id, item.type, item.releaseDate, item.releaseTime]);
  const merged = new Map(previous.map((item) => [key(item), item]));
  for (const item of next) merged.set(key(item), item);
  return [...merged.values()];
}
