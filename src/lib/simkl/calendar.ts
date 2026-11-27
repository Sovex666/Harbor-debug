import { safeFetch as fetch } from "@/lib/safe-fetch";
import type { CalendarItem } from "@/lib/calendar";
import { SIMKL_APP_NAME, SIMKL_APP_VERSION, SIMKL_CLIENT_ID } from "./config";
import { parseSimklCalendar, type SimklCdnItem } from "./calendar-data";
export type { SimklCdnItem } from "./calendar-data";

const UA = `${SIMKL_APP_NAME}/${SIMKL_APP_VERSION}`;

function cdnUrl(path: string): string {
  return `https://data.simkl.in/calendar/v2/${path}?client_id=${SIMKL_CLIENT_ID}&app-name=${SIMKL_APP_NAME}&app-version=${SIMKL_APP_VERSION}`;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function mapCdnItem(item: SimklCdnItem, type: "tv" | "movie", isAnime: boolean): CalendarItem {
  const tmdbId = item.ids?.tmdb ? String(item.ids.tmdb) : null;
  const id =
    item.ids?.imdb ??
    (tmdbId
      ? type === "movie"
        ? `tmdb:movie:${tmdbId}`
        : `tmdb:tv:${tmdbId}`
      : `simkl:${item.ids?.simkl_id}`);

  let name = item.title;
  if (type === "tv" && item.episode?.season !== undefined && item.episode?.episode !== undefined) {
    name = `${item.title} S${pad(item.episode.season)}E${pad(item.episode.episode)}`;
  }

  const poster = item.poster
    ? `https://wsrv.nl/?url=https://simkl.in/posters/${item.poster}_m.webp&q=90`
    : null;

  return {
    id,
    imdbId: item.ids?.imdb ?? null,
    type,
    name,
    poster,
    background: null,
    releaseDate: (item.date ?? "").slice(0, 10),
    isAnime,
    overview: "",
    voteAverage: item.ratings?.simkl?.rating ?? 0,
  };
}

export async function fetchSimklCdnRolling(
  catalog: "tv" | "anime" | "movie",
): Promise<CalendarItem[]> {
  const filename = catalog === "movie" ? "movie_release.json" : `${catalog}.json`;
  try {
    const res = await fetch(cdnUrl(filename), { headers: { "User-Agent": UA } });
    if (!res.ok) return [];
    const data = parseSimklCalendar(await res.json());
    const type = catalog === "movie" ? "movie" : "tv";
    return data.map((item) => mapCdnItem(item, type, catalog === "anime"));
  } catch {
    return [];
  }
}

export async function fetchSimklCdnArchive(
  year: number,
  month: number,
  catalog: "tv" | "anime" | "movie",
  strict = false,
): Promise<CalendarItem[]> {
  const filename = catalog === "movie" ? "movie_release.json" : `${catalog}.json`;
  const simklMonth = month + 1;
  try {
    const res = await fetch(cdnUrl(`${year}/${simklMonth}/${filename}`), {
      headers: { "User-Agent": UA },
    });
    if (!res.ok) throw new Error("SIMKL calendar request failed");
    const payload = await res.json();
    if (
      strict &&
      (!payload ||
        !Array.isArray(payload.calendar) ||
        !payload.metadata ||
        typeof payload.metadata !== "object" ||
        Array.isArray(payload.metadata))
    ) {
      throw new Error("Invalid SIMKL calendar response");
    }
    const data = parseSimklCalendar(payload);
    const type = catalog === "movie" ? "movie" : "tv";
    return data.map((item) => mapCdnItem(item, type, catalog === "anime"));
  } catch (error) {
    if (strict) throw error;
    return [];
  }
}

const calendarCache = new Map<string, Promise<CalendarItem[]>>();

export function fetchSimklCdnCalendar(
  year: number,
  month: number,
  strict = false,
): Promise<CalendarItem[]> {
  const cacheKey = `${year}-${month}:${strict}`;
  let p = calendarCache.get(cacheKey);
  if (!p) {
    p = Promise.all([
      fetchSimklCdnArchive(year, month, "tv", strict),
      fetchSimklCdnArchive(year, month, "anime", strict),
      fetchSimklCdnArchive(year, month, "movie", strict),
    ]).then(([tv, anime, movies]) => {
      const combined = [...tv, ...anime, ...movies];
      combined.sort((a, b) => a.releaseDate.localeCompare(b.releaseDate));
      return combined;
    });
    calendarCache.set(cacheKey, p);
    void p.catch(() => {
      if (calendarCache.get(cacheKey) === p) calendarCache.delete(cacheKey);
    });
  }
  return p;
}

export function clearCalendarCache() {
  calendarCache.clear();
}
