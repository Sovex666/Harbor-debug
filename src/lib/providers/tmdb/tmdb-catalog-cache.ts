import { lruGet, lruSet } from "@/lib/cache";

const TTL_MS = 5 * 60_000;
const MAX_CATALOG_PAGES = 128;

// Only public catalog pages: never account, session, search, or personalized state.
export function isCatalogPath(path: string): boolean {
  return /^(discover\/(movie|tv)|trending\/(movie|tv|all)\/(day|week)|(movie|tv)\/(popular|top_rated|now_playing|upcoming|on_the_air|airing_today))$/.test(
    path,
  );
}

export function createCatalogCache(now: () => number = Date.now) {
  const pages = new Map<string, { expires: number; data: unknown }>();
  return {
    clear(): void {
      pages.clear();
    },
    get<T>(key: string): T | undefined {
      const entry = lruGet(pages, key);
      if (!entry) return undefined;
      if (entry.expires <= now()) {
        pages.delete(key);
        return undefined;
      }
      // Callers enrich metadata; never let that mutate a later caller's page.
      return structuredClone(entry.data) as T;
    },
    set(key: string, data: unknown): void {
      if (data == null) return;
      lruSet(
        pages,
        key,
        { expires: now() + TTL_MS, data: structuredClone(data) },
        MAX_CATALOG_PAGES,
      );
    },
  };
}

const fields = [
  "id",
  "title",
  "name",
  "original_title",
  "original_name",
  "original_language",
  "overview",
  "poster_path",
  "backdrop_path",
  "release_date",
  "first_air_date",
  "vote_average",
  "genre_ids",
  "adult",
  "origin_country",
  "media_type",
] as const;

export function projectCatalogPage(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  const page = value as Record<string, unknown>;
  if (!Array.isArray(page.results) || page.results.length > 100) return null;
  const results = page.results.map((item: unknown) => {
    if (!item || typeof item !== "object" || !Number.isFinite((item as { id?: number }).id))
      return null;
    const row = item as Record<string, unknown>;
    const projected: Record<string, unknown> = {};
    for (const field of fields) {
      const v = row[field];
      if (field === "poster_path" || field === "backdrop_path") {
        if (typeof v === "string" && /^\/[a-zA-Z0-9_.-]+$/.test(v)) projected[field] = v;
      } else if (
        typeof v === "string" ||
        typeof v === "number" ||
        typeof v === "boolean" ||
        (Array.isArray(v) && v.every((x) => typeof x === "number" || typeof x === "string"))
      )
        projected[field] = v;
    }
    return projected;
  });
  if (results.some((item) => item === null)) return null;
  return {
    results,
    ...(typeof page.total_results === "number" ? { total_results: page.total_results } : {}),
    ...(typeof page.total_pages === "number" ? { total_pages: page.total_pages } : {}),
  };
}
