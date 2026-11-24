/** Refill each free slot immediately, preserving input order. */
export async function mapCalendarLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
  opts?: { signal?: AbortSignal },
): Promise<R[]> {
  const out: R[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(items.length, Math.max(1, limit)) }, async () => {
      while (next < items.length) {
        if (opts?.signal?.aborted) return;
        const index = next++;
        out[index] = await fn(items[index]);
      }
    }),
  );
  return out;
}
