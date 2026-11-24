import { invoke } from "@tauri-apps/api/core";
import { useSyncExternalStore } from "react";

export type TrickplayState = { active: boolean; bufferedOnly: boolean };
const IDLE: TrickplayState = { active: false, bufferedOnly: false };
let state: TrickplayState = IDLE;
const listeners = new Set<() => void>();

export function setTrickplayState(next: TrickplayState): void {
  if (state.active === next.active && state.bufferedOnly === next.bufferedOnly) return;
  state = next;
  for (const l of listeners) l();
}

export function useTrickplayState(): TrickplayState {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state,
    () => IDLE,
  );
}

const thumbCache = new Map<number, string>();
let thumbBytes = 0;
function clearThumbMemory() {
  thumbCache.clear();
  thumbBytes = 0;
}

export function thumbCacheGet(bucket: number): string | undefined {
  const value = thumbCache.get(bucket);
  if (value !== undefined) {
    thumbCache.delete(bucket);
    thumbCache.set(bucket, value);
  }
  return value;
}

export function thumbCacheSet(bucket: number, dataUri: string): void {
  thumbBytes -= (thumbCache.get(bucket)?.length ?? 0) * 2;
  thumbCache.delete(bucket);
  if (dataUri.length * 2 > 48 * 1024 * 1024) return;
  thumbCache.set(bucket, dataUri);
  thumbBytes += dataUri.length * 2;
  while (thumbCache.size > 160 || thumbBytes > 48 * 1024 * 1024) {
    const first = thumbCache.entries().next().value;
    if (!first) break;
    thumbBytes -= first[1].length * 2;
    thumbCache.delete(first[0]);
  }
}

export function thumbCacheNearest(bucket: number, maxDistance: number): string | undefined {
  const exact = thumbCache.get(bucket);
  if (exact) return exact;
  let best: string | undefined;
  let bestDist = Infinity;
  for (const [b, uri] of thumbCache) {
    const d = Math.abs(b - bucket);
    if (d < bestDist) {
      best = uri;
      bestDist = d;
    }
  }
  return bestDist <= maxDistance ? best : undefined;
}

export async function trickplaySetUrl(url: string): Promise<void> {
  clearThumbMemory();
  try {
    await invoke("thumbs_set_url", { url });
  } catch {}
}

export async function trickplaySpawnEager(): Promise<void> {
  try {
    await invoke("thumbs_spawn_eager");
  } catch {}
}

export async function trickplayGet(timeSec: number): Promise<string | null> {
  try {
    return await invoke<string | null>("thumbs_get", { timeSec });
  } catch {
    return null;
  }
}

export async function trickplayStop(): Promise<void> {
  clearThumbMemory();
  try {
    await invoke("thumbs_stop");
  } catch {}
}
