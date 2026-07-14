import type { RouteMarker } from './types';

// Crop rectangle normalized to the (already rotated) image frame.
export interface EditTransform {
  rotate: 0 | 1 | 2 | 3; // quarter turns clockwise, applied before crop
  crop: { x: number; y: number; w: number; h: number };
  width: number; // pre-edit image dimensions in pixels
  height: number;
}

const MAX_MARKER_R = 0.25;

// Remap a normalized marker through rotate-then-crop. Returns null when the
// marker's center lands outside the cropped frame. r is normalized to image
// width, so rotation rescales it by the aspect ratio and crop by 1/crop.w.
export function transformMarker(marker: RouteMarker, edit: EditTransform): RouteMarker | null {
  let { x, y, r } = marker;
  let w = edit.width;
  let h = edit.height;

  for (let turn = 0; turn < edit.rotate; turn++) {
    [x, y] = [1 - y, x];
    r = (r * w) / h;
    [w, h] = [h, w];
  }

  const { crop } = edit;
  x = (x - crop.x) / crop.w;
  y = (y - crop.y) / crop.h;
  r = r / crop.w;

  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { ...marker, x, y, r: Math.min(r, MAX_MARKER_R) };
}

export function transformMarkers(markers: RouteMarker[], edit: EditTransform): RouteMarker[] {
  return markers.map((m) => transformMarker(m, edit)).filter((m): m is RouteMarker => m !== null);
}
