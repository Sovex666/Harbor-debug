import { lruGet, lruSet } from "./cache";

/** Memory-only, bounded results and coalescing. Clearing also fences pending writes. */
export class CalendarCache<T> {
  private values = new Map<string, { at: number; value: T; revision: number }>();
  private pending = new Map<string, Promise<T>>();
  private generation = 0;

  private max: number;
  private ttl: number;
  private staleWhileRevalidate: boolean;
  private revision = 0;
  private listeners = new Set<() => void>();

  constructor(max: number, ttl: number, staleWhileRevalidate = false) {
    this.max = max;
    this.ttl = ttl;
    this.staleWhileRevalidate = staleWhileRevalidate;
  }

  peek(key: string): T | undefined {
    const hit = lruGet(this.values, key);
    if (hit && Date.now() - hit.at < this.ttl) return hit.value;
    return undefined;
  }

  fetch(
    key: string,
    fetcher: () => Promise<T>,
    cacheable: (value: T) => boolean = () => true,
  ): Promise<T> {
    const hit = this.peek(key);
    if (hit !== undefined) return Promise.resolve(hit);
    const stale = this.staleWhileRevalidate ? this.values.get(key) : undefined;
    const pending = this.pending.get(key);
    if (pending) return stale ? Promise.resolve(stale.value) : pending;
    const generation = this.generation;
    const promise = Promise.resolve()
      .then(fetcher)
      .then((value) => {
        if (
          generation === this.generation &&
          this.pending.get(key) === promise &&
          cacheable(value)
        ) {
          const revision = stale ? ++this.revision : 0;
          lruSet(this.values, key, { at: Date.now(), value, revision }, this.max);
          if (stale) for (const listener of this.listeners) listener();
        }
        return value;
      })
      .finally(() => {
        if (this.pending.get(key) === promise) this.pending.delete(key);
      });
    lruSet(this.pending, key, promise, this.max);
    if (stale) {
      void promise.catch(() => {});
      return Promise.resolve(stale.value);
    }
    return promise;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  getRevision(key?: string): number {
    return key === undefined ? this.revision : (this.values.get(key)?.revision ?? 0);
  }

  clear(): void {
    this.generation++;
    this.values.clear();
    this.pending.clear();
  }
}
