// Day-aligned pagination for the climb log: pages are built from whole days,
// closing at the first day boundary at or past `pageSize`. A day is never
// split across pages, so a page can run somewhat over `pageSize` (and a
// single oversized day gets a page to itself).
export function paginateByDay<T>(items: T[], dayOf: (item: T) => string, pageSize: number): T[][] {
  const pages: T[][] = [];
  let current: T[] = [];
  let i = 0;
  while (i < items.length) {
    const day = dayOf(items[i]);
    const group: T[] = [];
    while (i < items.length && dayOf(items[i]) === day) {
      group.push(items[i]);
      i++;
    }
    current.push(...group);
    if (current.length >= pageSize) {
      pages.push(current);
      current = [];
    }
  }
  if (current.length > 0) pages.push(current);
  return pages;
}

// Plain fixed-size chunks, for sorts where day grouping doesn't apply.
export function chunk<T>(items: T[], size: number): T[][] {
  const pages: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    pages.push(items.slice(i, i + size));
  }
  return pages;
}
