import type { Meta } from "@/lib/cinemeta";
import { safeFetch } from "@/lib/safe-fetch";
import { HARBOR_API_BASE } from "@/lib/config/endpoints";

export type HeroFeed = "trending" | "trakt" | "simkl" | "classic";

const HOSTED_URL = `${HARBOR_API_BASE}/feed/hero-pool.json`;
const CACHE_KEY = "harbor.heroPool.v1";
const TTL = 3 * 60 * 60 * 1000;

const SRC: Record<Exclude<HeroFeed, "classic">, string> = {
  trending: "now",
  trakt: "trakt",
  simkl: "simkl",
};

type Pool = { at: number; sources: Record<string, Meta[]> };

let mem: Pool | null = null;
let inflight: Promise<Pool | null> | null = null;
const listeners = new Set<() => void>();
export function subscribeHeroFeed(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function fromStore(): Pool | null {
  if (mem) return mem;
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Pool;
      if (p && p.sources && Array.isArray(p.sources.now)) {
        mem = p;
        return p;
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

async function refresh(cached: Pool | null): Promise<Pool | null> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      // Demand and prefetch share this request. A departing speculative owner
      // must not abort a Home consumer that joined it.
      const res = await safeFetch(HOSTED_URL, { cache: "no-cache" });
      if (!res.ok) return cached;
      const j = (await res.json()) as { sources?: Record<string, Meta[]> };
      if (!j || !j.sources || !Array.isArray(j.sources.now)) return cached;
      mem = { at: Date.now(), sources: j.sources };
      const changed = JSON.stringify(cached?.sources) !== JSON.stringify(j.sources);
      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify(mem));
      } catch {
        /* ignore */
      }
      if (changed) for (const listener of listeners) listener();
      return mem;
    } catch {
      return cached;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

async function load(signal?: AbortSignal): Promise<Pool | null> {
  const cached = fromStore();
  if (cached && Date.now() - cached.at < TTL) return cached;
  // Stale hero art is still usable. Start revalidation without holding the
  // Home route on the network after a restart.
  if (cached) {
    void refresh(cached).catch(() => {});
    return cached;
  }
  if (signal?.aborted) return cached;
  return refresh(null);
}

export async function fetchHeroFeed(source: HeroFeed, signal?: AbortSignal): Promise<Meta[]> {
  if (source === "classic") return [];
  const p = await load(signal);
  if (!p) return [];
  const key = SRC[source] ?? "now";
  const arr = p.sources[key] ?? p.sources.now ?? [];
  return Array.isArray(arr) ? arr.filter((m) => m && typeof m.id === "string" && m.background) : [];
}
