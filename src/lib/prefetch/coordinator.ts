export type WarmJob = (signal?: AbortSignal) => Promise<unknown>;

const JOB_DEADLINE_MS = 15_000;

/** Normally one speculative job runs; at most one timed-out job may remain detached. */
export function createPrefetchCoordinator(
  schedule: (run: () => void) => () => void,
  scheduleDeadline: (run: () => void, delay: number) => () => void = (run, delay) => {
    const timer = setTimeout(run, delay);
    return () => clearTimeout(timer);
  },
) {
  let generation = 0;
  let cancelIdle: (() => void) | undefined;
  let running: AbortController | undefined;
  let queue: WarmJob[] = [];
  const active = new Set<AbortController>();
  function pump() {
    if (running || cancelIdle || queue.length === 0) return;
    // shortcut: two uncooperative jobs exhaust speculative admission; retry on
    // a later start after one settles, or add provider-owned cancellation.
    if (active.size >= 2) {
      queue = [];
      return;
    }
    const token = generation;
    cancelIdle = schedule(() => {
      if (token !== generation) return;
      cancelIdle = undefined;
      const job = queue.shift();
      if (!job) return;
      const controller = new AbortController();
      running = controller;
      active.add(controller);
      const cancelDeadline = scheduleDeadline(() => {
        controller.abort();
        if (running !== controller) return;
        running = undefined;
        pump();
      }, JOB_DEADLINE_MS);
      void Promise.resolve()
        .then(() => {
          if (!controller.signal.aborted) return job(controller.signal);
        })
        .catch(() => {})
        .finally(() => {
          cancelDeadline();
          active.delete(controller);
          if (running !== controller) return;
          running = undefined;
          pump();
        });
    });
  }
  return {
    start(jobs: WarmJob[]) {
      generation++;
      cancelIdle?.();
      cancelIdle = undefined;
      queue = jobs.slice(0, 64);
      running?.abort();
      pump();
    },
    pause() {
      generation++;
      cancelIdle?.();
      cancelIdle = undefined;
      queue = [];
      for (const controller of active) controller.abort();
    },
  };
}

export function scheduleBrowserIdle(run: () => void): () => void {
  const timer = window.setTimeout(() => {
    if (typeof window.requestIdleCallback === "function") idle = window.requestIdleCallback(run);
    else run();
  }, 1000);
  let idle: number | undefined;
  return () => {
    window.clearTimeout(timer);
    if (idle !== undefined) window.cancelIdleCallback(idle);
  };
}
