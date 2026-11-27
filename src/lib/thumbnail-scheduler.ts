export type ThumbnailPriority = "visible" | "near" | "speculative" | "background";
type Job<T> = {
  key: string;
  priority: ThumbnailPriority;
  run: (signal: AbortSignal) => Promise<T>;
  controller: AbortController;
  owners: Map<symbol, ThumbnailPriority>;
  /** Per-owner hold checks; a job waits only while every owner holds it. */
  holds: Map<symbol, (() => boolean) | undefined>;
  active: boolean;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  promise: Promise<T>;
};
const rank = { visible: 0, near: 1, speculative: 2, background: 3 };

type SchedulerLimits = {
  active: number;
  speculative: number;
  background?: number;
  queued: number;
};

/** Coalesced leases; releasing one card cannot cancel another card's image. */
export function createThumbnailScheduler<T>(
  options: SchedulerLimits = { active: 8, speculative: 2, background: 2, queued: 512 },
) {
  // Callers that predate the background tier pass no cap for it.
  const limits = { ...options, background: options.background ?? 2 };
  const jobs = new Map<string, Job<T>>();
  let active = 0;
  let speculative = 0;
  let background = 0;
  let dropped = 0;
  let backgroundPausedUntil = 0;
  let backgroundPaused = false;
  let backgroundResume: ReturnType<typeof setTimeout> | undefined;
  function held(job: Job<T>): boolean {
    if (job.holds.size === 0) return false;
    for (const hold of job.holds.values()) if (!hold?.()) return false;
    return true;
  }
  function drain() {
    if (active >= limits.active) return;
    const isInteractive = (job: Job<T>) => job.priority === "visible" || job.priority === "near";
    // Held jobs (e.g. artwork in a parked page) neither start nor count as interactive work,
    // or a parked page's on-screen posters would starve the active page's background tier.
    let interactive = false;
    const waiting: Job<T>[] = [];
    for (const job of jobs.values()) {
      if (job.active) {
        if (isInteractive(job)) interactive = true;
      } else if (!held(job)) {
        if (isInteractive(job)) interactive = true;
        waiting.push(job);
      }
    }
    waiting.sort((a, b) => rank[a.priority] - rank[b.priority]);
    for (const job of waiting) {
      if (active >= limits.active) break;
      if (job.priority === "speculative" && speculative >= limits.speculative) continue;
      if (
        job.priority === "background" &&
        (interactive || backgroundPaused || background >= limits.background)
      )
        continue;
      job.active = true;
      active++;
      const wasSpeculative = job.priority === "speculative";
      if (wasSpeculative) speculative++;
      const wasBackground = job.priority === "background";
      if (wasBackground) background++;
      void Promise.resolve()
        .then(() => {
          job.controller.signal.throwIfAborted();
          return job.run(job.controller.signal);
        })
        .then(job.resolve, job.reject)
        .finally(() => {
          active--;
          if (wasSpeculative) speculative--;
          if (wasBackground) background--;
          if (jobs.get(job.key) === job) jobs.delete(job.key);
          drain();
        });
    }
  }
  function discard(job: Job<T>) {
    job.controller.abort();
    if (!job.active) {
      if (jobs.get(job.key) === job) jobs.delete(job.key);
      job.reject(new DOMException("Image request released", "AbortError"));
    }
  }
  function refreshPriority(job: Job<T>) {
    const priorities = [...job.owners.values()].sort((a, b) => rank[a] - rank[b]);
    if (priorities.length) job.priority = priorities[0];
  }
  return {
    promote(key: string, priority: ThumbnailPriority) {
      const job = jobs.get(key);
      if (job && rank[priority] < rank[job.priority]) {
        job.priority = priority;
        drain();
      }
    },
    /**
     * `hold` is checked whenever a slot could be granted: while it returns true the owner's job
     * stays queued without starting. Call `pump` when a hold may have lifted.
     */
    acquire(key: string, priority: ThumbnailPriority, run: Job<T>["run"], hold?: () => boolean) {
      let job = jobs.get(key);
      if (job?.controller.signal.aborted) job = undefined;
      if (!job) {
        // Held jobs do no work, so they neither fill the queue nor get evicted for new demand.
        const waiting = [...jobs.values()].filter((value) => !value.active && !held(value));
        if (waiting.length >= limits.queued) {
          const victim = waiting
            .reverse()
            .sort((a, b) => rank[b.priority] - rank[a.priority])
            .find((value) => rank[value.priority] > rank[priority]);
          if (victim && priority !== "speculative" && priority !== "background") discard(victim);
          else {
            dropped++;
            return {
              promise: Promise.reject<T>(new Error("Image queue full")),
              release() {},
              setPriority(_priority: ThumbnailPriority) {},
            };
          }
        }
        let resolve!: Job<T>["resolve"];
        let reject!: Job<T>["reject"];
        const promise = new Promise<T>((yes, no) => {
          resolve = yes;
          reject = no;
        });
        job = {
          key,
          priority,
          run,
          controller: new AbortController(),
          owners: new Map(),
          holds: new Map(),
          active: false,
          resolve,
          reject,
          promise,
        };
        jobs.set(key, job);
      } else if (rank[priority] < rank[job.priority]) job.priority = priority;
      const owner = Symbol();
      job.owners.set(owner, priority);
      job.holds.set(owner, hold);
      refreshPriority(job);
      const owned = job;
      let released = false;
      drain();
      return {
        promise: owned.promise,
        setPriority(next: ThumbnailPriority) {
          if (released) return;
          owned.owners.set(owner, next);
          refreshPriority(owned);
          drain();
        },
        release() {
          if (released) return;
          released = true;
          owned.owners.delete(owner);
          owned.holds.delete(owner);
          if (owned.owners.size === 0) discard(owned);
          else refreshPriority(owned);
          // Releasing visible work can leave background work eligible with nothing else to wake it.
          drain();
        },
      };
    },
    pauseBackground(ms: number) {
      const until = Date.now() + ms;
      // A short pause inside a longer one must not shorten it.
      if (until <= backgroundPausedUntil) return;
      backgroundPausedUntil = until;
      backgroundPaused = true;
      clearTimeout(backgroundResume);
      backgroundResume = setTimeout(() => {
        backgroundResume = undefined;
        backgroundPaused = false;
        drain();
      }, ms);
    },
    /** Re-check held jobs, e.g. after a parked layer becomes active again. */
    pump() {
      drain();
    },
    clearSpeculative() {
      // Held jobs cost nothing; discarding them would fail their parked cards.
      for (const job of jobs.values())
        if ((job.priority === "speculative" || job.priority === "background") && !held(job))
          discard(job);
    },
    stats: () => ({
      active,
      speculative,
      queued: [...jobs.values()].filter((job) => !job.active && !held(job)).length,
      dropped,
    }),
  };
}
