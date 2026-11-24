import type { SetStateAction } from "react";
import type { Meta } from "@/lib/cinemeta";
import type { FeedItem } from "@/lib/feed";
import type { FeaturedResult } from "@/lib/feed/featured";
import { registerEvictable } from "@/lib/maintenance";

// Discover's loaded data, kept outside the view so that a rebuild renders real rows on its first
// frame. One slot: only the most recent feed key can be reused. The view writes every update here
// before it sets state, so a fetch that resolves after unmount still lands in the cache.
// Six hours, because a rebuild after a long video must still have its rows ready.
const SESSION_TTL_MS = 6 * 60 * 60 * 1000;

export type DiscoverSession = {
  key: string;
  createdAt: number;
  rails: Record<string, Meta[]>;
  pages: Record<string, number>;
  exhausted: Record<string, boolean>;
  feat: FeaturedResult;
  featReady: boolean;
  queue: FeedItem[];
  criticsPickList: Meta[];
};

export type SessionField = "rails" | "feat" | "featReady" | "queue" | "criticsPickList";

type Listener = () => void;

let current: DiscoverSession | null = null;
const listeners = new Set<Listener>();

function isExpired(session: DiscoverSession): boolean {
  return Date.now() - session.createdAt >= SESSION_TTL_MS;
}

export function startDiscoverSession(key: string): DiscoverSession {
  current = {
    key,
    createdAt: Date.now(),
    rails: {},
    pages: {},
    exhausted: {},
    feat: { featured: [], reserve: [], pool: [] },
    featReady: false,
    queue: [],
    criticsPickList: [],
  };
  return current;
}

export function acquireDiscoverSession(key: string): DiscoverSession {
  if (current && current.key === key && !isExpired(current)) return current;
  return startDiscoverSession(key);
}

export function releaseDiscoverSession(): void {
  current = null;
}

/** Writes one field of the session a view holds, then tells the mounted views to re-read it. */
export function commitSessionUpdate<K extends SessionField>(
  session: DiscoverSession,
  field: K,
  update: SetStateAction<DiscoverSession[K]>,
): void {
  const prev = session[field];
  session[field] =
    typeof update === "function"
      ? (update as (p: DiscoverSession[K]) => DiscoverSession[K])(prev)
      : (update as DiscoverSession[K]);
  notifyDiscoverSession();
}

/** Mounted Discover views subscribe so one that is still alive picks up writes from a dead one. */
export function subscribeDiscoverSession(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function notifyDiscoverSession(): void {
  for (const listener of listeners) listener();
}

registerEvictable("discover-session", (aggressive) => {
  if (aggressive || (current && isExpired(current))) releaseDiscoverSession();
});
