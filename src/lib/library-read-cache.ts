import { cacheInstallationSalt } from "./cache-scope";
import {
  loadMedia,
  mediaCacheKey,
  readMediaValue,
  removeMediaNamespaces,
  releasePersonalCacheMemory,
} from "./media-cache";
import { libraryProjectionItems, libraryProjectionMetadata, type LibraryItem } from "./stremio";

type Snapshot = { signature: string; items: LibraryItem[] };
export type LibraryProjectionIdentity = {
  authKey: string;
  userId: string | null | undefined;
  profileId: string | null | undefined;
};
let epoch = 0;
const mutationEpochs = new Map<string, number>();
const mutations = new Map<string, number>();
const removals = new Map<string, Promise<void>>();
let removal: Promise<void> = Promise.resolve();

async function accountNamespace(authKey: string, salt: string): Promise<string | null> {
  const hash = await mediaCacheKey("library-account", [salt, authKey]);
  return hash ? `library-read-${hash.split(":").pop()}-` : null;
}

/** Fence loaders immediately; queued removals follow any write already in progress. */
export function invalidateLibraryProjections(authKey?: string): Promise<void> {
  if (authKey) {
    mutationEpochs.set(authKey, (mutationEpochs.get(authKey) ?? 0) + 1);
    const salt = cacheInstallationSalt();
    const previous = removals.get(authKey) ?? Promise.resolve();
    const next = previous
      .then(async () => {
        const prefix = salt && (await accountNamespace(authKey, salt));
        if (prefix) await removeMediaNamespaces(prefix);
      })
      .catch(() => {});
    removals.set(authKey, next);
    void next.then(() => {
      if (removals.get(authKey) === next) removals.delete(authKey);
    });
    return next;
  } else {
    epoch++;
    removal = removeMediaNamespaces("library-read-").catch(() => {});
  }
  return removal;
}

export function beginLibraryProjectionMutation(authKey: string): () => void {
  mutations.set(authKey, (mutations.get(authKey) ?? 0) + 1);
  void invalidateLibraryProjections(authKey);
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    const remaining = (mutations.get(authKey) ?? 1) - 1;
    if (remaining) mutations.set(authKey, remaining);
    else mutations.delete(authKey);
    void invalidateLibraryProjections(authKey);
  };
}

export function fenceLibraryProjections(): void {
  epoch++;
  releasePersonalCacheMemory();
}

if (typeof window !== "undefined") {
  window.addEventListener("harbor:active-profile-changed", fenceLibraryProjections);
  window.addEventListener("harbor:account-provider-changed", fenceLibraryProjections);
}

function project(item: LibraryItem): LibraryItem {
  const {
    _id,
    type,
    name,
    removed,
    temp,
    _ctime,
    _mtime,
    state,
    external,
    altIds,
    isAnime,
    upNext,
    manualWatched,
  } = item;
  return {
    _id,
    type,
    name,
    removed,
    temp,
    _ctime,
    _mtime,
    ...(external ? { external } : {}),
    ...(Array.isArray(altIds)
      ? { altIds: altIds.filter((id): id is string => typeof id === "string") }
      : {}),
    ...(typeof isAnime === "boolean" ? { isAnime } : {}),
    ...(typeof upNext === "boolean" ? { upNext } : {}),
    ...(typeof manualWatched === "boolean" ? { manualWatched } : {}),
    ...(state
      ? {
          state: {
            timeOffset: state.timeOffset,
            duration: state.duration,
            season: state.season,
            episode: state.episode,
            timeWatched: state.timeWatched,
            flaggedWatched: state.flaggedWatched,
            timesWatched: state.timesWatched,
            watched: state.watched,
            video_id: state.video_id,
            lastWatched: state.lastWatched,
          },
        }
      : {}),
  };
}

/** Resolved identity is mandatory. The result may include a coalesced background refresh. */
export async function readLibraryProjection(identity: LibraryProjectionIdentity, force = false) {
  const generation = epoch;
  const mutationGeneration = mutationEpochs.get(identity.authKey) ?? 0;
  const current = () =>
    generation === epoch &&
    mutationGeneration === (mutationEpochs.get(identity.authKey) ?? 0) &&
    !mutations.has(identity.authKey);
  const { authKey, userId, profileId } = identity;
  const salt = cacheInstallationSalt();
  const resolved = !!salt && !!authKey && !!profileId && !!userId && !userId.startsWith("stremio:");
  const network = async (prior: Snapshot | null): Promise<Snapshot> => {
    const metadata = await libraryProjectionMetadata(authKey);
    const signature = await mediaCacheKey("library-signature", [
      salt,
      metadata.slice().sort(([a], [b]) => a.localeCompare(b)),
    ]);
    if (!signature) throw new Error("Signature unavailable");
    if (prior?.signature === signature) return prior;
    const items = await libraryProjectionItems(authKey, metadata);
    if (
      items.some((item) => !item || typeof item._id !== "string" || typeof item.name !== "string")
    )
      throw new Error("Invalid library item");
    return { signature, items: items.map(project) };
  };
  if (!resolved) {
    // Do not reuse or persist an unidentified account's data.
    const ids = await libraryProjectionMetadata(authKey);
    const items = await libraryProjectionItems(authKey, ids);
    return { value: current() ? items.map(project) : null, refresh: undefined };
  }
  await removal;
  await removals.get(authKey);
  if (!current()) return { value: null, refresh: undefined };
  const prefix = await accountNamespace(authKey, salt!);
  const accountHash = prefix?.slice("library-read-".length, -1);
  const scopeHash = await mediaCacheKey("library-scope", [
    accountHash,
    "stremio",
    userId,
    profileId,
    authKey,
  ]);
  if (!prefix || !scopeHash || !current()) return { value: null, refresh: undefined };
  const namespace = `${prefix}${scopeHash.split(":").pop()}`;
  const scope = ["projection-v1"];
  const previous = await readMediaValue<Snapshot>(namespace, scope);
  const prior =
    previous && typeof previous.signature === "string" && Array.isArray(previous.items)
      ? previous
      : null;
  if (!current()) return { value: null, refresh: undefined };
  const result = await loadMedia(namespace, scope, () => network(prior), {
    ttl: 60_000,
    stale: 15 * 60_000,
    staleWhileRevalidate: !force,
    maxAge: force ? 0 : undefined,
    maxBytes: 512 * 1024,
    current,
    valid: (value) => !!value && typeof value.signature === "string" && Array.isArray(value.items),
  });
  if (!current()) return { value: null, refresh: undefined };
  return {
    value: result.value?.items ?? null,
    refresh: result.refresh?.then((value) => (current() ? (value?.items ?? null) : null)),
  };
}
