import { loadPageRows } from "../page-rows";
import { movieSpecs } from "@/views/movies/movie-specs";
import { showSpecs } from "@/views/shows/show-specs";
import { calendarWarmJobs } from "../calendar";
import { fetchHeroFeed } from "../feed/hero-pool";
import type { WarmJob } from "./coordinator";

export function browseWarmJobs(key: string, region: string): WarmJob[] {
  if (!key) return [];
  const movieHidden = new Set(loadPageRows("movies").hidden);
  const showHidden = new Set(loadPageRows("shows").hidden);
  const specs = [
    ...movieSpecs(key, region).filter(
      (spec) =>
        !movieHidden.has(spec.key) && spec.key !== "under-90" && spec.key !== "black-and-white",
    ),
    ...showSpecs(key).filter((spec) => !showHidden.has(spec.key)),
  ];
  const jobs: WarmJob[] = [
    async (signal) => {
      if (signal?.aborted) return;
      await fetchHeroFeed("trending", signal);
    },
    ...calendarWarmJobs(key, region).map((job) => async (signal?: AbortSignal) => {
      if (signal?.aborted) return;
      await job();
    }),
  ];
  return [
    ...jobs,
    ...specs.map((spec) => async (signal?: AbortSignal) => {
      if (signal?.aborted) return;
      await spec.fetcher(1);
    }),
  ];
}
