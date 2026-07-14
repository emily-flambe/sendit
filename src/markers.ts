import type { RouteMarker } from './types';

// Crop rectangle normalized to the (already rotated) image frame.
export interface EditTransform {
  rotate: 0 | 1 | 2 | 3; // quarter turns clockwise, applied before crop
  crop: { x: number; y: number; w: number; h: number };
  width: number; // pre-edit image dimensions in pixels
  height: number;
}

const MAX_MARKER_R = 0.25;
const MIN_POLY_R = 0.012;
const MAX_POLY_R = 0.12;

// Derive the circle fields for a polygon marker: center = vertex centroid,
// r = max vertex distance from it (used for hit-testing and stroke widths).
export function markerFromPolygon(polygon: [number, number][]): RouteMarker {
  let cx = 0;
  let cy = 0;
  for (const [px, py] of polygon) {
    cx += px;
    cy += py;
  }
  cx /= polygon.length;
  cy /= polygon.length;
  let r = 0;
  for (const [px, py] of polygon) r = Math.max(r, Math.hypot(px - cx, py - cy));
  return { x: cx, y: cy, r: Math.min(MAX_POLY_R, Math.max(MIN_POLY_R, r)), polygon };
}

// Remap a normalized marker through rotate-then-crop. Returns null when the
// marker's center lands outside the cropped frame. r is normalized to image
// width, so rotation rescales it by the aspect ratio and crop by 1/crop.w.
export function transformMarker(marker: RouteMarker, edit: EditTransform): RouteMarker | null {
  let { x, y, r } = marker;
  let w = edit.width;
  let h = edit.height;
  let poly = marker.polygon?.map(([px, py]) => [px, py] as [number, number]);

  for (let turn = 0; turn < edit.rotate; turn++) {
    [x, y] = [1 - y, x];
    poly = poly?.map(([px, py]) => [1 - py, px]);
    r = (r * w) / h;
    [w, h] = [h, w];
  }

  const { crop } = edit;
  x = (x - crop.x) / crop.w;
  y = (y - crop.y) / crop.h;
  r = r / crop.w;
  poly = poly?.map(([px, py]) => [
    Math.min(1, Math.max(0, (px - crop.x) / crop.w)),
    Math.min(1, Math.max(0, (py - crop.y) / crop.h)),
  ]);

  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { ...marker, x, y, r: Math.min(r, MAX_MARKER_R), ...(poly ? { polygon: poly } : {}) };
}

export function transformMarkers(markers: RouteMarker[], edit: EditTransform): RouteMarker[] {
  return markers.map((m) => transformMarker(m, edit)).filter((m): m is RouteMarker => m !== null);
}
