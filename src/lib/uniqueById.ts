/**
 * Keeps the first occurrence of each id, preserving order. Search
 * sources can legitimately return the same item twice (e.g. a movie
 * matching both title and genre); duplicates would render as twin
 * cards and double-count matches.
 */
export function uniqueById<T extends { id: string }>(items: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}
