import { effectiveTmdbLanguage } from "./providers/tmdb/tmdb-client";
import { mapCalendarLimit as mapLimit } from "./calendar-scheduler";
import { CalendarCache } from "./calendar-cache";
import { calendarScopeKey, registerCalendarCache } from "./calendar-cache-scope";
import { measureDiagnostic } from "@/lib/perf/diagnostics";
import { meta as cinemetaMeta } from "./cinemeta";
import { library, type LibraryItem } from "./stremio";
import { readLocalEntries } from "./watchlist";
import { listLocalCw } from "./local-cw";
import { manualWatchedLibraryItems } from "./manual-watched";
import { fetchWatchlist as fetchTraktWatchlist } from "./trakt/watchlist";
import { tvmazeUpcoming } from "./providers/tvmaze";
import {
  tmdbFindByImdb,
  tmdbMovieRelease,
  tmdbTvPoster,
  tmdbTvUpcoming,
} from "./providers/tmdb/tmdb-calendar";
import { aniZipByAnilist, aniZipByKitsu, aniZipByMal, pickEpisodeTitle } from "./providers/anizip";
import { imdbToKitsu, tmdbTvToKitsu } from "./providers/anime-mapping";
import { franchiseRoot } from "./providers/anime-franchise-root";
import type { CalendarItem } from "./calendar";
import { localDateTimeFromIso } from "./calendar-time";

const TMDB_CONCURRENCY = 6;
const CANDIDATE_TIMEOUT_MS = 15_000;
const TITLE_TIMEOUT_MS = 30_000;

export type CalendarResolutionStatus = {
  resolved: number;
  pending: number;
  failed: number;
  complete: boolean;
  reason?: "cancelled" | "deadline" | "failed";
};
export type CalendarResolveOptions = {
  tmdbKey: string;
  onSnapshot?: (items: CalendarItem[], status: CalendarResolutionStatus) => void;
  signal?: AbortSignal;
  maxMs?: number;
  deduplicateCatalogs?: boolean;
};
export class IncompleteCalendarError extends Error {
  constructor(
    public items: CalendarItem[],
    public status: CalendarResolutionStatus,
  ) {
    super(
      status.reason === "deadline"
        ? "Calendar resolution timed out"
        : status.reason === "cancelled"
          ? "Calendar resolution cancelled"
          : "Some calendar titles failed to load",
    );
    this.name = "IncompleteCalendarError";
  }
}

export type SavedCandidate = {
  id: string;
  type: "movie" | "series";
  name: string;
  mtime: number;
  temp: boolean;
};

/** Bound candidate retrieval as well as resolution with one shared time budget. */
export async function prepareCalendarCandidates<T>(
  opts: CalendarResolveOptions,
  gather: (signal: AbortSignal) => Promise<T>,
): Promise<{ candidates: T; options: CalendarResolveOptions }> {
  const started = Date.now();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stop: () => void = () => {};
  const stopped = new Promise<never>((_resolve, reject) => {
    const fail = (reason: "deadline" | "cancelled") => {
      controller.abort();
      reject(
        new IncompleteCalendarError([], {
          resolved: 0,
          pending: 1,
          failed: 0,
          complete: false,
          reason,
        }),
      );
    };
    stop = () => fail("cancelled");
    opts.signal?.addEventListener("abort", stop, { once: true });
    if (opts.signal?.aborted) stop();
    timer = setTimeout(() => fail("deadline"), Math.max(0, opts.maxMs ?? CANDIDATE_TIMEOUT_MS));
  });
  try {
    const candidates = await Promise.race([
      stopped,
      Promise.resolve().then(() => {
        if (controller.signal.aborted) throw new Error("Calendar cancelled");
        return gather(controller.signal);
      }),
    ]);
    return {
      candidates,
      options: {
        ...opts,
        maxMs: opts.maxMs == null ? undefined : Math.max(0, opts.maxMs - (Date.now() - started)),
      },
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    opts.signal?.removeEventListener("abort", stop);
  }
}

type Candidate = SavedCandidate;

type ResolvedEpisode = {
  season: number;
  number: number;
  name: string;
  airDate: string;
  releaseTime?: string;
  releaseAtMs?: number;
  image: string | null;
  overview: string;
  voteAverage: number;
};

type ResolvedSeries = {
  name: string;
  poster: string | null;
  isAnime: boolean;
  episodes: ResolvedEpisode[];
};

const CACHE_TTL_MS = 30 * 60 * 1000;
const seriesCache = new CalendarCache<ResolvedSeries | null>(240, CACHE_TTL_MS);
const movieCache = new CalendarCache<CalendarItem | null>(240, CACHE_TTL_MS);
registerCalendarCache(() => {
  seriesCache.clear();
  movieCache.clear();
});

function wideWindow(): (iso: string) => boolean {
  const lo = Date.now() - 31 * 864e5;
  const hi = Date.now() + 400 * 864e5;
  return (iso) => {
    if (!iso) return false;
    const t = Date.parse(iso);
    return Number.isFinite(t) && t >= lo && t <= hi;
  };
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function inMonthFactory(year: number, month: number): (iso: string) => boolean {
  return (iso) => {
    if (!iso) return false;
    const [y, m] = iso.split("-").map(Number);
    return y === year && (m ?? 0) - 1 === month;
  };
}

function isAnimationGenre(genres: string[] | undefined): boolean {
  if (!genres) return false;
  return genres.some((g) => {
    const l = g.toLowerCase();
    return l === "animation" || l === "anime";
  });
}

function isAnimeId(id: string): boolean {
  return id.startsWith("kitsu:") || id.startsWith("mal:") || id.startsWith("anilist:");
}

function animeNumericId(id: string): number | null {
  const n = Number(id.split(":")[1]);
  return Number.isFinite(n) ? n : null;
}

async function animeUpcoming(
  id: string,
  inWindow: (date: string) => boolean,
  tmdbKey: string,
): Promise<ResolvedSeries | null> {
  const numId = animeNumericId(id);
  if (numId == null) return null;
  const mapping = id.startsWith("kitsu:")
    ? await aniZipByKitsu(numId)
    : id.startsWith("mal:")
      ? await aniZipByMal(numId)
      : await aniZipByAnilist(numId);
  if (!mapping?.episodes) return null;
  const episodes: ResolvedEpisode[] = [];
  for (const [k, ep] of Object.entries(mapping.episodes)) {
    const { date, time, atMs } = localDateTimeFromIso(ep.airDateUtc ?? ep.airDate ?? ep.airdate);
    if (!date || !inWindow(date)) continue;
    episodes.push({
      season: ep.seasonNumber ?? 1,
      number: ep.episodeNumber ?? (Number(k) || 0),
      name: pickEpisodeTitle(ep) ?? "",
      airDate: date,
      releaseTime: time,
      releaseAtMs: atMs,
      image: ep.image ?? null,
      overview: ep.overview ?? "",
      voteAverage: 0,
    });
  }
  // AniZip has no series-poster field, only small per-episode stills, so the
  // per-episode images are frequently low-resolution. Resolve a proper poster
  // via the TMDB cross-reference AniZip already supplies, when available.
  let poster: string | null = null;
  const tmdbId = mapping.mappings?.themoviedb_id;
  const numTmdbId = typeof tmdbId === "string" ? Number(tmdbId) : tmdbId;
  if (tmdbKey && numTmdbId != null && Number.isFinite(numTmdbId)) {
    poster = await tmdbTvPoster(tmdbKey, numTmdbId).catch(() => null);
  }
  return {
    name: mapping.titles?.en ?? mapping.titles?.["x-jat"] ?? "",
    poster,
    isAnime: true,
    episodes,
  };
}

async function tmdbSeries(
  id: string,
  inWindow: (date: string) => boolean,
  tmdbKey: string,
): Promise<ResolvedSeries | null> {
  let tvId: number | null = null;
  if (id.startsWith("tmdb:tv:")) tvId = Number(id.split(":")[2]);
  else if (id.startsWith("tt")) tvId = (await tmdbFindByImdb(tmdbKey, id.split(":")[0])).tvId;
  if (tvId == null || !Number.isFinite(tvId)) return null;
  return tmdbTvUpcoming(tmdbKey, tvId, inWindow);
}

/** Cinemeta writes a finished run as "2008–2013" and an ongoing one as "2019–". */
function cinemetaRunEnded(releaseInfo: string | undefined): boolean {
  const m = /^\s*\d{4}\s*[–-]\s*(\d{4})\s*$/.exec(releaseInfo ?? "");
  return !!m && Number(m[1]) < new Date().getFullYear();
}

async function cinemetaSeriesUpcoming(
  id: string,
  inWindow: (date: string) => boolean,
): Promise<{ resolved: ResolvedSeries | null; ended: boolean }> {
  const imdb = id.startsWith("tt") ? id.split(":")[0] : null;
  if (!imdb) return { resolved: null, ended: false };
  const m = await cinemetaMeta("series", imdb);
  if (!m) return { resolved: null, ended: false };
  const ended = cinemetaRunEnded(m.releaseInfo);
  if (!m.videos) return { resolved: null, ended };
  const episodes: ResolvedEpisode[] = [];
  for (const v of m.videos) {
    const { date, time, atMs } = localDateTimeFromIso(v.released ?? v.firstAired);
    if (!date || !inWindow(date)) continue;
    const number = v.episode ?? v.number;
    if (number == null) continue;
    episodes.push({
      season: v.season ?? 0,
      number,
      name: v.name ?? v.title ?? "",
      airDate: date,
      releaseTime: time,
      releaseAtMs: atMs,
      image: v.thumbnail ?? null,
      overview: "",
      voteAverage: 0,
    });
  }
  if (episodes.length === 0) return { resolved: null, ended };
  return {
    resolved: {
      name: m.name,
      poster: m.poster ?? null,
      isAnime: isAnimationGenre(m.genres),
      episodes,
    },
    ended: false,
  };
}

async function seriesUpcoming(
  c: Candidate,
  inWindow: (date: string) => boolean,
  tmdbKey: string,
): Promise<ResolvedSeries | null> {
  if (isAnimeId(c.id)) return animeUpcoming(c.id, inWindow, tmdbKey);
  let cinemetaEnded = false;
  if (c.id.startsWith("tt")) {
    const cm = await cinemetaSeriesUpcoming(c.id, inWindow);
    if (cm.resolved) return cm.resolved;
    // A finished run has no upcoming episodes, so TVMaze is skipped. Trade-off: a revived
    // show whose Cinemeta entry has not been updated stays hidden until Cinemeta catches up.
    cinemetaEnded = cm.ended;
  }
  if (tmdbKey) {
    const t = await tmdbSeries(c.id, inWindow, tmdbKey);
    if (t) return t;
  } else if (c.id.startsWith("tt") && !cinemetaEnded) {
    const up = await tvmazeUpcoming(c.id.split(":")[0], inWindow);
    if (up) {
      return {
        name: up.show.name,
        poster: up.show.image,
        isAnime: up.show.isAnime,
        episodes: up.episodes.map((e) => ({
          season: e.season,
          number: e.number,
          name: e.name,
          airDate: e.airdate,
          image: e.image,
          overview: e.summary,
          voteAverage: 0,
        })),
      };
    }
  }
  return null;
}

async function movieRelease(
  c: Candidate,
  inWindow: (date: string) => boolean,
  tmdbKey: string,
): Promise<CalendarItem | null> {
  const imdb = c.id.startsWith("tt") ? c.id.split(":")[0] : null;
  let movieId: number | null = null;
  if (c.id.startsWith("tmdb:movie:")) movieId = Number(c.id.split(":")[2]);
  else if (imdb && tmdbKey) movieId = (await tmdbFindByImdb(tmdbKey, imdb)).movieId;

  if (movieId != null && Number.isFinite(movieId) && tmdbKey) {
    const m = await tmdbMovieRelease(tmdbKey, movieId);
    if (!m || !inWindow(m.releaseDate)) return null;
    return {
      id: c.id,
      imdbId: imdb,
      type: "movie",
      name: m.name || c.name,
      poster: m.poster,
      background: m.background,
      releaseDate: m.releaseDate,
      isAnime: m.isAnime,
      overview: m.overview,
      voteAverage: m.voteAverage,
    };
  }
  if (imdb) {
    const m = await cinemetaMeta("movie", imdb);
    if (!m) return null;
    const date = (m.releaseDate ?? "").slice(0, 10);
    if (!inWindow(date)) return null;
    return {
      id: m.id,
      imdbId: imdb,
      type: "movie",
      name: m.name,
      poster: m.poster ?? null,
      background: m.background ?? null,
      releaseDate: date,
      isAnime: isAnimationGenre(m.genres),
      overview: m.description ?? "",
      voteAverage: parseFloat(m.imdbRating ?? "0") || 0,
    };
  }
  return null;
}

function gatherCandidates(
  stremio: LibraryItem[],
  local: ReturnType<typeof readLocalEntries>,
  trakt: Awaited<ReturnType<typeof fetchTraktWatchlist>>,
  watched: Candidate[],
): Candidate[] {
  const byId = new Map<string, Candidate>();
  const add = (c: Candidate) => {
    const prev = byId.get(c.id);
    if (!prev) byId.set(c.id, c);
    else
      byId.set(c.id, {
        ...prev,
        temp: prev.temp && c.temp,
        mtime: Math.max(prev.mtime, c.mtime),
        name: prev.name || c.name,
      });
  };
  for (const i of stremio) {
    if (i.removed) continue;
    add({
      id: i._id,
      type: i.type === "series" ? "series" : "movie",
      name: i.name ?? "",
      mtime: Date.parse(i._mtime ?? "") || 0,
      temp: !!i.temp,
    });
  }
  for (const e of local) {
    add({ id: e.id, type: e.type, name: e.name ?? "", mtime: e.addedAt || 0, temp: false });
  }
  for (const t of trakt) {
    const id =
      t.ids.imdb ??
      (t.ids.tmdb
        ? t.type === "movie"
          ? `tmdb:movie:${t.ids.tmdb}`
          : `tmdb:tv:${t.ids.tmdb}`
        : null);
    if (!id) continue;
    add({
      id,
      type: t.type === "show" ? "series" : "movie",
      name: t.title ?? "",
      mtime: Date.parse(t.contextDate ?? "") || 0,
      temp: false,
    });
  }
  // Anime with a Kitsu/MAL/AniList id is deliberately never written to the
  // Stremio library (cloudWriteId/libraryPut return for anime ids), so a show
  // the user started watching only lives in Continue Watching and manual-watched
  // state. Include those, or a just-started anime never reaches this calendar.
  for (const c of watched) add(c);
  return Array.from(byId.values());
}

function locallyWatchedCandidates(): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  const push = (id: string, type: "movie" | "series", name: string, mtime: number) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push({ id, type, name, mtime, temp: false });
  };
  for (const i of manualWatchedLibraryItems()) {
    push(
      i._id,
      i.type === "anime" || i.type === "series" ? "series" : "movie",
      i.name ?? "",
      Date.parse(i._mtime ?? "") || 0,
    );
  }
  for (const e of listLocalCw()) {
    push(e.id, e.type === "movie" ? "movie" : "series", e.name ?? "", e.t || 0);
  }
  return out;
}

const curatedFirst = (a: Candidate, b: Candidate) =>
  (a.temp ? 1 : 0) - (b.temp ? 1 : 0) || b.mtime - a.mtime;

/**
 * The same anime is often in the library twice: once as a Kitsu/MAL/AniList row
 * (started watching) and once as its IMDb/TMDB row (porvider metadata). They
 * resolve to the same franchise but with different names and provider dates, so
 * the per-episode dedup cannot see the overlap. When an anime-scheme candidate
 * covers a franchise, drop the catalog candidate for that same franchise.
 */
async function candidateRoot(id: string): Promise<string> {
  if (isAnimeId(id) || id.startsWith("anidb:")) return franchiseRoot(id).catch(() => id);
  // franchiseRoot knows imdb and anime-scheme ids, but not tmdb:tv — bridge it.
  let kitsu: number | null = null;
  if (/^tt\d+/.test(id)) kitsu = await imdbToKitsu(id.split(":")[0]).catch(() => null);
  else if (id.startsWith("tmdb:tv:")) {
    const n = Number(id.split(":")[2]);
    kitsu = Number.isFinite(n) ? await tmdbTvToKitsu(n).catch(() => null) : null;
  }
  if (kitsu == null) return id;
  return franchiseRoot(`kitsu:${kitsu}`).catch(() => `kitsu:${kitsu}`);
}

export async function fetchLibraryCalendar(
  authKey: string,
  year: number,
  month: number,
  opts: CalendarResolveOptions & { includeTrakt: boolean },
): Promise<CalendarItem[]> {
  const prepared = await prepareCalendarCandidates(opts, async () => {
    const local = readLocalEntries();
    const finish = measureDiagnostic("calendar.library.candidates");
    let stremioFailed = false;
    let traktFailed = false;
    const [stremio, trakt] = await Promise.all([
      authKey
        ? library(authKey).catch(() => {
            stremioFailed = true;
            return [] as LibraryItem[];
          })
        : Promise.resolve([]),
      opts.includeTrakt
        ? fetchTraktWatchlist(true).catch(() => {
            traktFailed = true;
            return [];
          })
        : Promise.resolve([]),
    ]);

    const gathered = gatherCandidates(stremio, local, trakt, locallyWatchedCandidates());
    // Map franchises within the bounded title queue, so duplicate detection
    // cannot block gathering the entire library before the first publication.
    const candidates = gathered;
    finish(stremioFailed && candidates.length === 0 ? "error" : "ok", {
      candidates: candidates.length,
    });
    if (stremioFailed || traktFailed) throw new Error("Couldn't load your library");
    return candidates;
  });
  const candidates = prepared.candidates;
  if (candidates.length === 0) return [];
  return resolveSavedCalendar(candidates, year, month, {
    ...prepared.options,
    deduplicateCatalogs: true,
  });
}

async function resolveSeriesCached(
  c: SavedCandidate,
  tmdbKey: string,
): Promise<ResolvedSeries | null> {
  const key = JSON.stringify([calendarScopeKey(), tmdbKey, effectiveTmdbLanguage(), c.id, c.name]);
  return seriesCache.fetch(key, () => seriesUpcoming(c, wideWindow(), tmdbKey));
}

async function resolveMovieCached(
  c: SavedCandidate,
  tmdbKey: string,
): Promise<CalendarItem | null> {
  const key = JSON.stringify([calendarScopeKey(), tmdbKey, effectiveTmdbLanguage(), c.id, c.name]);
  return movieCache.fetch(key, () => movieRelease(c, wideWindow(), tmdbKey));
}

export async function resolveSavedCalendar(
  candidates: SavedCandidate[],
  year: number,
  month: number,
  opts: CalendarResolveOptions,
): Promise<CalendarItem[]> {
  const inMonth = inMonthFactory(year, month);
  const series = candidates.filter((c) => c.type === "series").sort(curatedFirst);
  const movies = candidates.filter((c) => c.type === "movie").sort(curatedFirst);

  const seriesResults: Array<{ c: SavedCandidate; r: ResolvedSeries | null }> = [];
  const movieResults: Array<CalendarItem | null> = [];
  const roots = new Map<string, string>();
  const animeRoots = new Set<string>();
  const deduplicate = opts.deduplicateCatalogs && series.some((c) => isAnimeId(c.id));
  const controller = new AbortController();
  let reason: CalendarResolutionStatus["reason"];
  let resolved = 0;
  let failed = 0;
  const total = series.length + movies.length;
  const stop = () => {
    reason ??= "cancelled";
    controller.abort();
  };
  opts.signal?.addEventListener("abort", stop, { once: true });
  if (opts.signal?.aborted) stop();
  const timeout =
    opts.maxMs == null
      ? undefined
      : setTimeout(
          () => {
            reason = "deadline";
            controller.abort();
          },
          Math.max(0, opts.maxMs),
        );
  const snapshot = () =>
    calendarSnapshot(
      seriesResults.filter((result) => {
        if (!result || isAnimeId(result.c.id)) return true;
        const root = roots.get(result.c.id);
        return root == null || !animeRoots.has(root);
      }),
      movieResults,
      inMonth,
    );
  const status = (): CalendarResolutionStatus => ({
    resolved,
    failed,
    pending: total - resolved - failed,
    complete: !reason && !failed && resolved === total,
    reason: reason ?? (failed ? "failed" : undefined),
  });
  let lastPublish = -Infinity;
  let publishTimer: ReturnType<typeof setTimeout> | undefined;
  const publish = (flush = false) => {
    if (controller.signal.aborted) return;
    const remaining = 100 - (Date.now() - lastPublish);
    if (!flush && remaining > 0) {
      publishTimer ??= setTimeout(() => {
        publishTimer = undefined;
        publish(true);
      }, remaining);
      return;
    }
    if (publishTimer !== undefined) clearTimeout(publishTimer);
    publishTimer = undefined;
    lastPublish = Date.now();
    opts.onSnapshot?.(snapshot(), status());
  };
  const resolveTitle = <T>(promise: Promise<T>): Promise<T> =>
    new Promise((resolve, reject) => {
      const abort = () => finish(() => reject(new Error("Calendar cancelled")));
      const finish = (complete: () => void) => {
        clearTimeout(timer);
        controller.signal.removeEventListener("abort", abort);
        complete();
      };
      const timer = setTimeout(
        () => finish(() => reject(new Error("Calendar title timed out"))),
        TITLE_TIMEOUT_MS,
      );
      controller.signal.addEventListener("abort", abort, { once: true });
      if (controller.signal.aborted) abort();
      promise.then(
        (value) => finish(() => resolve(value)),
        (error) => finish(() => reject(error)),
      );
    });
  const work = async (c: SavedCandidate, index: number) => {
    try {
      if (c.type === "series") {
        let r: ResolvedSeries | null;
        let root: string;
        if (isAnimeId(c.id)) {
          [r, root] = await resolveTitle(
            Promise.all([
              resolveSeriesCached(c, opts.tmdbKey),
              deduplicate ? candidateRoot(c.id) : Promise.resolve(c.id),
            ]),
          );
        } else {
          // Only titles with episodes this month render, so the ani.zip franchise lookup
          // (a serial queue) is skipped for every other series.
          r = await resolveTitle(resolveSeriesCached(c, opts.tmdbKey));
          const renders = (r?.episodes ?? []).some(
            (ep) => !(ep.season === 0 && ep.number === 0) && inMonth(ep.airDate),
          );
          root = deduplicate && renders ? await resolveTitle(candidateRoot(c.id)) : c.id;
        }
        if (controller.signal.aborted) return;
        roots.set(c.id, root);
        if (isAnimeId(c.id)) animeRoots.add(root);
        seriesResults[index] = { c, r };
      } else {
        const r = await resolveTitle(resolveMovieCached(c, opts.tmdbKey));
        if (controller.signal.aborted) return;
        movieResults[index] = r;
      }
      resolved++;
    } catch {
      if (controller.signal.aborted) return;
      failed++;
    }
    publish();
  };
  const finish = measureDiagnostic("calendar.library.resolve");
  const stopped = new Promise<void>((resolve) => {
    if (controller.signal.aborted) resolve();
    else controller.signal.addEventListener("abort", () => resolve(), { once: true });
  });
  try {
    // One queue keeps the TMDB cap shared across movies and series. Without a
    // TMDB key, series and movies run in separate queues. Series mostly wait on
    // Cinemeta, so they use the same width; TVMaze's own cap lives in tvmaze.ts.
    const tasks = opts.tmdbKey
      ? mapLimit(
          Array.from({ length: Math.max(series.length, movies.length) }, (_, index) =>
            [series[index], movies[index]]
              .filter((c): c is SavedCandidate => c !== undefined)
              .map((c) => ({ c, index })),
          ).flat(),
          TMDB_CONCURRENCY,
          ({ c, index }) => work(c, index),
          { signal: controller.signal },
        )
      : Promise.all([
          mapLimit(
            series.map((c, index) => ({ c, index })),
            TMDB_CONCURRENCY,
            ({ c, index }) => work(c, index),
            { signal: controller.signal },
          ),
          mapLimit(
            movies.map((c, index) => ({ c, index })),
            TMDB_CONCURRENCY,
            ({ c, index }) => work(c, index),
            { signal: controller.signal },
          ),
        ]);
    await Promise.race([tasks, stopped]);
    publish(true);
    const rows = snapshot();
    const finalStatus = status();
    finish(finalStatus.complete ? "ok" : "error", { series: series.length, movies: movies.length });
    if (!finalStatus.complete) throw new IncompleteCalendarError(rows, finalStatus);
    return rows;
  } finally {
    controller.abort();
    if (publishTimer !== undefined) clearTimeout(publishTimer);
    if (timeout !== undefined) clearTimeout(timeout);
    opts.signal?.removeEventListener("abort", stop);
  }
}

function calendarSnapshot(
  seriesResults: Array<{ c: SavedCandidate; r: ResolvedSeries | null }>,
  movieResults: Array<CalendarItem | null>,
  inMonth: (iso: string) => boolean,
): CalendarItem[] {
  const out: CalendarItem[] = [];
  for (const result of seriesResults) {
    if (!result?.r) continue;
    const { c, r } = result;
    const showName = r.name || c.name;
    for (const ep of r.episodes) {
      if (ep.season === 0 && ep.number === 0) continue;
      if (!inMonth(ep.airDate)) continue;
      const epLabel = `S${pad(ep.season)}E${pad(ep.number)}`;
      out.push({
        id: `${c.id}:${ep.season}:${ep.number}`,
        imdbId: c.id.startsWith("tt") ? c.id.split(":")[0] : null,
        type: "tv",
        name: ep.name ? `${showName} ${epLabel}: ${ep.name}` : `${showName} ${epLabel}`,
        poster: r.poster ?? ep.image ?? null,
        background: null,
        releaseDate: ep.airDate,
        releaseTime: ep.releaseTime,
        releaseAtMs: ep.releaseAtMs,
        isAnime: r.isAnime,
        overview: ep.overview,
        voteAverage: ep.voteAverage,
      });
    }
  }

  for (const mi of movieResults) if (mi && inMonth(mi.releaseDate)) out.push(mi);

  const seen = new Set<string>();
  const unique: CalendarItem[] = [];
  const episodeOf = (item: CalendarItem) => item.name.match(/\sS(\d+)E(\d+)/i);
  const showKeyOf = (item: CalendarItem, ep: RegExpMatchArray) =>
    item.name
      .slice(0, item.name.indexOf(ep[0]))
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "");
  for (const item of out) {
    const ep = episodeOf(item);
    const key = ep
      ? `tv|${showKeyOf(item, ep)}|s${Number(ep[1])}e${Number(ep[2])}|${item.releaseDate}`
      : `movie|${item.name.toLowerCase().replace(/[^a-z0-9]+/g, "")}|${item.releaseDate}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  // TMDB merges a sequel into the parent season, so a single airing can arrive
  // as both S1E14 and S2E03 on the same date. When a show reports several
  // seasons on one date, keep the newest season; the older label is the merge.
  const byShowDate = new Map<string, CalendarItem[]>();
  const deduped: CalendarItem[] = [];
  for (const item of unique) {
    const ep = episodeOf(item);
    if (!ep) {
      deduped.push(item);
      continue;
    }
    const key = `tv|${showKeyOf(item, ep)}|${item.releaseDate}`;
    const list = byShowDate.get(key);
    if (list) list.push(item);
    else byShowDate.set(key, [item]);
  }
  for (const list of byShowDate.values()) {
    if (list.length === 1) {
      deduped.push(list[0]);
      continue;
    }
    const seasons = new Map<number, CalendarItem[]>();
    for (const item of list) {
      const season = Number(episodeOf(item)![1]);
      const bucket = seasons.get(season);
      if (bucket) bucket.push(item);
      else seasons.set(season, [item]);
    }
    if (seasons.size > 1) {
      const newest = Math.max(...seasons.keys());
      deduped.push(...seasons.get(newest)!);
    } else {
      deduped.push(...list);
    }
  }
  deduped.sort((a, b) => a.releaseDate.localeCompare(b.releaseDate));
  return deduped;
}
