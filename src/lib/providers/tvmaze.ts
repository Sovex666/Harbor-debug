import { safeFetch as fetch } from "@/lib/safe-fetch";

const TVMAZE = "https://api.tvmaze.com";
const ID_KEY = "harbor.tvmaze.ids.v1";
const EP_TTL_MS = 6 * 60 * 60 * 1000;
const SHOW_TTL_MS = 6 * 60 * 60 * 1000;
// Network errors, 429 and 5xx say nothing about the show, so they are retried sooner.
const TRANSIENT_SHOW_TTL_MS = 30 * 60 * 1000;

export type TvmazeShow = {
  id: number;
  name: string;
  image: string | null;
  isAnime: boolean;
};

export type TvmazeEpisode = {
  season: number;
  number: number;
  name: string;
  airdate: string;
  image: string | null;
  summary: string;
};

type IdMap = Record<string, number | null>;
let idMap: IdMap | null = null;

function loadIds(): IdMap {
  if (idMap) return idMap;
  try {
    idMap = JSON.parse(localStorage.getItem(ID_KEY) ?? "{}") as IdMap;
  } catch {
    idMap = {};
  }
  return idMap;
}

function persistIds(): void {
  try {
    localStorage.setItem(ID_KEY, JSON.stringify(idMap ?? {}));
  } catch {
    /* ignore */
  }
}

// TVMaze throttles aggressively, so its cap is global across every caller, not per queue.
const TVMAZE_MAX_CONCURRENT = 3;
let tvmazeActive = 0;
const tvmazeWaiting: Array<() => void> = [];

async function withTvmazeSlot<T>(run: () => Promise<T>): Promise<T> {
  if (tvmazeActive < TVMAZE_MAX_CONCURRENT) tvmazeActive++;
  // A released slot is handed straight to the next waiter, so the count never exceeds the cap.
  else await new Promise<void>((resolve) => tvmazeWaiting.push(resolve));
  try {
    return await run();
  } finally {
    const next = tvmazeWaiting.shift();
    if (next) next();
    else tvmazeActive--;
  }
}

const showCache = new Map<string, { show: TvmazeShow | null; expiresAt: number }>();
const showInflight = new Map<string, Promise<{ show: TvmazeShow | null; ttl: number }>>();
const epCache = new Map<number, { at: number; eps: TvmazeEpisode[] }>();
const epInflight = new Map<number, Promise<TvmazeEpisode[]>>();

function stripHtml(s: string | null | undefined): string {
  return (s ?? "").replace(/<[^>]*>/g, "").trim();
}

export async function tvmazeShow(imdb: string): Promise<TvmazeShow | null> {
  const cached = showCache.get(imdb);
  if (cached && cached.expiresAt > Date.now()) return cached.show;
  const existing = showInflight.get(imdb);
  if (existing) return (await existing).show;
  const p = (async (): Promise<{ show: TvmazeShow | null; ttl: number }> => {
    try {
      const res = await withTvmazeSlot(() =>
        fetch(`${TVMAZE}/lookup/shows?imdb=${encodeURIComponent(imdb)}`),
      );
      if (res.status === 404) return { show: null, ttl: SHOW_TTL_MS };
      if (!res.ok) return { show: null, ttl: TRANSIENT_SHOW_TTL_MS };
      const raw = (await res.json()) as {
        id?: number;
        name?: string;
        genres?: string[];
        image?: { medium?: string; original?: string } | null;
      };
      if (typeof raw?.id !== "number") return { show: null, ttl: SHOW_TTL_MS };
      const show: TvmazeShow = {
        id: raw.id,
        name: raw.name ?? "",
        image: raw.image?.original ?? raw.image?.medium ?? null,
        isAnime: (raw.genres ?? []).some((g) => g.toLowerCase() === "anime"),
      };
      const ids = loadIds();
      ids[imdb] = raw.id;
      persistIds();
      return { show, ttl: SHOW_TTL_MS };
    } catch {
      return { show: null, ttl: TRANSIENT_SHOW_TTL_MS };
    }
  })().finally(() => showInflight.delete(imdb));
  showInflight.set(imdb, p);
  const { show, ttl } = await p;
  showCache.set(imdb, { show, expiresAt: Date.now() + ttl });
  return show;
}

export async function tvmazeEpisodes(showId: number): Promise<TvmazeEpisode[]> {
  const cached = epCache.get(showId);
  if (cached && Date.now() - cached.at < EP_TTL_MS) return cached.eps;
  const existing = epInflight.get(showId);
  if (existing) return existing;
  const p = (async (): Promise<TvmazeEpisode[]> => {
    try {
      const res = await withTvmazeSlot(() => fetch(`${TVMAZE}/shows/${showId}/episodes`));
      if (!res.ok) return cached?.eps ?? [];
      const raw = (await res.json()) as Array<{
        season?: number;
        number?: number;
        name?: string;
        airdate?: string;
        summary?: string;
        image?: { medium?: string; original?: string } | null;
      }>;
      const eps: TvmazeEpisode[] = (Array.isArray(raw) ? raw : [])
        .filter((e) => !!e?.airdate)
        .map((e) => ({
          season: e.season ?? 0,
          number: e.number ?? 0,
          name: e.name ?? "",
          airdate: String(e.airdate).slice(0, 10),
          image: e.image?.original ?? e.image?.medium ?? null,
          summary: stripHtml(e.summary),
        }));
      epCache.set(showId, { at: Date.now(), eps });
      return eps;
    } catch {
      return cached?.eps ?? [];
    }
  })().finally(() => epInflight.delete(showId));
  epInflight.set(showId, p);
  return p;
}

export async function tvmazeUpcoming(
  imdb: string,
  inWindow: (airdate: string) => boolean,
): Promise<{ show: TvmazeShow; episodes: TvmazeEpisode[] } | null> {
  const show = await tvmazeShow(imdb);
  if (!show) return null;
  const eps = await tvmazeEpisodes(show.id);
  return { show, episodes: eps.filter((e) => inWindow(e.airdate)) };
}
