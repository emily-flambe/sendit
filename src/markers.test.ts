import { describe, it, expect } from 'vitest';
import { markerFromPolygon, transformDrawings, transformMarkers, type EditTransform } from './markers';
import type { DrawingItem } from './types';

const edit = (partial: Partial<EditTransform>): EditTransform => ({
  rotate: 0,
  crop: { x: 0, y: 0, w: 1, h: 1 },
  width: 1000,
  height: 2000,
  ...partial,
});

describe('markerFromPolygon', () => {
  it('centers on the vertex centroid with r reaching the farthest vertex', () => {
    const m = markerFromPolygon([
      [0.4, 0.4],
      [0.6, 0.4],
      [0.6, 0.5],
      [0.4, 0.5],
    ]);
    expect(m.x).toBeCloseTo(0.5);
    expect(m.y).toBeCloseTo(0.45);
    expect(m.r).toBeCloseTo(Math.hypot(0.1, 0.05));
    expect(m.polygon).toHaveLength(4);
  });

  it('clamps r into the polygon marker range', () => {
    const tiny = markerFromPolygon([
      [0.5, 0.5],
      [0.501, 0.5],
      [0.5, 0.501],
    ]);
    expect(tiny.r).toBe(0.012);
    const huge = markerFromPolygon([
      [0, 0],
      [1, 0],
      [0.5, 1],
    ]);
    expect(huge.r).toBe(0.12);
  });
});

describe('transformMarkers', () => {
  it('is identity for no-op edits', () => {
    const markers = [{ x: 0.2, y: 0.4, r: 0.02 }];
    expect(transformMarkers(markers, edit({}))).toEqual(markers);
  });

  it('rotates a quarter turn clockwise and rescales r to the new width', () => {
    const [m] = transformMarkers([{ x: 0.2, y: 0.4, r: 0.02 }], edit({ rotate: 1 }));
    expect(m.x).toBeCloseTo(0.6);
    expect(m.y).toBeCloseTo(0.2);
    expect(m.r).toBeCloseTo(0.01); // r * 1000/2000
  });

  it('four quarter turns is identity', () => {
    // rotate accepts 0-3; compose two half-turns instead.
    const half = edit({ rotate: 2 });
    const [m] = transformMarkers(transformMarkers([{ x: 0.2, y: 0.4, r: 0.02 }], half), half);
    expect(m.x).toBeCloseTo(0.2);
    expect(m.y).toBeCloseTo(0.4);
    expect(m.r).toBeCloseTo(0.02);
  });

  it('remaps into a crop and drops markers outside it', () => {
    const result = transformMarkers(
      [
        { x: 0.75, y: 0.25, r: 0.02 },
        { x: 0.2, y: 0.8, r: 0.02 },
      ],
      edit({ crop: { x: 0.5, y: 0, w: 0.5, h: 0.5 } })
    );
    expect(result).toHaveLength(1);
    expect(result[0].x).toBeCloseTo(0.5);
    expect(result[0].y).toBeCloseTo(0.5);
    expect(result[0].r).toBeCloseTo(0.04);
  });

  it('caps r after aggressive crops', () => {
    const [m] = transformMarkers([{ x: 0.5, y: 0.5, r: 0.1 }], edit({ crop: { x: 0.45, y: 0.45, w: 0.1, h: 0.1 } }));
    expect(m.r).toBe(0.25);
  });

  it('rotates and crops polygon vertices along with the center', () => {
    const square: [number, number][] = [
      [0.1, 0.3],
      [0.3, 0.3],
      [0.3, 0.5],
      [0.1, 0.5],
    ];
    const [m] = transformMarkers([{ ...markerFromPolygon(square) }], edit({ rotate: 1, crop: { x: 0.5, y: 0, w: 0.5, h: 1 } }));
    // rotate CW: (x,y) → (1-y, x); crop right half: x → (x-0.5)/0.5
    expect(m.polygon).toBeDefined();
    expect(m.polygon![0][0]).toBeCloseTo(0.4); // (1-0.3-0.5)/0.5
    expect(m.polygon![0][1]).toBeCloseTo(0.1);
    // center stays the centroid of the transformed vertices
    const remapped = markerFromPolygon(m.polygon!);
    expect(m.x).toBeCloseTo(remapped.x);
    expect(m.y).toBeCloseTo(remapped.y);
  });

  it('rotates then crops', () => {
    // (0.2, 0.4) → rotate CW → (0.6, 0.2); crop right half → ((0.6-0.5)/0.5, 0.2/1) = (0.2, 0.2)
    const [m] = transformMarkers(
      [{ x: 0.2, y: 0.4, r: 0.02 }],
      edit({ rotate: 1, crop: { x: 0.5, y: 0, w: 0.5, h: 1 } })
    );
    expect(m.x).toBeCloseTo(0.2);
    expect(m.y).toBeCloseTo(0.2);
    expect(m.r).toBeCloseTo(0.02); // 0.02 * (1000/2000) / 0.5
  });
});

describe('transformDrawings', () => {
  const stroke = (points: [number, number][]): DrawingItem => ({ kind: 'stroke', color: '#ff0000', width: 0.01, points });
  const text = (x: number, y: number): DrawingItem => ({ kind: 'text', color: '#ff0000', size: 0.05, x, y, text: 'hi' });

  it('is identity for no-op edits', () => {
    const items = [stroke([[0.2, 0.4], [0.3, 0.5]]), text(0.5, 0.5)];
    expect(transformDrawings(items, edit({}))).toEqual(items);
  });

  it('remaps stroke points and width through a crop', () => {
    const [s] = transformDrawings([stroke([[0.6, 0.1], [0.8, 0.3]])], edit({ crop: { x: 0.5, y: 0, w: 0.5, h: 0.5 } }));
    expect(s.kind).toBe('stroke');
    if (s.kind !== 'stroke') return;
    expect(s.points[0][0]).toBeCloseTo(0.2); // (0.6-0.5)/0.5
    expect(s.points[0][1]).toBeCloseTo(0.2); // 0.1/0.5
    expect(s.width).toBeCloseTo(0.02); // 0.01 / 0.5
  });

  it('drops a text label whose anchor leaves the crop', () => {
    const result = transformDrawings([text(0.2, 0.8), text(0.75, 0.25)], edit({ crop: { x: 0.5, y: 0, w: 0.5, h: 0.5 } }));
    expect(result).toHaveLength(1);
    const [t] = result;
    expect(t.kind).toBe('text');
    if (t.kind !== 'text') return;
    expect(t.x).toBeCloseTo(0.5);
    expect(t.y).toBeCloseTo(0.5);
    expect(t.size).toBeCloseTo(0.1); // 0.05 / 0.5
  });

  it('keeps a stroke while any point survives, clamping the rest to the edge', () => {
    const [s] = transformDrawings([stroke([[0.4, 0.5], [0.9, 0.5]])], edit({ crop: { x: 0.5, y: 0, w: 0.5, h: 1 } }));
    expect(s.kind).toBe('stroke');
    if (s.kind !== 'stroke') return;
    expect(s.points[0][0]).toBe(0); // (0.4-0.5)/0.5 = -0.2 → clamped to 0
    expect(s.points[1][0]).toBeCloseTo(0.8); // (0.9-0.5)/0.5
  });

  it('drops a stroke with every point cropped out', () => {
    const result = transformDrawings([stroke([[0.1, 0.1], [0.2, 0.2]])], edit({ crop: { x: 0.5, y: 0, w: 0.5, h: 1 } }));
    expect(result).toHaveLength(0);
  });

  it('rescales width and text size on a quarter turn', () => {
    const [s] = transformDrawings([stroke([[0.2, 0.4], [0.3, 0.5]])], edit({ rotate: 1 }));
    if (s.kind !== 'stroke') return;
    expect(s.width).toBeCloseTo(0.005); // 0.01 * 1000/2000
    expect(s.points[0][0]).toBeCloseTo(0.6); // 1 - 0.4
    expect(s.points[0][1]).toBeCloseTo(0.2);
  });
});
