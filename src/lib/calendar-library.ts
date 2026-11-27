import { effectiveTmdbLanguage, get as tmdbGet } from "./providers/tmdb/tmdb-client";
import { mapCalendarLimit as mapLimit } from "./calendar-scheduler";
import { CalendarCache } from "./calendar-cache";
import { registerCalendarCache } from "./calendar-cache-scope";
import { cacheInstallationSalt } from "./cache-scope";
import { readMediaValue, removeMediaNamespaces, saveMedia } from "./media-cache";
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
import { anilistAnimeEntry } from "./anilist/entry";
import { fetchAnilistAiringSchedule, type AnilistAiringSchedule } from "./anilist/next-airing";
import { imdbToKitsu, kitsuToAnilist, tmdbTvToKitsu } from "./providers/anime-mapping";
import { resolveTrackerAnimeEntry } from "./anime-tracker-entry";
import { franchiseRoot } from "./providers/anime-franchise-root";
import type { CalendarItem } from "./calendar-core";
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
const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * A saved title is shown immediately and re-checked in the background once it is older than
 * its re-check age, so a surprise announcement appears within days rather than at expiry.
 * Each entry covers 31 days back to 400 days ahead, so an old one still covers every month
 * the calendar can show.
 */
const TITLE_RECHECK_MS = 3 * DAY_MS;
const TITLE_DISK_TTL_MS = 30 * DAY_MS;
/** A show whose whole run has ended, or a movie released before the window, rarely changes. */
const ENDED_RECHECK_MS = 30 * DAY_MS;
const ENDED_DISK_TTL_MS = 180 * DAY_MS;
/** Background re-checks wait for the first load and use a small share of the TMDB queue. */
const RECHECK_DELAY_MS = 8_000;
const RECHECK_CONCURRENCY = 2;
const KNOWN_TITLES_MAX = 4_000;
const TITLE_PREFIX = "calendar-title-";
let titleEpoch = 0;
// A title's schedule does not depend on library membership, so library changes keep
// these caches and a refresh only resolves newly added or expired titles.
registerCalendarCache((purge = true) => {
  if (!purge) return;
  titleEpoch++;
  seriesCache.clear();
  movieCache.clear();
  knownTitles.clear();
  recheckQueue.clear();
  rechecked.clear();
  void removeMediaNamespaces(TITLE_PREFIX).catch(() => {});
});

/** What a resolver learned besides the value: whether the title is finished, and its TMDB id. */
type TitleMeta = { ended: boolean; tmdb: number | null };
type SavedTitleEntry<T> = { value: T; checkedAt?: number; ended?: boolean; tmdb?: number | null };
type KnownTitle = {
  kind: "series" | "movie";
  tmdb: number | null;
  checkedAt: number;
  recheck: () => Promise<void>;
};

/** Titles read this session, keyed by their memory-cache key. */
const knownTitles = new Map<string, KnownTitle>();
/** Queued re-checks; `true` marks a requested one (Refresh or the TMDB change list). */
const recheckQueue = new Map<string, boolean>();
/** Automatic re-checks run at most once per title per session. */
const rechecked = new Set<string>();
let recheckActive = 0;
let recheckTimer: ReturnType<typeof setTimeout> | undefined;
let refreshing: { done: Promise<void>; finish: () => void } | null = null;
let titlesChanged = false;
let lastTitleNotify = 0;
let titleRevision = 0;
const titleListeners = new Set<() => void>();

/** `changed` re-runs the visible month; otherwise only the Refresh state is reported. */
function notifyTitles(changed = true): void {
  if (changed) {
    titleRevision++;
    lastTitleNotify = Date.now();
  }
  for (const listener of titleListeners) listener();
}

/** Changes when a background re-check updated a title, or a Refresh started or finished. */
export function libraryTitleRevision(): number {
  return titleRevision;
}

export function subscribeLibraryTitles(listener: () => void): () => void {
  titleListeners.add(listener);
  return () => titleListeners.delete(listener);
}

export function libraryTitlesRefreshing(): boolean {
  return refreshing !== null;
}

/** Re-checks every title this session has shown, keeping the saved ones on screen meanwhile. */
export function refreshLibraryCalendarTitles(): Promise<void> {
  if (refreshing) return refreshing.done;
  for (const key of knownTitles.keys()) recheckQueue.set(key, true);
  if (!recheckQueue.size) return Promise.resolve();
  let finish = () => {};
  const done = new Promise<void>((resolve) => (finish = resolve));
  refreshing = { done, finish };
  notifyTitles(false);
  pumpRechecks();
  return done;
}

function queueRecheck(key: string, requested: boolean): void {
  if (!requested && (rechecked.has(key) || recheckQueue.has(key))) return;
  recheckQueue.set(key, requested || recheckQueue.get(key) === true);
  if (requested) pumpRechecks();
  else
    recheckTimer ??= setTimeout(() => {
      recheckTimer = undefined;
      pumpRechecks();
    }, RECHECK_DELAY_MS);
}

/** Requested re-checks first, then the title checked longest ago. */
function nextRecheck(): string | undefined {
  let best: string | undefined;
  let bestRequested = false;
  let bestAt = Infinity;
  for (const [key, requested] of recheckQueue) {
    const at = knownTitles.get(key)?.checkedAt ?? 0;
    if ((requested && !bestRequested) || (requested === bestRequested && at < bestAt)) {
      best = key;
      bestRequested = requested;
      bestAt = at;
    }
  }
  return best;
}

function pumpRechecks(): void {
  const limit = refreshing ? TMDB_CONCURRENCY : RECHECK_CONCURRENCY;
  while (recheckActive < limit) {
    const key = nextRecheck();
    if (key === undefined) break;
    recheckQueue.delete(key);
    rechecked.add(key);
    const title = knownTitles.get(key);
    if (!title) continue;
    recheckActive++;
    void title
      .recheck()
      .catch(() => {})
      .finally(() => {
        recheckActive--;
        // Batch screen updates: each one re-runs the visible month from memory.
        if (titlesChanged && Date.now() - lastTitleNotify > 4_000) {
          titlesChanged = false;
          notifyTitles();
        }
        pumpRechecks();
      });
  }
  if (recheckActive || recheckQueue.size) return;
  const finished = refreshing;
  refreshing = null;
  if (titlesChanged || finished) {
    notifyTitles(titlesChanged);
    titlesChanged = false;
  }
  finished?.finish();
}

/** TMDB's change lists name every title edited in a date range, so edits surface within a day. */
const CHANGES_STORAGE_KEY = "harbor.calendar.tmdb-changes.v1";
const CHANGES_MAX_DAYS = 14;
/** Each page lists 100 ids. A busy range is read partially; the age re-check still applies. */
const CHANGES_MAX_PAGES = 60;
let changesScheduled = false;

function scheduleTmdbChanges(tmdbKey: string): void {
  if (!tmdbKey || changesScheduled) return;
  changesScheduled = true;
  setTimeout(() => void checkTmdbChanges(tmdbKey).catch(() => {}), RECHECK_DELAY_MS * 2);
}

function readChangesCheckedAt(): number {
  try {
    return Number(localStorage.getItem(CHANGES_STORAGE_KEY)) || 0;
  } catch {
    return 0;
  }
}

function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

async function changedTmdbIds(
  tmdbKey: string,
  kind: "tv" | "movie",
  startDate: string,
  endDate: string,
): Promise<Set<number> | null> {
  type Page = { results?: Array<{ id?: number }>; total_pages?: number };
  const read = (page: number) =>
    tmdbGet<Page>(tmdbKey, `${kind}/changes`, {
      start_date: startDate,
      end_date: endDate,
      page: String(page),
    });
  const first = await read(1);
  if (!first) return null;
  const pages = Math.min(first.total_pages ?? 1, CHANGES_MAX_PAGES);
  const rest = await mapLimit(
    Array.from({ length: Math.max(0, pages - 1) }, (_, i) => i + 2),
    RECHECK_CONCURRENCY,
    (page) => read(page).catch(() => null),
  );
  const ids = new Set<number>();
  for (const page of [first, ...rest]) {
    if (!page) return null;
    for (const row of page.results ?? []) if (Number.isFinite(row.id)) ids.add(row.id as number);
  }
  return ids;
}

/** At most once a day: re-check every known title TMDB reports as edited since the last run. */
export async function checkTmdbChanges(tmdbKey: string, now = Date.now()): Promise<number> {
  const last = readChangesCheckedAt();
  if (now - last < DAY_MS) return 0;
  // Titles checked before the range began are already due for their age re-check.
  const start = Math.max(last || now - TITLE_RECHECK_MS, now - CHANGES_MAX_DAYS * DAY_MS);
  const [tv, movie] = await Promise.all([
    changedTmdbIds(tmdbKey, "tv", utcDate(start), utcDate(now)),
    changedTmdbIds(tmdbKey, "movie", utcDate(start), utcDate(now)),
  ]);
  // A failed page leaves the range unchecked, so the next launch reads it again.
  if (!tv || !movie) return 0;
  try {
    localStorage.setItem(CHANGES_STORAGE_KEY, String(now));
  } catch {
    /* The age re-check still applies without a stored time. */
  }
  let queued = 0;
  for (const [key, title] of knownTitles) {
    if (title.tmdb == null || title.checkedAt >= now) continue;
    if (!(title.kind === "series" ? tv : movie).has(title.tmdb)) continue;
    queueRecheck(key, true);
    queued++;
  }
  return queued;
}

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

/** Preserve entry-relative episode numbers when correcting a library calendar. */
export function applyAnilistCalendarDates(
  episodes: ResolvedEpisode[],
  schedule: AnilistAiringSchedule | null,
): void {
  if (!schedule) return;
  // A single AniList entry must never date episodes from another cour.
  const seasons = new Set(episodes.filter((ep) => ep.season > 0).map((ep) => ep.season));
  if (seasons.size !== 1) return;
  for (const episode of episodes) {
    if (episode.season <= 0) continue;
    const airingAt = schedule[episode.number];
    if (!Number.isFinite(airingAt) || airingAt <= 0) continue;
    const { date, time, atMs } = localDateTimeFromIso(new Date(airingAt * 1000).toISOString());
    episode.airDate = date;
    episode.releaseTime = time;
    episode.releaseAtMs = atMs;
  }
}

async function animeUpcoming(
  id: string,
  inWindow: (date: string) => boolean,
  tmdbKey: string,
  meta: TitleMeta,
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
    if (!date) continue;
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
  // AniZip episode dates can lag the cour by a week. Prefer the exact AniList
  // schedule for the requested entry, not a sibling sharing its TVDB series.
  const anilistId = id.startsWith("anilist:")
    ? numId
    : id.startsWith("mal:")
      ? ((await anilistAnimeEntry(numId, "mal").catch(() => null))?.id ?? null)
      : await kitsuToAnilist(numId).catch(() => null);
  if (anilistId != null) {
    const schedule = await fetchAnilistAiringSchedule(anilistId).catch(() => null);
    applyAnilistCalendarDates(episodes, schedule);
  }
  // AniList may move an episode across month boundaries; filter after correction.
  const upcomingEpisodes = episodes.filter((episode) => inWindow(episode.airDate));
  // AniZip has no series-poster field, only small per-episode stills, so the
  // per-episode images are frequently low-resolution. Resolve a proper poster
  // via the TMDB cross-reference AniZip already supplies, when available.
  let poster: string | null = null;
  const tmdbId = mapping.mappings?.themoviedb_id;
  const numTmdbId = typeof tmdbId === "string" ? Number(tmdbId) : tmdbId;
  if (numTmdbId != null && Number.isFinite(numTmdbId)) meta.tmdb = numTmdbId;
  if (tmdbKey && numTmdbId != null && Number.isFinite(numTmdbId)) {
    poster = await tmdbTvPoster(tmdbKey, numTmdbId).catch(() => null);
  }
  return {
    name: mapping.titles?.en ?? mapping.titles?.["x-jat"] ?? "",
    poster,
    isAnime: true,
    episodes: upcomingEpisodes,
  };
}

async function tmdbSeries(
  id: string,
  inWindow: (date: string) => boolean,
  tmdbKey: string,
  meta: TitleMeta,
): Promise<ResolvedSeries | null> {
  const tvId = await seriesTmdbId(id, tmdbKey, meta);
  if (tvId == null) return null;
  return tmdbTvUpcoming(tmdbKey, tvId, inWindow);
}

/** Reuses the id saved with the title, so a re-check skips the IMDb lookup. */
async function seriesTmdbId(id: string, tmdbKey: string, meta: TitleMeta): Promise<number | null> {
  let tvId: number | null = meta.tmdb;
  if (tvId == null && id.startsWith("tmdb:tv:")) tvId = Number(id.split(":")[2]);
  else if (tvId == null && id.startsWith("tt") && tmdbKey)
    tvId = (await tmdbFindByImdb(tmdbKey, id.split(":")[0])).tvId;
  if (tvId == null || !Number.isFinite(tvId)) return null;
  meta.tmdb = tvId;
  return tvId;
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

/** Use verified native cour episode owners for IMDb/TMDB library calendar rows. */
async function correctCatalogAnimeAirings(
  metaId: string,
  series: ResolvedSeries,
  year: number,
  month: number,
): Promise<ResolvedSeries> {
  if (!series.isAnime || series.episodes.length === 0) return series;
  const start = new Date(year, month, -7).getTime();
  const end = new Date(year, month + 1, 8).getTime();
  // Keep the same-date sequel rather than a parent S1E14 proxy for S2E03.
  const highestSeason = new Map<string, number>();
  for (const ep of series.episodes) {
    highestSeason.set(ep.airDate, Math.max(highestSeason.get(ep.airDate) ?? 0, ep.season));
  }
  const episodes = series.episodes.filter((ep) => ep.season === highestSeason.get(ep.airDate));
  const near = episodes.filter((ep) => {
    const date = Date.parse(ep.airDate);
    return ep.season > 0 && ep.number > 0 && Number.isFinite(date) && date >= start && date < end;
  });
  await mapLimit(near, 4, async (episode) => {
    const owner = await resolveTrackerAnimeEntry(metaId, {
      season: episode.season,
      episode: episode.number,
    }).catch(() => null);
    if (!owner) return;
    const match = /^anilist:([1-9]\d*)$/.exec(owner.id);
    const kitsu = /^kitsu:([1-9]\d*)$/.exec(owner.id);
    const anilistId = match
      ? Number(match[1])
      : kitsu
        ? await kitsuToAnilist(Number(kitsu[1])).catch(() => null)
        : null;
    if (anilistId == null) return;
    const schedule = await fetchAnilistAiringSchedule(anilistId).catch(() => null);
    const airingAt = schedule?.[owner.episode];
    if (!Number.isFinite(airingAt) || !airingAt || airingAt <= 0) return;
    const { date, time, atMs } = localDateTimeFromIso(new Date(airingAt * 1000).toISOString());
    episode.airDate = date;
    episode.releaseTime = time;
    episode.releaseAtMs = atMs;
  });
  return { ...series, episodes };
}

async function seriesUpcoming(
  c: Candidate,
  inWindow: (date: string) => boolean,
  tmdbKey: string,
  year: number,
  month: number,
  meta: TitleMeta = { ended: false, tmdb: null },
  background = false,
): Promise<ResolvedSeries | null> {
  if (isAnimeId(c.id)) return animeUpcoming(c.id, inWindow, tmdbKey, meta);
  let cinemetaEnded = false;
  if (c.id.startsWith("tt")) {
    const cm = await cinemetaSeriesUpcoming(c.id, inWindow);
    if (cm.resolved) {
      // The TMDB id only serves the change list, so a first load does not wait for it.
      if (background && tmdbKey) await seriesTmdbId(c.id, tmdbKey, meta).catch(() => null);
      return correctCatalogAnimeAirings(c.id, cm.resolved, year, month);
    }
    // A finished run has no upcoming episodes, so TVMaze is skipped. Trade-off: a revived
    // show whose Cinemeta entry has not been updated stays hidden until its monthly re-check
    // or, with a TMDB key, until TMDB lists it as changed.
    cinemetaEnded = cm.ended;
    meta.ended = cm.ended;
  }
  if (tmdbKey) {
    const t = await tmdbSeries(c.id, inWindow, tmdbKey, meta);
    if (t) {
      meta.ended = false;
      return correctCatalogAnimeAirings(c.id, t, year, month);
    }
  } else if (c.id.startsWith("tt") && !cinemetaEnded) {
    const up = await tvmazeUpcoming(c.id.split(":")[0], inWindow);
    if (up) {
      return correctCatalogAnimeAirings(
        c.id,
        {
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
        },
        year,
        month,
      );
    }
  }
  return null;
}

async function movieRelease(
  c: Candidate,
  inWindow: (date: string) => boolean,
  tmdbKey: string,
  meta: TitleMeta = { ended: false, tmdb: null },
): Promise<CalendarItem | null> {
  const imdb = c.id.startsWith("tt") ? c.id.split(":")[0] : null;
  let movieId: number | null = meta.tmdb;
  if (movieId == null && c.id.startsWith("tmdb:movie:")) movieId = Number(c.id.split(":")[2]);
  else if (movieId == null && imdb && tmdbKey)
    movieId = (await tmdbFindByImdb(tmdbKey, imdb)).movieId;
  if (movieId != null && Number.isFinite(movieId)) meta.tmdb = movieId;
  // A release before the window is final; a missing or later date can still move.
  const released = (date: string) => {
    const at = Date.parse(date);
    meta.ended = Number.isFinite(at) && at < Date.now() - 31 * DAY_MS;
  };

  if (movieId != null && Number.isFinite(movieId) && tmdbKey) {
    const m = await tmdbMovieRelease(tmdbKey, movieId);
    if (m) released(m.releaseDate);
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
    released(date);
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
  year: number,
  month: number,
): Promise<ResolvedSeries | null> {
  // Anime air dates are corrected per month, so the month is part of the key.
  const scope = [tmdbKey, effectiveTmdbLanguage(), c.id, c.name, year, month];
  const key = JSON.stringify(scope);
  return seriesCache.fetch(key, () =>
    savedTitle(
      "series",
      key,
      scope,
      tmdbKey,
      (meta, background) =>
        seriesUpcoming(c, wideWindow(), tmdbKey, year, month, meta, background),
      (value) => seriesCache.set(key, value),
    ),
  );
}

async function resolveMovieCached(
  c: SavedCandidate,
  tmdbKey: string,
): Promise<CalendarItem | null> {
  const scope = [tmdbKey, effectiveTmdbLanguage(), c.id, c.name];
  const key = JSON.stringify(scope);
  return movieCache.fetch(key, () =>
    savedTitle(
      "movie",
      key,
      scope,
      tmdbKey,
      (meta) => movieRelease(c, wideWindow(), tmdbKey, meta),
      (value) => movieCache.set(key, value),
    ),
  );
}

/**
 * Shows a saved title at once and queues a background re-check when it is due. Failures are
 * never saved. Without an installation salt nothing is written, but re-checks still run.
 */
async function savedTitle<T>(
  kind: "series" | "movie",
  memoryKey: string,
  scope: readonly unknown[],
  tmdbKey: string,
  resolve: (meta: TitleMeta, background: boolean) => Promise<T>,
  remember: (value: T) => void,
): Promise<T> {
  const salt = cacheInstallationSalt();
  const namespace = `${TITLE_PREFIX}${kind}`;
  const diskKey = salt ? [salt, ...scope] : null;
  const epoch = titleEpoch;
  let current: T;
  const track = (value: T, meta: TitleMeta, checkedAt: number) => {
    current = value;
    if (epoch !== titleEpoch) return;
    knownTitles.delete(memoryKey);
    if (knownTitles.size >= KNOWN_TITLES_MAX) {
      const oldest = knownTitles.keys().next().value;
      if (oldest !== undefined) knownTitles.delete(oldest);
    }
    knownTitles.set(memoryKey, {
      kind,
      tmdb: meta.tmdb,
      checkedAt,
      recheck: async () => {
        const next: TitleMeta = { ended: false, tmdb: meta.tmdb };
        const value = await resolve(next, true);
        if (epoch !== titleEpoch) return;
        const changed = JSON.stringify(value) !== JSON.stringify(current);
        store(value, next);
        if (changed) {
          remember(value);
          titlesChanged = true;
        }
      },
    });
  };
  const store = (value: T, meta: TitleMeta) => {
    const checkedAt = Date.now();
    track(value, meta, checkedAt);
    if (!diskKey || epoch !== titleEpoch) return;
    const ttl = meta.ended ? ENDED_DISK_TTL_MS : TITLE_DISK_TTL_MS;
    const entry: SavedTitleEntry<T> = { value, checkedAt, ended: meta.ended, tmdb: meta.tmdb };
    void saveMedia(namespace, diskKey, entry, {
      ttl,
      stale: ttl,
      maxBytes: 256 * 1024,
    }).catch(() => false);
  };
  scheduleTmdbChanges(tmdbKey);
  const saved = diskKey
    ? await readMediaValue<SavedTitleEntry<T>>(namespace, diskKey).catch(() => null)
    : null;
  if (saved && typeof saved === "object" && "value" in saved) {
    const meta: TitleMeta = { ended: saved.ended === true, tmdb: saved.tmdb ?? null };
    // Entries saved before re-checks existed have no time and are re-checked first.
    const checkedAt = Number.isFinite(saved.checkedAt) ? (saved.checkedAt as number) : 0;
    track(saved.value, meta, checkedAt);
    const due = meta.ended ? ENDED_RECHECK_MS : TITLE_RECHECK_MS;
    if (Date.now() - checkedAt >= due) queueRecheck(memoryKey, false);
    return saved.value;
  }
  const meta: TitleMeta = { ended: false, tmdb: null };
  const value = await resolve(meta, false);
  store(value, meta);
  return value;
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
              resolveSeriesCached(c, opts.tmdbKey, year, month),
              deduplicate ? candidateRoot(c.id) : Promise.resolve(c.id),
            ]),
          );
        } else {
          // Only titles with episodes this month render, so the ani.zip franchise lookup
          // (a serial queue) is skipped for every other series.
          r = await resolveTitle(resolveSeriesCached(c, opts.tmdbKey, year, month));
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
