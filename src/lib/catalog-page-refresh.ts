/**
 * Replace a catalog row's public first page without resetting pagination.
 * Rows keep the already loaded tail pages so a background cache refresh does
 * not jump the user's scroll position or discard cards they have reached.
 */
export type CatalogPageRow<T extends { id: string | number }> = {
  metas: readonly T[];
  page: number;
  hasMore: boolean;
  firstPageLength?: number;
};

function unique<T extends { id: string | number }>(metas: readonly T[]): T[] {
  const seen = new Set<string | number>();
  const result: T[] = [];
  for (const meta of metas) {
    if (seen.has(meta.id)) continue;
    seen.add(meta.id);
    result.push(meta);
  }
  return result;
}

export function replaceCatalogFirstPage<
  T extends { id: string | number },
  R extends CatalogPageRow<T>,
>(row: R, nextFirstPage: readonly T[], maxPerRow = 30): R {
  const first = unique(nextFirstPage).slice(0, maxPerRow);
  // An empty/error response must not erase a working row. Callers can use the
  // same rule for rejected requests by simply leaving the row unchanged.
  if (first.length === 0) return row;

  const firstLength = Math.max(
    0,
    Math.min(row.firstPageLength ?? row.metas.length, row.metas.length),
  );
  const tail = row.metas.slice(firstLength);
  const metas = unique([...first, ...tail]).slice(0, maxPerRow);
  return {
    ...row,
    metas,
    firstPageLength: first.length,
  };
}
