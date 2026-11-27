import { useEffect, useState } from "react";
import { browseCacheRevision, subscribeBrowseCache } from "@/lib/scoped-data-cache";

/** Coalesced provider refreshes rebuild visible rows; hidden views stay quiet. */
export function useBrowseCacheUpdates(active = true): number {
  const [revision, setRevision] = useState(browseCacheRevision);
  useEffect(() => {
    if (!active) return;
    const update = () => setRevision(browseCacheRevision());
    update();
    return subscribeBrowseCache(update);
  }, [active]);
  return revision;
}
