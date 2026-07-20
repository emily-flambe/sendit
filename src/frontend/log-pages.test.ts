import { describe, it, expect } from 'vitest';
import { paginateByDay, chunk } from './log-pages';

const entries = (...days: [string, number][]) =>
  days.flatMap(([day, n]) => Array.from({ length: n }, (_, i) => ({ day, i })));

describe('paginateByDay', () => {
  it('returns no pages for no items', () => {
    expect(paginateByDay([], (e: { day: string }) => e.day, 25)).toEqual([]);
  });

  it('puts everything on one page under the size threshold', () => {
    const items = entries(['2026-07-19', 10], ['2026-07-18', 5]);
    expect(paginateByDay(items, (e) => e.day, 25)).toEqual([items]);
  });

  it('closes a page at the first day boundary at or past the threshold', () => {
    const items = entries(['d1', 25], ['d2', 5]);
    const pages = paginateByDay(items, (e) => e.day, 25);
    expect(pages.map((p) => p.length)).toEqual([25, 5]);
  });

  it('lets a page run over the threshold to keep a day whole', () => {
    const items = entries(['d1', 20], ['d2', 10], ['d3', 3]);
    const pages = paginateByDay(items, (e) => e.day, 25);
    expect(pages.map((p) => p.length)).toEqual([30, 3]);
    expect(pages[0].every((e) => e.day !== 'd3')).toBe(true);
  });

  it('never splits a day, even one larger than the threshold', () => {
    const items = entries(['d1', 3], ['d2', 40], ['d3', 2]);
    const pages = paginateByDay(items, (e) => e.day, 25);
    expect(pages.map((p) => p.length)).toEqual([43, 2]);
    for (const page of pages) {
      const days = new Set(page.map((e) => e.day));
      for (const other of pages) {
        if (other === page) continue;
        for (const e of other) expect(days.has(e.day)).toBe(false);
      }
    }
  });

  it('preserves item order across pages', () => {
    const items = entries(['d1', 25], ['d2', 25], ['d3', 1]);
    const pages = paginateByDay(items, (e) => e.day, 25);
    expect(pages.flat()).toEqual(items);
  });
});

describe('chunk', () => {
  it('splits into fixed-size pages', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('returns no pages for no items', () => {
    expect(chunk([], 25)).toEqual([]);
  });
});
