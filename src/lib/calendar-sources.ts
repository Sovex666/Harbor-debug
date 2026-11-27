import { effectiveTmdbLanguage } from "./providers/tmdb/tmdb-client";
import { CalendarCache } from "./calendar-cache";
import {
  calendarScopeKey,
  invalidateCalendarCaches,
  registerCalendarCache,
} from "./calendar-cache-scope";
import { mapCalendarLimit } from "./calendar-scheduler";
import type { CalendarItem } from "./calendar-core";
import { toLocalDateISO, toLocalTimeLabel, localDateTimeFromIso } from "./calendar-time";
import {
  resolveSavedCalendar,
  prepareCalendarCandidates,
  type SavedCandidate,
  type CalendarResolveOptions,
} from "./calendar-library";

export { fetchLibraryCalendar } from "./calendar-library";

const sourceCache = new CalendarCache<CalendarItem[]>(24, 30 * 60 * 1000, true);
const personalSourceCache = new CalendarCache<CalendarItem[]>(12, 60 * 1000);
export const subscribeCalendarSourceCache = (listener: () => void) =>
  sourceCache.subscribe(listener);
export const calendarSourceCacheRevision = (key?: string) =>
  key ? sourceCache.getRevision(key) : 0;
// Set once the lazily loaded Simkl watchlist module has been used here.
let invalidateSimklWatchlist: (() => void) | null = null;
registerCalendarCache(() => {
  sourceCache.clear();
  personalSourceCache.clear();
  invalidateSimklWatchlist?.();
});

function withCalendarCache(
  key: string,
  fetcher: () => Promise<CalendarItem[]>,
): Promise<CalendarItem[]> {
  // Strict providers reject failures; an empty success is authoritative too.
  return sourceCache.fetch(key, fetcher);
}

export function clearCalendarSourceCache() {
  invalidateCalendarCaches();
}

export async function fetchSimklPremieresCalendar(
  year: number,
  month: number,
): Promise<CalendarItem[]> {
  const cacheKey = `simkl-premieres:${year}-${month}`;
  return withCalendarCache(cacheKey, async () => {
    const { clearCalendarCache, fetchSimklCdnCalendar } = await import("./simkl/calendar");
    clearCalendarCache();
    return fetchSimklCdnCalendar(year, month, true);
  });
}

export async function fetchAniListAiringCalendar(
  year: number,
  month: number,
): Promise<CalendarItem[]> {
  const cacheKey = `anilist-airing:${year}-${month}`;
  return withCalendarCache(cacheKey, async () => {
    const { fetchAniListAiringCalendar } = await import("./anilist/airing");
    // Do not turn AniList errors into a successful empty month and cache it.
    return fetchAniListAiringCalendar(year, month);
  });
}

export async function fetchAnimeDubCalendar(year: number, month: number): Promise<CalendarItem[]> {
  const cacheKey = `anime-dub:${year}-${month}`;
  return withCalendarCache(cacheKey, () => mapDubFeedToCalendar(year, month));
}

async function mapDubFeedToCalendar(year: number, month: number): Promise<CalendarItem[]> {
  const { fetchDubSchedule } = await import("./providers/anime-dub-sub");
  const entries = await fetchDubSchedule(true);
  const out: CalendarItem[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    if (e.isAdult || e.format === "MOVIE") continue;
    const title = e.title?.english?.trim() || e.title?.romaji?.trim() || "Untitled";
    const baseId = e.idMal != null ? `mal:${e.idMal}` : e.id != null ? `anilist:${e.id}` : null;
    if (!baseId) continue;

    for (const node of e.airingSchedule?.nodes ?? []) {
      if (node.episode == null || node.airingAt == null) continue;
      const timestamp = typeof node.airingAt === "number" ? node.airingAt : Number(node.airingAt);
      if (!Number.isFinite(timestamp)) continue;
      const atMs = timestamp * 1000;
      const date = new Date(atMs);
      const releaseDate = toLocalDateISO(date);
      if (!inMonth(releaseDate, year, month)) continue;
      const id = `${baseId}:1:${node.episode}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        imdbId: null,
        type: "tv",
        name: `${title.replace(/\bSeason\s+(\d+)/i, "S$1")} E${pad(node.episode)}`,
        poster: e.coverImage?.extraLarge ?? e.coverImage?.medium ?? null,
        background: e.bannerImage ?? null,
        releaseDate,
        releaseTime: toLocalTimeLabel(date) || undefined,
        releaseAtMs: atMs,
        isAnime: true,
        overview: "",
        voteAverage: 0,
      });
    }
  }
  out.sort((a, b) => a.releaseDate.localeCompare(b.releaseDate));
  return out;
}

export async function fetchSimklCalendar(
  year: number,
  month: number,
  opts: CalendarResolveOptions,
): Promise<CalendarItem[]> {
  const [{ isAuthenticated }, { fetchWatchlist, fetchWatchingItems, invalidateWatchlistCache }] =
    await Promise.all([import("./simkl/session"), import("./simkl/watchlist")]);
  if (!isAuthenticated()) return [];
  invalidateSimklWatchlist = invalidateWatchlistCache;
  const cacheKey = JSON.stringify([
    calendarScopeKey(),
    "simkl-calendar",
    year,
    month,
    opts.tmdbKey,
    effectiveTmdbLanguage(),
  ]);
  const fetchRows = async () => {
    const prepared = await prepareCalendarCandidates(opts, async () => {
      const [watchlist, watching] = await Promise.all([
        fetchWatchlist(true),
        fetchWatchingItems(true),
      ]);
      const items = [...watchlist, ...watching];
      const candidates: SavedCandidate[] = [];
      const seenIds = new Set<string>();
      for (const it of items) {
        const id =
          it.ids.imdb ??
          (it.ids.tmdb
            ? it.type === "movie"
              ? `tmdb:movie:${it.ids.tmdb}`
              : `tmdb:tv:${it.ids.tmdb}`
            : it.ids.mal
              ? `mal:${it.ids.mal}`
              : null);
        if (!id) continue;
        if (seenIds.has(id)) continue;
        seenIds.add(id);
        candidates.push({
          id,
          type: it.type === "show" ? "series" : "movie",
          name: it.title,
          mtime: 0,
          temp: false,
        });
      }
      return candidates;
    });
    if (prepared.candidates.length === 0) return [];
    return resolveSavedCalendar(prepared.candidates, year, month, prepared.options);
  };
  return opts.onSnapshot || opts.signal
    ? fetchRows()
    : personalSourceCache.fetch(cacheKey, fetchRows);
}

const TRAKT_MAX_FORWARD_MONTHS = 6;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function inMonth(iso: string, year: number, month: number): boolean {
  if (!iso) return false;
  const [y, m] = iso.split("-").map(Number);
  return y === year && (m ?? 0) - 1 === month;
}

function isAnimationGenre(genres: string[] | undefined): boolean {
  if (!genres) return false;
  const wanted = ["animation", "anime"];
  return genres.some((g) => wanted.includes(g.toLowerCase()));
}

export async function fetchTraktCalendar(
  year: number,
  month: number,
  strict = false,
): Promise<CalendarItem[]> {
  const [{ fetchUpcomingEpisodes, fetchUpcomingMovies }, { meta: cinemetaMeta }] =
    await Promise.all([import("./trakt/calendar"), import("./cinemeta")]);
  const today = new Date();
  const cur = new Date(year, month, 1);
  const fwdMonths =
    (cur.getFullYear() - today.getFullYear()) * 12 + (cur.getMonth() - today.getMonth());
  if (fwdMonths < 0 || fwdMonths > TRAKT_MAX_FORWARD_MONTHS) return [];
  const days = Math.max(31, (fwdMonths + 1) * 31);
  const [eps, mvs] = await Promise.all([
    fetchUpcomingEpisodes(days, strict),
    fetchUpcomingMovies(days, strict),
  ]);

  const epsInMonth = eps
    .map((ep) => ({ ep, ...localDateTimeFromIso(ep.airDate) }))
    .filter((x) => inMonth(x.date, year, month));
  const mvsInMonth = mvs
    .map((m) => ({ m, ...localDateTimeFromIso(m.contextDate) }))
    .filter((x) => inMonth(x.date, year, month));

  const showIds = [
    ...new Set(epsInMonth.map((x) => x.ep.ids.imdb).filter((x): x is string => !!x)),
  ];
  const movieIds = [
    ...new Set(mvsInMonth.map((x) => x.m.ids.imdb).filter((x): x is string => !!x)),
  ];
  const [showMetas, movieMetas] = await Promise.all([
    mapCalendarLimit(showIds, 6, (id) => cinemetaMeta("series", id).catch(() => null)),
    mapCalendarLimit(movieIds, 6, (id) => cinemetaMeta("movie", id).catch(() => null)),
  ]);
  const showMeta = new Map(showIds.map((id, i) => [id, showMetas[i]] as const));
  const movieMeta = new Map(movieIds.map((id, i) => [id, movieMetas[i]] as const));

  const out: CalendarItem[] = [];
  for (const { ep, date, time, atMs } of epsInMonth) {
    const imdb = ep.ids.imdb ?? null;
    const meta = imdb ? (showMeta.get(imdb) ?? null) : null;
    const baseId = imdb ?? `trakt:${ep.ids.tmdb ?? ep.ids.tvdb ?? ep.title}`;
    const epLabel = `S${pad(ep.season)}E${pad(ep.number)}`;
    const vid = meta?.videos?.find(
      (v) => (v.season ?? 0) === ep.season && (v.episode ?? v.number ?? 0) === ep.number,
    );
    out.push({
      id: `${baseId}:${ep.season}:${ep.number}`,
      imdbId: imdb,
      type: "tv",
      name: ep.episodeTitle
        ? `${ep.title} ${epLabel}: ${ep.episodeTitle}`
        : `${ep.title} ${epLabel}`,
      poster: meta?.poster ?? vid?.thumbnail ?? null,
      background: meta?.background ?? null,
      releaseDate: date,
      releaseTime: time,
      releaseAtMs: atMs,
      isAnime: isAnimationGenre(meta?.genres),
      overview: meta?.description ?? "",
      voteAverage: parseFloat(meta?.imdbRating ?? "0") || 0,
    });
  }
  for (const { m, date, time, atMs } of mvsInMonth) {
    const imdb = m.ids.imdb ?? null;
    const meta = imdb ? (movieMeta.get(imdb) ?? null) : null;
    const id = imdb ?? `trakt:${m.ids.tmdb ?? m.title}`;
    out.push({
      id,
      imdbId: imdb,
      type: "movie",
      name: m.title,
      poster: meta?.poster ?? null,
      background: meta?.background ?? null,
      releaseDate: date,
      releaseTime: time,
      releaseAtMs: atMs,
      isAnime: isAnimationGenre(meta?.genres),
      overview: meta?.description ?? "",
      voteAverage: parseFloat(meta?.imdbRating ?? "0") || 0,
    });
  }
  out.sort((a, b) => a.releaseDate.localeCompare(b.releaseDate));
  return out;
}

export async function fetchAnticipatedCalendar(
  year: number,
  month: number,
  strict = false,
): Promise<CalendarItem[]> {
  const [{ fetchAnticipatedMovies, fetchAnticipatedShows }, { meta: cinemetaMeta }] =
    await Promise.all([import("./trakt/calendar"), import("./cinemeta")]);
  const [shows, mvs] = await Promise.all([
    fetchAnticipatedShows(strict),
    fetchAnticipatedMovies(strict),
  ]);
  const inMonthShows = shows.filter((s) => inMonth(s.firstAired, year, month));
  const inMonthMovies = mvs.filter((m) => inMonth(m.released, year, month));
  const [showMetas, movieMetas] = await Promise.all([
    mapCalendarLimit(inMonthShows, 6, (s) =>
      s.ids.imdb ? cinemetaMeta("series", s.ids.imdb).catch(() => null) : Promise.resolve(null),
    ),
    mapCalendarLimit(inMonthMovies, 6, (m) =>
      m.ids.imdb ? cinemetaMeta("movie", m.ids.imdb).catch(() => null) : Promise.resolve(null),
    ),
  ]);
  const out: CalendarItem[] = [];
  for (let i = 0; i < inMonthShows.length; i++) {
    const s = inMonthShows[i];
    const meta = showMetas[i];
    const id = s.ids.imdb ?? `trakt:${s.ids.tmdb ?? s.ids.tvdb ?? s.title}`;
    out.push({
      id: `${id}:premiere`,
      imdbId: s.ids.imdb ?? null,
      type: "tv",
      name: `${s.title} (premiere)`,
      poster: meta?.poster ?? s.poster,
      background: meta?.background ?? null,
      releaseDate: s.firstAired,
      isAnime: false,
      overview: meta?.description ?? s.overview,
      voteAverage: parseFloat(meta?.imdbRating ?? "0") || 0,
    });
  }
  for (let i = 0; i < inMonthMovies.length; i++) {
    const m = inMonthMovies[i];
    const meta = movieMetas[i];
    const id = m.ids.imdb ?? `trakt:${m.ids.tmdb ?? m.title}`;
    out.push({
      id,
      imdbId: m.ids.imdb ?? null,
      type: "movie",
      name: m.title,
      poster: meta?.poster ?? m.poster,
      background: meta?.background ?? null,
      releaseDate: m.released,
      isAnime: false,
      overview: meta?.description ?? m.overview,
      voteAverage: parseFloat(meta?.imdbRating ?? "0") || 0,
    });
  }
  out.sort((a, b) => a.releaseDate.localeCompare(b.releaseDate));
  return out;
}
