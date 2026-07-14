import {
  api,
  ApiError,
  getToken,
  setToken,
  type Attempt,
  type Discipline,
  type Gym,
  type LinkedRoute,
  type LogEntry,
  type Photo,
  type PhotoEdit,
  type PhotoWithLinks,
  type RouteImage,
  type RouteMarker,
  type RouteWithGym,
  type Route,
} from './api';
import { detectHolds } from './detect';
import { markerFromPolygon } from '../markers';

const GYM_KEY = 'sendit_gym';

let gyms: Gym[] = [];
let activeGymId: string | null = localStorage.getItem(GYM_KEY);

const appEl = document.getElementById('app')!;

// ---------- helpers ----------

// Every dynamic value interpolated into view templates is passed through esc()
// (or comes from a validated allowlist, e.g. colorHex) before rendering.
function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const NAMED_COLORS: Record<string, string> = {
  red: '#d94f3d',
  orange: '#e8853c',
  yellow: '#e3c145',
  green: '#5da35c',
  blue: '#4a8bc9',
  purple: '#9268bd',
  pink: '#d9749f',
  teal: '#4aa8a0',
  white: '#e8e4da',
  black: '#3a3835',
  gray: '#8b8680',
};

function colorHex(color: string): string {
  const key = color.trim().toLowerCase();
  if (NAMED_COLORS[key]) return NAMED_COLORS[key];
  if (/^#[0-9a-f]{3,8}$/i.test(key)) return key;
  return '#6b665f';
}

// Key order drives select-option order; top rope is the default discipline.
const DISCIPLINE_LABELS: Record<Discipline, string> = {
  top_rope: 'Top rope',
  boulder: 'Boulder',
  lead: 'Lead',
  autobelay: 'Auto belay',
};

const BOULDER_GRADES = ['VB', 'V0', 'V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7', 'V8'];
const ROPE_GRADES = [
  '5.8',
  '5.9',
  '5.10a',
  '5.10b',
  '5.10c',
  '5.10d',
  '5.11a',
  '5.11b',
  '5.11c',
  '5.11d',
  '5.12a',
  '5.12b',
  '5.12c',
  '5.12d',
];

function todayStr(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function recency(dateStr: string | null): string {
  if (!dateStr) return '';
  const then = new Date(`${dateStr}T12:00:00`);
  const days = Math.floor((Date.now() - then.getTime()) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

type RouteState = 'sent' | 'project' | 'new';

const STATE_LABELS: Record<RouteState, string> = {
  sent: 'sent',
  project: 'in progress',
  new: 'not tried',
};

function routeState(r: { send_count: number; attempt_count: number }): RouteState {
  if (r.send_count > 0) return 'sent';
  if (r.attempt_count > 0) return 'project';
  return 'new';
}

function routeTitle(r: { name: string; color: string; grade: string }): string {
  if (r.name) return r.name;
  const bits = [r.color, r.grade].filter(Boolean).join(' ');
  return bits || 'Unnamed route';
}

// Rank grades so mixed freetext sorts sensibly: V-scale together, YDS
// together, anything unparseable at the easy end.
function gradeRank(grade: string): number {
  const g = grade.trim().toUpperCase();
  const v = g.match(/^V(B|\d+)/);
  if (v) return 100 + (v[1] === 'B' ? -1 : Number(v[1]));
  const yds = g.match(/^5\.(\d+)([A-D])?/);
  if (yds) return 200 + Number(yds[1]) * 5 + (yds[2] ? yds[2].charCodeAt(0) - 64 : 0);
  return -1;
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(message: string): void {
  document.querySelector('.toast')?.remove();
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = message;
  document.body.appendChild(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), 3200);
}

function fail(err: unknown): void {
  toast(err instanceof ApiError ? err.message : 'Network error');
}

// ---------- photos ----------

// Photo bytes require the Bearer token, so <img src> can't point at the API
// directly. Fetch blobs once per session and hand out object URLs, keyed by
// photo id + updated_at so an edit-overwrite busts the cache.
const photoUrls = new Map<string, string>();

async function photoUrl(photoId: string, version: number): Promise<string> {
  const key = `${photoId}:${version}`;
  const cached = photoUrls.get(key);
  if (cached) return cached;
  const blob = await api.fetchPhotoBlob(photoId, version);
  const url = URL.createObjectURL(blob);
  photoUrls.set(key, url);
  return url;
}

function purgePhotoUrls(photoId: string): void {
  for (const key of [...photoUrls.keys()]) {
    if (key.startsWith(`${photoId}:`)) {
      URL.revokeObjectURL(photoUrls.get(key)!);
      photoUrls.delete(key);
    }
  }
}

function photoImg(photo: { id: string; updated_at?: number }, alt: string): string {
  return `<img data-photo="${esc(photo.id)}" data-photo-v="${photo.updated_at ?? 0}" alt="${esc(alt)}" />`;
}

function hydratePhotos(scope: ParentNode = document): void {
  scope.querySelectorAll<HTMLImageElement>('img[data-photo]').forEach((img) => {
    void photoUrl(img.dataset.photo!, Number(img.dataset.photoV ?? 0))
      .then((url) => {
        img.src = url;
        img.classList.add('loaded');
      })
      .catch(() => img.remove());
  });
}

const MAX_PHOTO_EDGE = 1600;

// Downscale on-device so a 12MB phone photo becomes a ~300KB JPEG. Safari
// decodes HEIC here too, which conveniently converts it to JPEG for upload.
async function preparePhoto(file: File): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_PHOTO_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    if (blob) return blob;
  } catch {
    // Couldn't decode locally — send the original and let the server judge it.
  }
  return file;
}

function openLightbox(photo: Photo, routeId: string, onChange: () => void): void {
  const overlay = document.createElement('div');
  overlay.className = 'lightbox';

  const img = document.createElement('img');
  img.dataset.photo = photo.id;
  img.dataset.photoV = String(photo.updated_at);
  img.alt = 'Route photo';

  const actions = document.createElement('div');
  actions.className = 'lightbox-actions';
  const closeBtn = document.createElement('button');
  closeBtn.className = 'btn ghost';
  closeBtn.textContent = 'Close';
  const galleryLink = document.createElement('a');
  galleryLink.className = 'linkish';
  galleryLink.textContent = 'Open in gallery';
  galleryLink.href = `#/photo/${photo.id}`;
  const unlinkBtn = document.createElement('button');
  unlinkBtn.className = 'linkish danger';
  unlinkBtn.textContent = 'Remove from route';
  actions.append(closeBtn, galleryLink, unlinkBtn);

  overlay.append(img, actions);
  document.body.appendChild(overlay);
  hydratePhotos(overlay);

  closeBtn.addEventListener('click', () => overlay.remove());
  galleryLink.addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });
  unlinkBtn.addEventListener('click', async () => {
    if (!confirm('Remove this photo from the route? It stays in your gallery.')) return;
    try {
      await api.unlinkPhoto(routeId, photo.id);
      overlay.remove();
      onChange();
    } catch (err) {
      fail(err);
    }
  });
}

// ---------- route image (annotated topo) ----------

const DEFAULT_MARKER_R = 0.02;
const MAX_MARKERS = 100; // mirrors the API's per-image marker cap
const MAX_POLY_POINTS = 80; // mirrors the API's per-polygon vertex cap
const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string>): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

// One black shape per hold in the spotlight mask; the black stroke dilates the
// region so the hold sits fully inside the bright zone.
function maskShape(m: RouteMarker, w: number, h: number, dilate: number): SVGElement {
  if (m.polygon && m.polygon.length >= 3) {
    return svgEl('polygon', {
      points: m.polygon.map(([px, py]) => `${px * w},${py * h}`).join(' '),
      fill: 'black',
      stroke: 'black',
      'stroke-width': String(dilate),
      'stroke-linejoin': 'round',
    });
  }
  return svgEl('circle', {
    cx: String(m.x * w),
    cy: String(m.y * h),
    r: String(m.r * w + dilate / 2),
    fill: 'black',
  });
}

let spotlightSeq = 0;

// The focus effect: a dimmed/blurred/desaturated copy of the photo covers
// everything except the hold regions, which are punched out of it (feathered)
// via a luminance mask. All natural-pixel units, so it survives resize/zoom.
function drawSpotlight(svg: SVGSVGElement, markers: RouteMarker[], w: number, h: number, src: string): void {
  const uid = `sp${spotlightSeq++}`;
  const feather = w * 0.006;
  const dilate = w * 0.02;

  const defs = svgEl('defs', {});
  const dim = svgEl('filter', { id: `${uid}-dim` });
  dim.appendChild(svgEl('feGaussianBlur', { stdDeviation: String(w * 0.004) }));
  dim.appendChild(svgEl('feColorMatrix', { type: 'saturate', values: '0.5' }));
  const transfer = svgEl('feComponentTransfer', {});
  for (const fn of ['feFuncR', 'feFuncG', 'feFuncB'] as const) {
    transfer.appendChild(svgEl(fn, { type: 'linear', slope: '0.45' }));
  }
  dim.appendChild(transfer);

  const featherF = svgEl('filter', { id: `${uid}-feather` });
  featherF.appendChild(svgEl('feGaussianBlur', { stdDeviation: String(feather) }));

  const mask = svgEl('mask', { id: `${uid}-mask`, maskUnits: 'userSpaceOnUse', x: '0', y: '0', width: String(w), height: String(h) });
  mask.appendChild(svgEl('rect', { width: String(w), height: String(h), fill: 'white' }));
  const holes = svgEl('g', { filter: `url(#${uid}-feather)` });
  for (const m of markers) holes.appendChild(maskShape(m, w, h, dilate));
  mask.appendChild(holes);

  defs.append(dim, featherF, mask);

  const image = svgEl('image', {
    href: src,
    width: String(w),
    height: String(h),
    filter: `url(#${uid}-dim)`,
    mask: `url(#${uid}-mask)`,
    preserveAspectRatio: 'none',
  });
  svg.append(defs, image);
}

type MarkerMode = 'edit' | 'focus';

// Callers clear the svg first; this only appends, so the spotlight layer and
// in-progress trace can compose with it.
function drawMarkers(svg: SVGSVGElement, markers: RouteMarker[], w: number, h: number, color: string, mode: MarkerMode): void {
  for (const m of markers) {
    if (m.polygon && m.polygon.length >= 3) {
      const pts = m.polygon.map(([px, py]) => `${px * w},${py * h}`).join(' ');
      if (mode === 'focus') {
        // The spotlight already carries the emphasis; just a thin identity rim.
        svg.appendChild(svgEl('polygon', {
          points: pts,
          fill: 'none',
          stroke: color,
          'stroke-opacity': '0.85',
          'stroke-width': String(Math.max(w * 0.0015, m.r * w * 0.06)),
          'stroke-linejoin': 'round',
        }));
        continue;
      }
      // Editor: filled silhouette. A white casing stroke under the colored one
      // keeps it visible on any hold.
      svg.appendChild(svgEl('polygon', {
        points: pts,
        fill: 'none',
        stroke: 'rgba(255,255,255,0.9)',
        'stroke-width': String(m.r * w * 0.32),
        'stroke-linejoin': 'round',
      }));
      svg.appendChild(svgEl('polygon', {
        points: pts,
        fill: color,
        'fill-opacity': '0.4',
        stroke: color,
        'stroke-width': String(m.r * w * 0.16),
        'stroke-linejoin': 'round',
      }));
      continue;
    }
    const r = m.r * w;
    const rings: readonly (readonly [string, number])[] =
      mode === 'focus'
        ? [[color, Math.max(w * 0.0015, r * 0.12)]]
        : [
            ['rgba(255,255,255,0.9)', r * 0.45],
            [color, r * 0.22],
          ];
    for (const [stroke, width] of rings) {
      svg.appendChild(svgEl('circle', {
        cx: String(m.x * w),
        cy: String(m.y * h),
        r: String(r),
        fill: 'none',
        stroke,
        'stroke-width': String(width),
      }));
    }
  }
}

// Photo + marker overlay. Markers are normalized; the SVG viewBox uses the
// image's natural pixel size so circles stay circular at any display size.
// With focus=true the saved route image renders spotlit — holds bright and
// sharp, the rest of the wall dimmed and blurred — and the outlines become a
// separate layer (off by default; the spotlight IS the final image).
function annotatedImage(
  photoId: string,
  photoV: number,
  markers: () => RouteMarker[],
  color: string,
  opts: { focus?: boolean; outlines?: () => boolean } = {}
): { wrap: HTMLDivElement; rerender: () => void } {
  const wrap = document.createElement('div');
  wrap.className = 'annot-wrap';
  const img = document.createElement('img');
  img.dataset.photo = photoId;
  img.dataset.photoV = String(photoV);
  img.alt = 'Route image';
  const svg = document.createElementNS(SVG_NS, 'svg') as SVGSVGElement;
  wrap.append(img, svg);
  const rerender = () => {
    if (!img.naturalWidth) return;
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.textContent = '';
    if (opts.focus) {
      if (markers().length > 0) drawSpotlight(svg, markers(), w, h, img.src);
      if (opts.outlines?.()) drawMarkers(svg, markers(), w, h, colorHex(color), 'focus');
    } else {
      drawMarkers(svg, markers(), w, h, colorHex(color), 'edit');
    }
  };
  img.addEventListener('load', rerender);
  return { wrap, rerender };
}

// setPointerCapture throws for pointers the browser doesn't know about
// (synthetic events); capture is an enhancement, never load-bearing.
function capturePointer(el: Element, pointerId: number): void {
  try {
    el.setPointerCapture(pointerId);
  } catch {
    // ignore
  }
}

// Pinch / scroll / drag zoom for a full-screen overlay body. Taps (total
// pointer travel under a finger-slop threshold) are forwarded to onTap in
// client coordinates; everything else pans or zooms the wrapped content.
function wireZoomAndTap(body: HTMLElement, wrap: HTMLElement, onTap: ((x: number, y: number) => void) | null): void {
  const TAP_SLOP = 8;
  let scale = 1;
  let tx = 0;
  let ty = 0;
  const pointers = new Map<number, { x: number; y: number; startX: number; startY: number }>();
  let pinchStart: { dist: number; scale: number } | null = null;
  let gestureMoved = false;

  wrap.style.transformOrigin = '0 0';
  body.style.touchAction = 'none';

  function apply(): void {
    if (scale <= 1.01) {
      scale = 1;
      tx = 0;
      ty = 0;
    }
    wrap.style.transform = scale === 1 ? '' : `translate(${tx}px, ${ty}px) scale(${scale})`;
  }

  // Zoom so the content point under (cx, cy) stays fixed on screen.
  function zoomAt(cx: number, cy: number, next: number): void {
    const clamped = Math.min(6, Math.max(1, next));
    const rect = wrap.getBoundingClientRect();
    const baseX = rect.left - tx;
    const baseY = rect.top - ty;
    const contentX = (cx - baseX - tx) / scale;
    const contentY = (cy - baseY - ty) / scale;
    tx = cx - baseX - contentX * clamped;
    ty = cy - baseY - contentY * clamped;
    scale = clamped;
    apply();
  }

  body.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      zoomAt(e.clientX, e.clientY, scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
    },
    { passive: false }
  );

  body.addEventListener('pointerdown', (e) => {
    capturePointer(body, e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY });
    if (pointers.size === 1) gestureMoved = false;
    if (pointers.size === 2) {
      gestureMoved = true; // two fingers is never a tap
      const [a, b] = [...pointers.values()];
      pinchStart = { dist: Math.hypot(a.x - b.x, a.y - b.y), scale };
    }
  });

  body.addEventListener('pointermove', (e) => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;

    if (Math.hypot(p.x - p.startX, p.y - p.startY) > TAP_SLOP) gestureMoved = true;

    if (pointers.size === 2 && pinchStart && pinchStart.dist > 0) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, (pinchStart.scale * dist) / pinchStart.dist);
    } else if (pointers.size === 1 && scale > 1 && gestureMoved) {
      tx += dx;
      ty += dy;
      apply();
    }
  });

  function release(e: PointerEvent): void {
    const p = pointers.get(e.pointerId);
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchStart = null;
    if (e.type === 'pointerup' && p && !gestureMoved && pointers.size === 0 && onTap) {
      onTap(e.clientX, e.clientY);
    }
  }
  body.addEventListener('pointerup', release);
  body.addEventListener('pointercancel', release);
}

function annotOverlay(title: string): { overlay: HTMLDivElement; head: HTMLDivElement; body: HTMLDivElement; foot: HTMLDivElement } {
  const overlay = document.createElement('div');
  overlay.className = 'annot-editor';
  const head = document.createElement('div');
  head.className = 'annot-editor-head';
  const titleEl = document.createElement('span');
  titleEl.className = 'annot-title';
  titleEl.textContent = title;
  head.appendChild(titleEl);
  const body = document.createElement('div');
  body.className = 'annot-editor-body';
  const foot = document.createElement('div');
  foot.className = 'annot-editor-foot';
  overlay.append(head, body, foot);
  document.body.appendChild(overlay);
  return { overlay, head, body, foot };
}

function openRouteImageViewer(image: RouteImage, photoV: number, color: string): void {
  const { overlay, head, body } = annotOverlay('Route image');
  const closeBtn = document.createElement('button');
  closeBtn.className = 'btn ghost';
  closeBtn.textContent = 'Close';
  closeBtn.addEventListener('click', () => overlay.remove());
  head.prepend(closeBtn);
  let showOutlines = false;
  const outlineBtn = document.createElement('button');
  outlineBtn.className = 'btn ghost';
  outlineBtn.textContent = 'Outlines';
  head.appendChild(outlineBtn);
  const { wrap, rerender } = annotatedImage(image.photo_id, photoV, () => image.markers, color, {
    focus: true,
    outlines: () => showOutlines,
  });
  outlineBtn.addEventListener('click', () => {
    showOutlines = !showOutlines;
    outlineBtn.textContent = showOutlines ? 'Outlines ✓' : 'Outlines';
    rerender();
  });
  body.appendChild(wrap);
  wireZoomAndTap(body, wrap, null);
  hydratePhotos(overlay);
}

function openRouteImageEditor(
  routeId: string,
  photoId: string,
  photoV: number,
  initial: RouteMarker[],
  color: string,
  onSaved: () => void
): void {
  const markers: RouteMarker[] = initial.map((m) => ({ ...m }));

  const { overlay, head, body, foot } = annotOverlay('Mark the holds');
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn ghost';
  cancelBtn.textContent = 'Cancel';
  const saveBtn = document.createElement('button');
  saveBtn.className = 'btn primary';
  head.prepend(cancelBtn);
  head.appendChild(saveBtn);

  const detectBtn = document.createElement('button');
  detectBtn.className = 'btn ghost detect-btn';
  detectBtn.textContent = '✨ Auto-detect';
  const traceBtn = document.createElement('button');
  traceBtn.className = 'btn ghost detect-btn';
  traceBtn.textContent = '⬠ Draw shape';
  const previewBtn = document.createElement('button');
  previewBtn.className = 'btn ghost detect-btn';
  previewBtn.textContent = '◐ Preview';
  const btnRow = document.createElement('div');
  btnRow.className = 'annot-btn-row';
  btnRow.append(detectBtn, traceBtn, previewBtn);
  const hint = document.createElement('p');
  hint.className = 'annot-hint';
  foot.append(btnRow, hint);

  const { wrap } = annotatedImage(photoId, photoV, () => markers, color);
  body.appendChild(wrap);
  hydratePhotos(overlay);
  const img = wrap.querySelector('img')!;
  const svg = wrap.querySelector('svg')!;

  // Tap-to-trace state: while non-null, taps append outline vertices instead
  // of adding/removing markers.
  let trace: [number, number][] | null = null;
  let preview = false;

  function syncHint(): void {
    if (trace) {
      hint.textContent =
        trace.length < 3
          ? 'Tap around the hold’s edge to outline it.'
          : 'Keep tapping, or tap the first point (or Done) to close the shape.';
    } else if (preview) {
      hint.textContent = 'This is how the route image will look. Taps still edit.';
    } else {
      hint.textContent = 'Tap a hold to mark it, tap a mark to remove it. Pinch or scroll to zoom.';
    }
  }

  function drawTrace(w: number, h: number): void {
    if (!trace || trace.length === 0) return;
    const pts = trace.map(([px, py]) => `${px * w},${py * h}`).join(' ');
    if (trace.length > 1) {
      svg.appendChild(svgEl('polyline', {
        points: pts,
        fill: 'none',
        stroke: 'rgba(255,255,255,0.9)',
        'stroke-width': String(w * 0.004),
        'stroke-dasharray': `${w * 0.01} ${w * 0.006}`,
        'stroke-linejoin': 'round',
      }));
    }
    trace.forEach(([px, py], i) => {
      svg.appendChild(svgEl('circle', {
        cx: String(px * w),
        cy: String(py * h),
        r: String(w * (i === 0 ? 0.012 : 0.006)),
        fill: i === 0 ? 'rgba(255,255,255,0.25)' : 'white',
        stroke: colorHex(color),
        'stroke-width': String(w * 0.003),
      }));
    });
  }

  function sync(): void {
    if (trace) {
      saveBtn.textContent = trace.length >= 3 ? 'Done' : 'Save';
      saveBtn.disabled = trace.length < 3;
    } else {
      saveBtn.textContent = `Save (${markers.length})`;
      saveBtn.disabled = markers.length === 0;
    }
    traceBtn.textContent = trace ? '↩ Undo point' : '⬠ Draw shape';
    previewBtn.textContent = preview ? '◐ Preview ✓' : '◐ Preview';
    previewBtn.disabled = trace !== null;
    detectBtn.disabled = trace !== null;
    cancelBtn.textContent = trace ? 'Cancel shape' : 'Cancel';
    syncHint();
    if (img.naturalWidth) {
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      svg.textContent = '';
      if (preview) {
        // Preview shows the final image: spotlight only, no outline layer.
        if (markers.length > 0) drawSpotlight(svg, markers, w, h, img.src);
      } else {
        drawMarkers(svg, markers, w, h, colorHex(color), 'edit');
        drawTrace(w, h);
      }
    }
  }
  sync();
  img.addEventListener('load', sync);

  function closeTrace(): void {
    if (trace && trace.length >= 3) markers.push(markerFromPolygon(trace.slice(0, MAX_POLY_POINTS)));
    trace = null;
    sync();
  }

  // svg's client rect reflects the zoom transform, so normalized coordinates
  // come out right at any zoom level.
  wireZoomAndTap(body, wrap, (cx, cy) => {
    const rect = svg.getBoundingClientRect();
    if (rect.width === 0 || cx < rect.left || cx > rect.right || cy < rect.top || cy > rect.bottom) return;
    const nx = (cx - rect.left) / rect.width;
    const ny = (cy - rect.top) / rect.height;

    if (trace) {
      // Tapping the first vertex closes the shape.
      if (trace.length >= 3) {
        const [fx, fy] = trace[0];
        if (Math.hypot((fx - nx) * rect.width, (fy - ny) * rect.height) < 14) {
          closeTrace();
          return;
        }
      }
      if (trace.length < MAX_POLY_POINTS) {
        trace.push([Math.min(1, Math.max(0, nx)), Math.min(1, Math.max(0, ny))]);
      }
      sync();
      return;
    }

    for (let i = markers.length - 1; i >= 0; i--) {
      const m = markers[i];
      const dx = (m.x - nx) * rect.width;
      const dy = (m.y - ny) * rect.height;
      const hitRadius = m.r * rect.width + 8;
      if (dx * dx + dy * dy <= hitRadius * hitRadius) {
        markers.splice(i, 1);
        sync();
        return;
      }
    }
    markers.push({ x: Math.min(1, Math.max(0, nx)), y: Math.min(1, Math.max(0, ny)), r: DEFAULT_MARKER_R });
    sync();
  });

  traceBtn.addEventListener('click', () => {
    if (trace) {
      trace.pop(); // undo last point
    } else {
      trace = [];
      preview = false;
    }
    sync();
  });

  previewBtn.addEventListener('click', () => {
    preview = !preview;
    sync();
  });

  async function ensureImageLoaded(): Promise<void> {
    if (img.complete && img.naturalWidth > 0) return;
    await new Promise<void>((resolve, reject) => {
      img.addEventListener('load', () => resolve(), { once: true });
      img.addEventListener('error', () => reject(new Error('image load failed')), { once: true });
    });
  }

  const colorWord = color.trim().toLowerCase();
  detectBtn.addEventListener('click', async () => {
    detectBtn.disabled = true;

    // Full-cover spinner: inference runs in a worker so this keeps animating,
    // and it makes the multi-second wait legible instead of feeling dead.
    const spinner = document.createElement('div');
    spinner.className = 'detect-spinner';
    const dot = document.createElement('div');
    dot.className = 'detect-dot';
    const msg = document.createElement('p');
    msg.textContent = `Finding ${colorWord || ''} holds…`;
    const sub = document.createElement('p');
    sub.className = 'detect-sub';
    sub.textContent = 'First run downloads the detector (~20MB), then it is instant.';
    spinner.append(dot, msg, sub);
    overlay.appendChild(spinner);

    try {
      await ensureImageLoaded();
      const { markers: found, total } = await detectHolds(img, colorHex(color));
      let added = 0;
      for (const m of found) {
        if (markers.length >= MAX_MARKERS) break;
        // Skip a detection that lands on an existing marker so re-running is safe.
        const dup = markers.some((e) => Math.hypot(e.x - m.x, e.y - m.y) < Math.max(e.r, m.r));
        if (dup) continue;
        markers.push(m);
        added++;
      }
      sync();
      if (added > 0) {
        toast(`Outlined ${added} ${colorWord} hold${added === 1 ? '' : 's'}. Tap any to remove.`);
      } else if (total > 0) {
        toast(`Found ${total} holds but none matched ${colorWord || 'that color'}. Tap to mark them.`);
      } else {
        toast('No holds detected. Tap to mark them.');
      }
    } catch {
      toast('Detection failed — mark holds by tapping instead.');
    } finally {
      spinner.remove();
      detectBtn.disabled = false;
    }
  });

  cancelBtn.addEventListener('click', () => {
    if (trace) {
      trace = null;
      sync();
      return;
    }
    overlay.remove();
  });
  saveBtn.addEventListener('click', async () => {
    if (trace) {
      closeTrace();
      return;
    }
    saveBtn.disabled = true;
    try {
      await api.setRouteImage(routeId, photoId, markers);
      overlay.remove();
      toast('Route image saved.');
      onSaved();
    } catch (err) {
      saveBtn.disabled = false;
      fail(err);
    }
  });
}

function openRouteImagePicker(photos: Photo[], onPick: (photo: Photo) => void): void {
  const { overlay, head, body } = annotOverlay('Pick a photo to annotate');
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn ghost';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => overlay.remove());
  head.prepend(cancelBtn);

  const grid = document.createElement('div');
  grid.className = 'annot-picker-grid';
  for (const photo of photos) {
    const btn = document.createElement('button');
    btn.className = 'photo-thumb';
    const img = document.createElement('img');
    img.dataset.photo = photo.id;
    img.dataset.photoV = String(photo.updated_at);
    img.alt = 'Route photo';
    btn.appendChild(img);
    btn.addEventListener('click', () => {
      overlay.remove();
      onPick(photo);
    });
    grid.appendChild(btn);
  }
  body.appendChild(grid);
  hydratePhotos(overlay);
}

// ---------- photo gallery & image editing ----------

const JPEG_QUALITY = 0.88;

function rotatedDims(w: number, h: number, rotate: number): [number, number] {
  return rotate % 2 === 1 ? [h, w] : [w, h];
}

// Render the original image through rotate-then-crop at full resolution.
function renderEdit(img: HTMLImageElement, edit: PhotoEdit): HTMLCanvasElement {
  const [rw, rh] = rotatedDims(img.naturalWidth, img.naturalHeight, edit.rotate);
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(edit.crop.w * rw));
  out.height = Math.max(1, Math.round(edit.crop.h * rh));
  const ctx = out.getContext('2d')!;
  ctx.translate(-edit.crop.x * rw, -edit.crop.y * rh);
  if (edit.rotate === 1) {
    ctx.translate(rh, 0);
  } else if (edit.rotate === 2) {
    ctx.translate(rw, rh);
  } else if (edit.rotate === 3) {
    ctx.translate(0, rw);
  }
  ctx.rotate((edit.rotate * Math.PI) / 2);
  ctx.drawImage(img, 0, 0);
  return out;
}

async function openImageEditor(photo: Photo, annotatedRoutes: number, onDone: () => void): Promise<void> {
  const url = await photoUrl(photo.id, photo.updated_at);
  const source = new Image();
  source.src = url;
  await source.decode();

  let rotate: PhotoEdit['rotate'] = 0;
  let crop = { x: 0, y: 0, w: 1, h: 1 };

  const { overlay, head, body, foot } = annotOverlay('Edit photo');
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn ghost';
  cancelBtn.textContent = 'Cancel';
  head.prepend(cancelBtn);
  cancelBtn.addEventListener('click', () => overlay.remove());

  const wrap = document.createElement('div');
  wrap.className = 'edit-wrap';
  const canvas = document.createElement('canvas');
  const cropRect = document.createElement('div');
  cropRect.className = 'crop-rect';
  for (const corner of ['nw', 'ne', 'sw', 'se']) {
    const handle = document.createElement('div');
    handle.className = `crop-handle crop-${corner}`;
    handle.dataset.corner = corner;
    cropRect.appendChild(handle);
  }
  wrap.append(canvas, cropRect);
  body.appendChild(wrap);

  foot.innerHTML = `
    ${annotatedRoutes > 0 ? `<p class="edit-note">${annotatedRoutes} marked route${annotatedRoutes === 1 ? '' : 's'} on this photo — markers move with the edit on Save.</p>` : ''}
    <div class="edit-actions">
      <button class="btn ghost" id="edit-rotate">Rotate</button>
      <button class="btn ghost" id="edit-reset">Reset</button>
      <button class="btn primary" id="edit-save">Save</button>
      <button class="btn ghost" id="edit-save-copy">Save as copy</button>
    </div>`;

  function redraw(): void {
    const [rw, rh] = rotatedDims(source.naturalWidth, source.naturalHeight, rotate);
    const maxW = Math.min(window.innerWidth - 32, 900);
    const maxH = window.innerHeight - 210;
    const displayScale = Math.min(maxW / rw, maxH / rh, 1);
    canvas.width = Math.max(1, Math.round(rw * displayScale));
    canvas.height = Math.max(1, Math.round(rh * displayScale));
    const full = renderEdit(source, { rotate, crop: { x: 0, y: 0, w: 1, h: 1 }, width: source.naturalWidth, height: source.naturalHeight });
    canvas.getContext('2d')!.drawImage(full, 0, 0, canvas.width, canvas.height);
    positionCrop();
  }

  function positionCrop(): void {
    cropRect.style.left = `${crop.x * canvas.width}px`;
    cropRect.style.top = `${crop.y * canvas.height}px`;
    cropRect.style.width = `${crop.w * canvas.width}px`;
    cropRect.style.height = `${crop.h * canvas.height}px`;
  }

  const MIN_CROP = 0.1;
  let drag: { mode: 'move' | string; startX: number; startY: number; start: typeof crop } | null = null;

  cropRect.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    capturePointer(cropRect, e.pointerId);
    const corner = (e.target as HTMLElement).dataset.corner;
    drag = { mode: corner ?? 'move', startX: e.clientX, startY: e.clientY, start: { ...crop } };
  });

  cropRect.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = (e.clientX - drag.startX) / canvas.width;
    const dy = (e.clientY - drag.startY) / canvas.height;
    const c = { ...drag.start };
    if (drag.mode === 'move') {
      c.x = Math.min(1 - c.w, Math.max(0, c.x + dx));
      c.y = Math.min(1 - c.h, Math.max(0, c.y + dy));
    } else {
      // Corners resize; the opposite corner stays put.
      let x1 = c.x;
      let y1 = c.y;
      let x2 = c.x + c.w;
      let y2 = c.y + c.h;
      if (drag.mode.includes('w')) x1 = Math.min(x2 - MIN_CROP, Math.max(0, x1 + dx));
      if (drag.mode.includes('e')) x2 = Math.max(x1 + MIN_CROP, Math.min(1, x2 + dx));
      if (drag.mode.includes('n')) y1 = Math.min(y2 - MIN_CROP, Math.max(0, y1 + dy));
      if (drag.mode.includes('s')) y2 = Math.max(y1 + MIN_CROP, Math.min(1, y2 + dy));
      c.x = x1;
      c.y = y1;
      c.w = x2 - x1;
      c.h = y2 - y1;
    }
    crop = c;
    positionCrop();
  });

  cropRect.addEventListener('pointerup', () => {
    drag = null;
  });

  foot.querySelector('#edit-rotate')!.addEventListener('click', () => {
    rotate = (((rotate + 1) % 4) as PhotoEdit['rotate']);
    crop = { x: 0, y: 0, w: 1, h: 1 };
    redraw();
  });
  foot.querySelector('#edit-reset')!.addEventListener('click', () => {
    rotate = 0;
    crop = { x: 0, y: 0, w: 1, h: 1 };
    redraw();
  });

  async function save(mode: 'overwrite' | 'new'): Promise<void> {
    const edit: PhotoEdit = { rotate, crop, width: source.naturalWidth, height: source.naturalHeight };
    const out = renderEdit(source, edit);
    const blob = await new Promise<Blob | null>((resolve) => out.toBlob(resolve, 'image/jpeg', JPEG_QUALITY));
    if (!blob) {
      toast('Could not encode the edited image.');
      return;
    }
    try {
      const result = await api.editPhoto(photo.id, blob, edit, mode);
      overlay.remove();
      if (mode === 'overwrite') {
        purgePhotoUrls(photo.id);
        toast('Photo updated.');
        onDone();
      } else {
        toast('Saved as a new photo.');
        window.location.hash = `#/photo/${result.photo.id}`;
      }
    } catch (err) {
      fail(err);
    }
  }
  foot.querySelector('#edit-save')!.addEventListener('click', () => void save('overwrite'));
  foot.querySelector('#edit-save-copy')!.addEventListener('click', () => void save('new'));

  redraw();
}

function openPhotoViewer(photo: Photo): void {
  const { overlay, head, body } = annotOverlay('Photo');
  const closeBtn = document.createElement('button');
  closeBtn.className = 'btn ghost';
  closeBtn.textContent = 'Close';
  closeBtn.addEventListener('click', () => overlay.remove());
  head.prepend(closeBtn);
  const wrap = document.createElement('div');
  wrap.className = 'annot-wrap';
  wrap.innerHTML = photoImg(photo, 'Photo');
  body.appendChild(wrap);
  wireZoomAndTap(body, wrap, null);
  hydratePhotos(overlay);
}

let galleryGym = 'all';

async function renderGallery(): Promise<void> {
  let photos: PhotoWithLinks[];
  try {
    photos = (await api.listGalleryPhotos(galleryGym === 'all' ? null : galleryGym)).photos;
  } catch (err) {
    fail(err);
    return;
  }

  const tiles = photos
    .map((photo) => {
      const badge = photo.link_count > 0 ? `<span class="gallery-badge">${photo.link_count}</span>` : '';
      return `<a class="gallery-tile" href="#/photo/${esc(photo.id)}">${photoImg(photo, 'Photo')}${badge}</a>`;
    })
    .join('');

  shell(
    `${header('photos')}
    <main class="list">
      <div class="filter-bar">
        <select data-f="gym" aria-label="gym">
          <option value="all" ${galleryGym === 'all' ? 'selected' : ''}>All gyms</option>
          ${gyms.map((g) => `<option value="${esc(g.id)}" ${galleryGym === g.id ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}
        </select>
      </div>
      <div class="gallery-grid">
        <label class="photo-add gallery-add" aria-label="Add photo">
          <input type="file" accept="image/*" hidden />
          <span class="photo-add-plus">+</span>
          <span class="photo-add-label">photo</span>
        </label>
        ${tiles}
      </div>
      ${photos.length === 0 ? '<p class="empty">No photos yet. Snap the wall next time you are at the gym.</p>' : ''}
    </main>`,
    'photos'
  );

  hydratePhotos();

  document.querySelector<HTMLSelectElement>('.filter-bar select')!.addEventListener('change', (e) => {
    galleryGym = (e.target as HTMLSelectElement).value;
    void renderGallery();
  });

  const input = document.querySelector<HTMLInputElement>('.gallery-add input')!;
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    input.disabled = true;
    toast('Uploading photo…');
    try {
      const blob = await preparePhoto(file);
      await api.uploadGalleryPhoto(blob, galleryGym === 'all' ? null : galleryGym);
      void renderGallery();
    } catch (err) {
      input.disabled = false;
      input.value = '';
      fail(err);
    }
  });
}

async function renderPhotoDetail(photoId: string): Promise<void> {
  let photo: Photo;
  let routes: LinkedRoute[];
  try {
    ({ photo, routes } = await api.getPhotoInfo(photoId));
  } catch (err) {
    fail(err);
    window.location.hash = '#/photos';
    return;
  }

  const routeChips = routes
    .map(
      (r) => `<a class="route-card" href="#/route/${esc(r.route_id)}">
        <span class="tape" style="background:${colorHex(r.color)}"></span>
        <span class="route-card-body">
          <span class="route-card-top">
            <strong>${esc(routeTitle(r))}</strong>
            ${r.has_annotation ? '<span class="state state-sent">marked</span>' : ''}
          </span>
        </span>
        <span class="route-card-grade">${esc(r.grade)}</span>
      </a>`
    )
    .join('');

  shell(
    `<header class="masthead compact">
      <a class="back" href="#/photos">&larr;</a>
      <h2>Photo</h2>
    </header>
    <main class="detail">
      <div class="annot-wrap" id="photo-view">${photoImg(photo, 'Photo')}</div>
      <label class="photo-gym">Gym
        <select id="photo-gym-select">
          <option value="" ${photo.gym_id ? '' : 'selected'}>No gym</option>
          ${gyms.map((g) => `<option value="${esc(g.id)}" ${photo.gym_id === g.id ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}
        </select>
      </label>
      <section class="log-actions">
        <button class="btn primary wide" id="photo-edit">Edit image</button>
        <button class="btn ghost wide" id="photo-add-route">Add to a route</button>
        <button class="btn ghost wide" id="photo-new-route">Create route from this photo</button>
      </section>
      <section class="history">
        <h3>Routes on this photo</h3>
        ${routeChips || '<p class="empty">No routes linked yet.</p>'}
      </section>
      <section class="danger-zone">
        <button class="linkish danger" id="photo-delete">Delete photo everywhere</button>
      </section>
    </main>`,
    'photos'
  );

  hydratePhotos();

  document.getElementById('photo-view')!.addEventListener('click', () => openPhotoViewer(photo));

  document.getElementById('photo-gym-select')!.addEventListener('change', async (e) => {
    try {
      await api.updatePhotoGym(photo.id, (e.target as HTMLSelectElement).value || null);
      toast('Photo updated.');
    } catch (err) {
      fail(err);
    }
  });

  document.getElementById('photo-edit')!.addEventListener('click', () => {
    const annotated = routes.filter((r) => r.has_annotation).length;
    void openImageEditor(photo, annotated, () => void renderPhotoDetail(photo.id));
  });

  document.getElementById('photo-new-route')!.addEventListener('click', () => {
    window.location.hash = `#/new?photo=${photo.id}`;
  });

  document.getElementById('photo-add-route')!.addEventListener('click', async () => {
    let all: RouteWithGym[];
    try {
      all = (await api.listAllRoutes(false)).routes;
    } catch (err) {
      fail(err);
      return;
    }
    const linked = new Set(routes.map((r) => r.route_id));
    // Same gym when the photo is tagged; anywhere when it isn't.
    const candidates = all.filter((r) => !linked.has(r.id) && (!photo.gym_id || r.gym_id === photo.gym_id));
    if (candidates.length === 0) {
      toast('No unlinked routes for this gym. Create one from the photo instead.');
      return;
    }
    const { overlay, head, body } = annotOverlay('Add to a route');
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn ghost';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => overlay.remove());
    head.prepend(cancelBtn);

    const list = document.createElement('div');
    list.className = 'route-pick-list';
    for (const r of candidates) {
      const btn = document.createElement('button');
      btn.className = 'route-card route-pick';
      const tape = document.createElement('span');
      tape.className = 'tape';
      tape.style.background = colorHex(r.color);
      const cardBody = document.createElement('span');
      cardBody.className = 'route-card-body';
      const top = document.createElement('span');
      top.className = 'route-card-top';
      const title = document.createElement('strong');
      title.textContent = routeTitle(r);
      top.appendChild(title);
      const meta = document.createElement('span');
      meta.className = 'route-card-meta';
      meta.textContent = [r.gym_name, r.wall].filter(Boolean).join(' · ');
      cardBody.append(top, meta);
      const grade = document.createElement('span');
      grade.className = 'route-card-grade';
      grade.textContent = r.grade;
      btn.append(tape, cardBody, grade);
      btn.addEventListener('click', async () => {
        try {
          await api.linkPhoto(r.id, photo.id);
          overlay.remove();
          toast(`Added to ${routeTitle(r)}.`);
          void renderPhotoDetail(photo.id);
        } catch (err) {
          fail(err);
        }
      });
      list.appendChild(btn);
    }
    body.appendChild(list);
  });

  document.getElementById('photo-delete')!.addEventListener('click', async () => {
    const linked = routes.length > 0 ? ` It is linked to ${routes.length} route${routes.length === 1 ? '' : 's'} and any marked holds on it will be lost.` : '';
    if (!confirm(`Delete this photo from your gallery and all routes?${linked}`)) return;
    try {
      await api.deletePhoto(photo.id);
      purgePhotoUrls(photo.id);
      window.location.hash = '#/photos';
    } catch (err) {
      fail(err);
    }
  });
}

function setActiveGym(id: string | null): void {
  activeGymId = id;
  if (id) {
    localStorage.setItem(GYM_KEY, id);
  } else {
    localStorage.removeItem(GYM_KEY);
  }
}

async function loadGyms(): Promise<void> {
  gyms = (await api.listGyms()).gyms;
  if (!gyms.some((g) => g.id === activeGymId) && gyms.length > 0) {
    setActiveGym(gyms[0].id);
  }
}

// ---------- filters ----------

interface ListFilters {
  gym: string;
  discipline: string;
  status: string;
  sort: string;
}

const logFilters: ListFilters = { gym: 'all', discipline: 'all', status: 'all', sort: 'newest' };
const routeFilters: ListFilters = { gym: 'all', discipline: 'all', status: 'active', sort: 'recent' };

type Options = [string, string][];

function filterBar(f: ListFilters, statusOptions: Options, sortOptions: Options): string {
  const selects: [keyof ListFilters, Options][] = [
    ['gym', [['all', 'All gyms'], ...gyms.map((g): [string, string] => [g.id, g.name])]],
    ['discipline', [['all', 'All types'], ...(Object.entries(DISCIPLINE_LABELS) as Options)]],
    ['status', statusOptions],
    ['sort', sortOptions],
  ];
  return `<div class="filter-bar">
    ${selects
      .map(
        ([key, options]) => `<select data-f="${key}" aria-label="${key}">
          ${options
            .map(([value, label]) => `<option value="${esc(value)}" ${f[key] === value ? 'selected' : ''}>${esc(label)}</option>`)
            .join('')}
        </select>`
      )
      .join('')}
  </div>`;
}

function wireFilterBar(f: ListFilters, rerender: () => void): void {
  document.querySelectorAll<HTMLSelectElement>('.filter-bar select').forEach((sel) =>
    sel.addEventListener('change', () => {
      f[sel.dataset.f as keyof ListFilters] = sel.value;
      rerender();
    })
  );
}

// ---------- chrome ----------

function shell(content: string, nav: 'log' | 'routes' | 'photos' | 'gyms' | null): void {
  const navHtml =
    nav === null
      ? ''
      : `<nav class="bottomnav">
          <a href="#/" class="${nav === 'log' ? 'active' : ''}">
            <svg viewBox="0 0 24 24"><path d="M5 6 H19 M5 12 H19 M5 18 H12" stroke-linecap="round" stroke-linejoin="round"/></svg>
            Log
          </a>
          <a href="#/routes" class="${nav === 'routes' ? 'active' : ''}">
            <svg viewBox="0 0 24 24"><path d="M5 20 L12 4 L19 20" stroke-linecap="round" stroke-linejoin="round"/></svg>
            Routes
          </a>
          <a href="#/photos" class="${nav === 'photos' ? 'active' : ''}">
            <svg viewBox="0 0 24 24"><path d="M4 8 H8 L10 5 H14 L16 8 H20 V19 H4 Z M12 16 A3 3 0 1 0 12 10 A3 3 0 1 0 12 16" stroke-linecap="round" stroke-linejoin="round"/></svg>
            Photos
          </a>
          <a href="#/gyms" class="${nav === 'gyms' ? 'active' : ''}">
            <svg viewBox="0 0 24 24"><path d="M4 20 V10 L12 4 L20 10 V20 M4 14 H20" stroke-linecap="round" stroke-linejoin="round"/></svg>
            Gyms
          </a>
        </nav>`;
  appEl.innerHTML = `${content}${navHtml}`;
}

function header(sub: string): string {
  return `<header class="masthead">
    <h1>send<span>it</span></h1>
    <p class="masthead-sub">${esc(sub)}</p>
  </header>`;
}

// ---------- login ----------

function renderLogin(): void {
  shell(
    `<main class="auth">
      <div class="auth-mark">
        <h1>send<span>it</span></h1>
        <p>route tracking for people<br/>with unfinished business</p>
      </div>
      <form id="auth-form" autocomplete="on">
        <label>Username
          <input name="username" required minlength="3" autocapitalize="none" autocomplete="username" />
        </label>
        <label>Password
          <input name="password" type="password" required minlength="8" autocomplete="current-password" />
        </label>
        <div class="auth-actions">
          <button type="submit" class="btn primary" data-mode="login">Log in</button>
          <button type="submit" class="btn ghost" data-mode="register">Create account</button>
        </div>
      </form>
    </main>`,
    null
  );

  const form = document.getElementById('auth-form') as HTMLFormElement;
  let mode: 'login' | 'register' = 'login';
  form.querySelectorAll('button').forEach((btn) =>
    btn.addEventListener('click', () => {
      mode = btn.dataset.mode as typeof mode;
    })
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = new FormData(form);
    const username = String(data.get('username') ?? '');
    const password = String(data.get('password') ?? '');
    try {
      const result = mode === 'login' ? await api.login(username, password) : await api.register(username, password);
      setToken(result.token);
      await loadGyms();
      window.location.hash = gyms.length === 0 ? '#/gyms' : '#/';
    } catch (err) {
      fail(err);
    }
  });
}

// ---------- log (landing page) ----------

async function renderLog(): Promise<void> {
  let entries: LogEntry[];
  try {
    entries = (await api.listLog()).entries;
  } catch (err) {
    fail(err);
    return;
  }

  const f = logFilters;
  const visible = entries.filter((e) => {
    if (f.gym !== 'all' && e.gym_id !== f.gym) return false;
    if (f.discipline !== 'all' && e.route_discipline !== f.discipline) return false;
    if (f.status !== 'all' && e.result !== f.status) return false;
    return true;
  });

  if (f.sort === 'oldest') visible.reverse();
  if (f.sort === 'grade') visible.sort((a, b) => gradeRank(b.route_grade) - gradeRank(a.route_grade));

  const items = visible
    .map((e) => {
      const meta = [e.gym_name, DISCIPLINE_LABELS[e.route_discipline]].filter(Boolean).join(' · ');
      const detail = [e.high_point, e.notes].filter(Boolean).join(' — ');
      return `<a class="route-card log-entry" href="#/route/${esc(e.route_id)}">
        <span class="tape" style="background:${colorHex(e.route_color)}"></span>
        <span class="route-card-body">
          <span class="route-card-top">
            <strong>${esc(routeTitle({ name: e.route_name, color: e.route_color, grade: e.route_grade }))}</strong>
            <span class="attempt-result ${e.result === 'send' ? 'is-send' : ''}">${e.result === 'send' ? 'SENT' : 'attempt'}</span>
          </span>
          <span class="route-card-meta">${esc(meta)}</span>
          <span class="route-card-meta dim">${esc(e.attempted_on)} · ${esc(recency(e.attempted_on))}</span>
          ${detail ? `<span class="route-card-meta">${esc(detail)}</span>` : ''}
        </span>
        <span class="route-card-grade">${esc(e.route_grade)}</span>
      </a>`;
    })
    .join('');

  shell(
    `${header('climb log')}
    <main class="list">
      <a class="btn primary wide big-log" href="#/log/new">+ Log a climb</a>
      ${filterBar(
        f,
        [
          ['all', 'All results'],
          ['send', 'Sends'],
          ['attempt', 'Attempts'],
        ],
        [
          ['newest', 'Newest first'],
          ['oldest', 'Oldest first'],
          ['grade', 'By grade'],
        ]
      )}
      ${items || '<p class="empty">Nothing logged yet.</p>'}
    </main>`,
    'log'
  );

  wireFilterBar(f, () => void renderLog());
}

// ---------- log a climb ----------

// The flash checkbox only applies to sends; hide it when "Didn't send" is picked.
function wireFlashToggle(form: HTMLFormElement): void {
  const toggle = form.querySelector<HTMLElement>('.flash-toggle')!;
  const sync = () => {
    const sent = form.querySelector<HTMLInputElement>('input[name=result]:checked')?.value === 'send';
    toggle.classList.toggle('hidden', !sent);
  };
  form.querySelectorAll<HTMLInputElement>('input[name=result]').forEach((r) => r.addEventListener('change', sync));
  sync();
}

function flashedFromForm(data: FormData): number {
  return String(data.get('result')) === 'send' && data.get('flashed') !== null ? 1 : 0;
}

async function renderLogNew(): Promise<void> {
  if (gyms.length === 0) {
    window.location.hash = '#/gyms';
    return;
  }

  const NEW_ROUTE = '__new';
  let selectedGymId = gyms.some((g) => g.id === activeGymId) ? activeGymId! : gyms[0].id;

  const colorChips = Object.keys(NAMED_COLORS)
    .map(
      (name) =>
        `<button type="button" class="swatch" data-color="${name}"
          style="background:${NAMED_COLORS[name]}" aria-label="${name}"></button>`
    )
    .join('');

  shell(
    `<header class="masthead compact">
      <a class="back" href="#/">&larr;</a>
      <h2>Log a climb</h2>
    </header>
    <main class="form-page">
      <form id="log-form">
        <label>Gym
          <select name="gym">
            ${gyms
              .map((g) => `<option value="${esc(g.id)}" ${g.id === selectedGymId ? 'selected' : ''}>${esc(g.name)}</option>`)
              .join('')}
          </select>
        </label>
        <label>Route
          <select name="route"></select>
        </label>
        <div id="new-route-fields" class="hidden">
          <label>Discipline
            <select name="discipline">
              ${(Object.keys(DISCIPLINE_LABELS) as Discipline[])
                .map((d) => `<option value="${d}">${DISCIPLINE_LABELS[d]}</option>`)
                .join('')}
            </select>
          </label>
          <label>Color
            <div class="swatches">${colorChips}</div>
            <input type="hidden" name="color" />
          </label>
          <label>Grade
            <div class="chips" id="grade-chips"></div>
            <input name="grade" placeholder="V4, 5.11, comp tag…" />
          </label>
          <label>Wall / area
            <input name="wall" placeholder="Overhang, slab wall, cave…" />
          </label>
        </div>
        <div class="seg">
          <label><input type="radio" name="result" value="send" checked /><span>Sent</span></label>
          <label><input type="radio" name="result" value="attempt" /><span>Didn't send</span></label>
        </div>
        <label class="flash-toggle"><input type="checkbox" name="flashed" /><span>Flash <span class="hint">(sent it on the very first try)</span></span></label>
        <label>Date <input type="date" name="attempted_on" value="${todayStr()}" required /></label>
        <label>How far? <span class="hint">(if you didn't send)</span>
          <input name="high_point" placeholder="past the crux, 3rd clip, off the ground…" />
        </label>
        <label>Notes <textarea name="notes" rows="2" placeholder="what happened"></textarea></label>
        <button type="submit" class="btn primary wide">Log it</button>
      </form>
    </main>`,
    'log'
  );

  const form = document.getElementById('log-form') as HTMLFormElement;
  const gymSelect = form.querySelector<HTMLSelectElement>('select[name=gym]')!;
  const routeSelect = form.querySelector<HTMLSelectElement>('select[name=route]')!;
  const newRouteFields = document.getElementById('new-route-fields')!;
  const colorInput = form.querySelector<HTMLInputElement>('input[name=color]')!;
  const gradeInput = form.querySelector<HTMLInputElement>('input[name=grade]')!;
  const disciplineSelect = form.querySelector<HTMLSelectElement>('select[name=discipline]')!;

  form.querySelectorAll<HTMLButtonElement>('.swatch').forEach((btn) =>
    btn.addEventListener('click', () => {
      const wasActive = btn.classList.contains('active');
      form.querySelectorAll('.swatch').forEach((s) => s.classList.remove('active'));
      colorInput.value = wasActive ? '' : (btn.dataset.color ?? '');
      if (!wasActive) btn.classList.add('active');
    })
  );

  function renderGradeChips(): void {
    const grades = disciplineSelect.value === 'boulder' ? BOULDER_GRADES : ROPE_GRADES;
    const container = document.getElementById('grade-chips')!;
    container.textContent = '';
    for (const g of grades) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      chip.textContent = g;
      chip.addEventListener('click', () => {
        gradeInput.value = g;
      });
      container.appendChild(chip);
    }
  }
  renderGradeChips();
  disciplineSelect.addEventListener('change', renderGradeChips);

  function syncNewRouteFields(): void {
    newRouteFields.classList.toggle('hidden', routeSelect.value !== NEW_ROUTE);
  }

  async function loadRouteOptions(): Promise<void> {
    let routes: { id: string; name: string; color: string; grade: string; last_attempted_on: string | null }[] = [];
    try {
      routes = (await api.listRoutes(selectedGymId)).routes;
    } catch (err) {
      fail(err);
    }
    routes.sort((a, b) => (b.last_attempted_on ?? '').localeCompare(a.last_attempted_on ?? ''));
    routeSelect.textContent = '';
    for (const r of routes) {
      const opt = document.createElement('option');
      opt.value = r.id;
      opt.textContent = `${routeTitle(r)}${r.grade ? ` (${r.grade})` : ''}`;
      routeSelect.appendChild(opt);
    }
    const newOpt = document.createElement('option');
    newOpt.value = NEW_ROUTE;
    newOpt.textContent = '+ New route…';
    routeSelect.appendChild(newOpt);
    if (routes.length === 0) routeSelect.value = NEW_ROUTE;
    syncNewRouteFields();
  }

  gymSelect.addEventListener('change', () => {
    selectedGymId = gymSelect.value;
    setActiveGym(selectedGymId);
    void loadRouteOptions();
  });
  routeSelect.addEventListener('change', syncNewRouteFields);
  await loadRouteOptions();

  wireFlashToggle(form);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = new FormData(form);
    try {
      let routeId = String(data.get('route'));
      if (routeId === NEW_ROUTE) {
        const created = await api.createRoute(selectedGymId, {
          name: '',
          grade: String(data.get('grade') ?? ''),
          color: String(data.get('color') ?? ''),
          wall: String(data.get('wall') ?? ''),
          discipline: String(data.get('discipline')) as Discipline,
          notes: '',
        });
        routeId = created.route.id;
      }
      await api.createAttempt(routeId, {
        attempted_on: String(data.get('attempted_on')),
        result: String(data.get('result')) as 'send' | 'attempt',
        flashed: flashedFromForm(data),
        high_point: String(data.get('high_point') ?? ''),
        notes: String(data.get('notes') ?? ''),
      });
      toast(String(data.get('result')) === 'send' ? 'Nice. Logged the send.' : 'Logged. Next time.');
      window.location.hash = '#/';
    } catch (err) {
      fail(err);
    }
  });
}

// ---------- routes list ----------

async function renderRoutes(): Promise<void> {
  let routes: RouteWithGym[];
  try {
    routes = (await api.listAllRoutes(true)).routes;
  } catch (err) {
    fail(err);
    return;
  }

  const f = routeFilters;
  const visible = routes.filter((r) => {
    if (f.gym !== 'all' && r.gym_id !== f.gym) return false;
    if (f.discipline !== 'all' && r.discipline !== f.discipline) return false;
    if (f.status === 'archived') return r.archived === 1;
    if (r.archived === 1) return false;
    if (f.status === 'active') return true;
    return routeState(r) === f.status;
  });

  if (f.sort === 'recent') {
    visible.sort((a, b) => (b.last_attempted_on ?? '').localeCompare(a.last_attempted_on ?? ''));
  } else if (f.sort === 'grade') {
    visible.sort((a, b) => gradeRank(b.grade) - gradeRank(a.grade));
  }
  // 'newest' keeps the server's created_at DESC order.

  const cards = visible
    .map((r) => {
      const state = routeState(r);
      const meta = [r.gym_name, r.wall, DISCIPLINE_LABELS[r.discipline]].filter(Boolean).join(' · ');
      const last = r.last_attempted_on
        ? `${r.attempt_count} ${r.attempt_count === 1 ? 'try' : 'tries'} · last ${recency(r.last_attempted_on)}`
        : 'not tried yet';
      const thumb = r.first_photo_id
        ? `<span class="card-thumb"><img data-photo="${esc(r.first_photo_id)}" alt="" /></span>`
        : '';
      return `<a class="route-card" href="#/route/${esc(r.id)}">
        <span class="tape" style="background:${colorHex(r.color)}"></span>
        <span class="route-card-body">
          <span class="route-card-top">
            <strong>${esc(routeTitle(r))}</strong>
            <span class="state state-${state}">${STATE_LABELS[state]}</span>
          </span>
          <span class="route-card-meta">${esc(meta)}</span>
          <span class="route-card-meta dim">${esc(last)}</span>
        </span>
        ${thumb}
        <span class="route-card-grade">${esc(r.grade)}</span>
      </a>`;
    })
    .join('');

  const emptyCopy =
    f.status === 'archived'
      ? 'Nothing archived here.'
      : f.status === 'sent'
        ? 'No sends match. Get after it.'
        : f.status === 'project'
          ? 'Nothing in progress. Go fall off something.'
          : 'No routes match. Add what the setters put up.';

  shell(
    `${header('routes')}
    <main class="list">
      ${filterBar(
        f,
        [
          ['active', 'All active'],
          ['project', 'In progress'],
          ['new', 'Not tried'],
          ['sent', 'Sent'],
          ['archived', 'Archived'],
        ],
        [
          ['recent', 'Recent activity'],
          ['grade', 'By grade'],
          ['newest', 'Newest first'],
        ]
      )}
      ${cards || `<p class="empty">${emptyCopy}</p>`}
    </main>
    <a class="fab" href="#/new" aria-label="Add route">+</a>`,
    'routes'
  );

  hydratePhotos();
  wireFilterBar(f, () => void renderRoutes());
}

// ---------- route form ----------

async function renderRouteForm(routeId: string | null, linkPhotoId: string | null = null): Promise<void> {
  if (gyms.length === 0) {
    window.location.hash = '#/gyms';
    return;
  }

  let route: Route | null = null;
  if (routeId) {
    try {
      route = (await api.getRoute(routeId)).route;
    } catch (err) {
      fail(err);
      return;
    }
  }

  const selectedGymId = route?.gym_id ?? (gyms.some((g) => g.id === activeGymId) ? activeGymId! : gyms[0].id);

  const colorChips = Object.keys(NAMED_COLORS)
    .map(
      (name) =>
        `<button type="button" class="swatch ${route?.color === name ? 'active' : ''}" data-color="${name}"
          style="background:${NAMED_COLORS[name]}" aria-label="${name}"></button>`
    )
    .join('');

  shell(
    `<header class="masthead compact">
      <a class="back" href="${routeId ? `#/route/${esc(routeId)}` : '#/routes'}">&larr;</a>
      <h2>${routeId ? 'Edit route' : 'New route'}</h2>
    </header>
    <main class="form-page">
      <form id="route-form">
        <label>Gym
          <select name="gym_id">
            ${gyms
              .map((g) => `<option value="${esc(g.id)}" ${g.id === selectedGymId ? 'selected' : ''}>${esc(g.name)}</option>`)
              .join('')}
          </select>
        </label>
        <label>Discipline
          <select name="discipline">
            ${(Object.keys(DISCIPLINE_LABELS) as Discipline[])
              .map(
                (d) =>
                  `<option value="${d}" ${route?.discipline === d ? 'selected' : ''}>${DISCIPLINE_LABELS[d]}</option>`
              )
              .join('')}
          </select>
        </label>
        <label>Color
          <div class="swatches">${colorChips}</div>
          <input type="hidden" name="color" value="${esc(route?.color ?? '')}" />
        </label>
        <label>Grade
          <div class="chips" id="grade-chips"></div>
          <input name="grade" placeholder="V4, 5.11, comp tag…" value="${esc(route?.grade ?? '')}" />
        </label>
        <label>Wall / area
          <input name="wall" placeholder="Overhang, slab wall, cave…" value="${esc(route?.wall ?? '')}" />
        </label>
        <label>Name <span class="hint">(optional — we'll make one up if you don't)</span>
          <input name="name" value="${esc(route?.name ?? '')}" />
        </label>
        <label>Notes
          <textarea name="notes" rows="3" placeholder="Beta, crux, fear level…">${esc(route?.notes ?? '')}</textarea>
        </label>
        <button type="submit" class="btn primary wide">${routeId ? 'Save changes' : 'Add route'}</button>
      </form>
    </main>`,
    'routes'
  );

  const form = document.getElementById('route-form') as HTMLFormElement;
  const colorInput = form.querySelector<HTMLInputElement>('input[name=color]')!;
  const gradeInput = form.querySelector<HTMLInputElement>('input[name=grade]')!;

  form.querySelectorAll<HTMLButtonElement>('.swatch').forEach((btn) =>
    btn.addEventListener('click', () => {
      const wasActive = btn.classList.contains('active');
      form.querySelectorAll('.swatch').forEach((s) => s.classList.remove('active'));
      colorInput.value = wasActive ? '' : (btn.dataset.color ?? '');
      if (!wasActive) btn.classList.add('active');
    })
  );

  const disciplineSelect = form.querySelector<HTMLSelectElement>('select[name=discipline]')!;

  function renderGradeChips(): void {
    const grades = disciplineSelect.value === 'boulder' ? BOULDER_GRADES : ROPE_GRADES;
    const container = document.getElementById('grade-chips')!;
    container.textContent = '';
    for (const g of grades) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      chip.textContent = g;
      chip.addEventListener('click', () => {
        gradeInput.value = g;
      });
      container.appendChild(chip);
    }
  }
  renderGradeChips();
  disciplineSelect.addEventListener('change', renderGradeChips);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = new FormData(form);
    const gymId = String(data.get('gym_id'));
    const fields = {
      name: String(data.get('name') ?? ''),
      grade: String(data.get('grade') ?? ''),
      color: String(data.get('color') ?? ''),
      wall: String(data.get('wall') ?? ''),
      discipline: String(data.get('discipline')) as Discipline,
      notes: String(data.get('notes') ?? ''),
    };
    try {
      if (routeId) {
        await api.updateRoute(routeId, { ...fields, gym_id: gymId });
        window.location.hash = `#/route/${routeId}`;
      } else {
        const created = await api.createRoute(gymId, fields);
        if (linkPhotoId) {
          await api.linkPhoto(created.route.id, linkPhotoId).catch(() => toast('Route created, but the photo could not be linked.'));
        }
        window.location.hash = `#/route/${created.route.id}`;
      }
    } catch (err) {
      fail(err);
    }
  });
}

// ---------- route detail ----------

async function renderRouteDetail(routeId: string): Promise<void> {
  let route: Route;
  let attempts: Attempt[];
  let photos: Photo[];
  let routeImage: RouteImage | null;
  try {
    ({ route, attempts, photos, route_image: routeImage } = await api.getRoute(routeId));
  } catch (err) {
    fail(err);
    window.location.hash = '#/routes';
    return;
  }

  const sent = attempts.some((a) => a.result === 'send');
  // The flashed flag only counts on the chronologically first attempt (the list is newest-first).
  const firstAttempt = attempts[attempts.length - 1];
  const flashed = attempts.length > 0 && firstAttempt.result === 'send' && firstAttempt.flashed === 1;
  const stateLabel = sent ? (flashed ? 'flashed' : 'sent') : attempts.length > 0 ? 'in progress' : 'not tried';
  const gymName = gyms.find((g) => g.id === route.gym_id)?.name ?? '';

  const history = attempts
    .map((a, i) => {
      const canFlash = i === attempts.length - 1 && a.result === 'send';
      const isFlash = canFlash && a.flashed === 1;
      const detail = [a.high_point, a.notes].filter(Boolean).join(' — ');
      return `<li class="attempt ${a.result}">
        <div class="attempt-line">
          <span class="attempt-result">${isFlash ? 'FLASH' : a.result === 'send' ? 'SENT' : 'attempt'}</span>
          <span class="attempt-date">${esc(a.attempted_on)}</span>
          ${
            canFlash
              ? `<button class="linkish flash-chip ${isFlash ? 'on' : ''}" data-flash-attempt="${esc(a.id)}"
                  data-flashed="${a.flashed}" aria-pressed="${isFlash}">flash</button>`
              : ''
          }
          <button class="linkish" data-del-attempt="${esc(a.id)}" aria-label="Delete entry">&times;</button>
        </div>
        ${detail ? `<p class="attempt-detail">${esc(detail)}</p>` : ''}
      </li>`;
    })
    .join('');

  const meta = [gymName, route.wall, DISCIPLINE_LABELS[route.discipline]].filter(Boolean).join(' · ');

  shell(
    `<header class="masthead compact">
      <a class="back" href="#/routes">&larr;</a>
      <h2>${esc(routeTitle(route))}</h2>
      <a class="edit-link" href="#/route/${esc(route.id)}/edit">Edit</a>
    </header>
    <main class="detail">
      <section class="route-hero" style="--route-color:${colorHex(route.color)}">
        <span class="tape tall"></span>
        <div>
          <div class="route-hero-grade">${esc(route.grade || '—')}</div>
          <div class="route-hero-meta">${esc(meta)}</div>
          <span class="state state-${sent ? 'sent' : attempts.length ? 'project' : 'new'}">${stateLabel}</span>
          ${route.archived ? '<span class="state state-archived">archived</span>' : ''}
        </div>
      </section>
      <section class="photos">
        <div class="photo-strip">
          ${photos
            .map(
              (p) =>
                `<button type="button" class="photo-thumb" data-photo-open="${esc(p.id)}">
                  ${photoImg(p, 'Route photo')}
                </button>`
            )
            .join('')}
          <button type="button" class="photo-add" id="photo-add-btn" aria-label="Add photo">
            <span class="photo-add-plus">+</span>
            <span class="photo-add-label">photo</span>
          </button>
          <input type="file" accept="image/*" capture="environment" hidden id="photo-add-input" />
        </div>
      </section>
      <section class="route-image">
        <div class="section-head">
          <h3>Route image</h3>
          ${
            routeImage
              ? `<span class="section-actions">
                  <button class="linkish" id="ri-edit">Edit</button>
                  <button class="linkish danger" id="ri-remove">Remove</button>
                </span>`
              : ''
          }
        </div>
        ${routeImage ? '<div id="ri-view"></div>' : '<button class="annot-create" id="ri-create">Create route image</button>'}
      </section>
      ${route.notes ? `<section class="route-notes"><h3>Notes</h3><p>${esc(route.notes)}</p></section>` : ''}
      <section class="log-actions" style="--route-color:${colorHex(route.color)}">
        <button class="btn send-btn" id="attempt-btn">Log attempt</button>
      </section>
      <form id="attempt-form" class="attempt-form hidden">
        <div class="seg">
          <label><input type="radio" name="result" value="attempt" checked /><span>Didn't send</span></label>
          <label><input type="radio" name="result" value="send" /><span>Sent</span></label>
        </div>
        <label class="flash-toggle hidden"><input type="checkbox" name="flashed" /><span>Flash <span class="hint">(sent it on the very first try)</span></span></label>
        <label>Date <input type="date" name="attempted_on" value="${todayStr()}" required /></label>
        <label>How far? <input name="high_point" placeholder="past the crux, 3rd clip, off the ground…" /></label>
        <label>Notes <textarea name="notes" rows="2" placeholder="what happened"></textarea></label>
        <button type="submit" class="btn primary wide">Log it</button>
      </form>
      <section class="history">
        <h3>History</h3>
        ${history ? `<ul>${history}</ul>` : '<p class="empty">Nothing logged yet.</p>'}
      </section>
      <section class="danger-zone">
        <button class="linkish" id="archive-btn">${route.archived ? 'Unarchive route' : 'Archive route (wall got reset)'}</button>
        <button class="linkish danger" id="delete-btn">Delete route and history</button>
      </section>
    </main>`,
    'routes'
  );

  const rerender = () => void renderRouteDetail(route.id);
  const photoVersion = (photoId: string) => photos.find((p) => p.id === photoId)?.updated_at ?? 0;
  const editImage = (photoId: string, initial: RouteMarker[]) =>
    openRouteImageEditor(route.id, photoId, photoVersion(photoId), initial, route.color, rerender);

  if (routeImage) {
    const image = routeImage;
    const view = document.getElementById('ri-view')!;
    const { wrap } = annotatedImage(image.photo_id, photoVersion(image.photo_id), () => image.markers, route.color, { focus: true });
    wrap.addEventListener('click', () => openRouteImageViewer(image, photoVersion(image.photo_id), route.color));
    view.appendChild(wrap);
    document.getElementById('ri-edit')!.addEventListener('click', () => editImage(image.photo_id, image.markers));
    document.getElementById('ri-remove')!.addEventListener('click', async () => {
      if (!confirm('Remove the route image? The photo itself stays.')) return;
      try {
        await api.deleteRouteImage(route.id);
        rerender();
      } catch (err) {
        fail(err);
      }
    });
  } else {
    document.getElementById('ri-create')!.addEventListener('click', () => {
      if (photos.length === 0) {
        toast('Add a photo first, then mark the holds.');
      } else if (photos.length === 1) {
        editImage(photos[0].id, []);
      } else {
        openRouteImagePicker(photos, (photo) => editImage(photo.id, []));
      }
    });
  }

  hydratePhotos();

  document.querySelectorAll<HTMLButtonElement>('[data-photo-open]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const photo = photos.find((p) => p.id === btn.dataset.photoOpen);
      if (photo) openLightbox(photo, route.id, rerender);
    })
  );

  const photoInput = document.getElementById('photo-add-input') as HTMLInputElement;
  photoInput.addEventListener('change', async () => {
    const file = photoInput.files?.[0];
    if (!file) return;
    photoInput.disabled = true;
    toast('Uploading photo…');
    try {
      const blob = await preparePhoto(file);
      await api.uploadRoutePhoto(route.id, blob);
      rerender();
    } catch (err) {
      photoInput.disabled = false;
      photoInput.value = '';
      fail(err);
    }
  });

  document.getElementById('photo-add-btn')!.addEventListener('click', () => {
    const sheet = document.createElement('div');
    sheet.className = 'sheet';
    sheet.innerHTML = `
      <div class="sheet-body">
        <button class="btn primary wide" data-act="upload">Take or upload photo</button>
        <button class="btn ghost wide" data-act="gallery">Choose from gallery</button>
        <button class="linkish" data-act="cancel">Cancel</button>
      </div>`;
    document.body.appendChild(sheet);
    sheet.addEventListener('click', async (e) => {
      const act = (e.target as HTMLElement).dataset?.act;
      if (e.target === sheet || act === 'cancel') {
        sheet.remove();
        return;
      }
      if (act === 'upload') {
        sheet.remove();
        photoInput.click();
      } else if (act === 'gallery') {
        sheet.remove();
        try {
          const all = (await api.listGalleryPhotos(null)).photos;
          const linked = new Set(photos.map((p) => p.id));
          // Same gym or untagged, and not already on this route.
          const candidates = all.filter((p) => !linked.has(p.id) && (!p.gym_id || p.gym_id === route.gym_id));
          if (candidates.length === 0) {
            toast('No gallery photos for this gym yet.');
            return;
          }
          openRouteImagePicker(candidates, async (photo) => {
            try {
              await api.linkPhoto(route.id, photo.id);
              rerender();
            } catch (err) {
              fail(err);
            }
          });
        } catch (err) {
          fail(err);
        }
      }
    });
  });

  const attemptForm = document.getElementById('attempt-form') as HTMLFormElement;
  document.getElementById('attempt-btn')!.addEventListener('click', () => {
    attemptForm.classList.toggle('hidden');
  });

  wireFlashToggle(attemptForm);

  attemptForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = new FormData(attemptForm);
    try {
      await api.createAttempt(route.id, {
        attempted_on: String(data.get('attempted_on')),
        result: String(data.get('result')) as 'send' | 'attempt',
        flashed: flashedFromForm(data),
        high_point: String(data.get('high_point') ?? ''),
        notes: String(data.get('notes') ?? ''),
      });
      void renderRouteDetail(route.id);
    } catch (err) {
      fail(err);
    }
  });

  document.querySelectorAll<HTMLButtonElement>('[data-flash-attempt]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      try {
        await api.updateAttempt(btn.dataset.flashAttempt!, { flashed: btn.dataset.flashed === '1' ? 0 : 1 });
        void renderRouteDetail(route.id);
      } catch (err) {
        fail(err);
      }
    })
  );

  document.querySelectorAll<HTMLButtonElement>('[data-del-attempt]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this log entry?')) return;
      try {
        await api.deleteAttempt(btn.dataset.delAttempt!);
        void renderRouteDetail(route.id);
      } catch (err) {
        fail(err);
      }
    })
  );

  document.getElementById('archive-btn')!.addEventListener('click', async () => {
    try {
      await api.updateRoute(route.id, { archived: route.archived ? 0 : 1 });
      window.location.hash = '#/routes';
    } catch (err) {
      fail(err);
    }
  });

  document.getElementById('delete-btn')!.addEventListener('click', async () => {
    if (!confirm('Delete this route and all its history? Archiving is usually what you want.')) return;
    try {
      await api.deleteRoute(route.id);
      window.location.hash = '#/routes';
    } catch (err) {
      fail(err);
    }
  });
}

// ---------- gyms ----------

async function renderGyms(): Promise<void> {
  try {
    gyms = (await api.listGyms()).gyms;
  } catch (err) {
    fail(err);
    return;
  }

  const items = gyms
    .map(
      (g) => `<li class="gym ${g.id === activeGymId ? 'active' : ''}">
        <button class="gym-pick" data-gym="${esc(g.id)}">
          <strong>${esc(g.name)}</strong>
          ${g.id === activeGymId ? '<span class="state state-sent">default</span>' : ''}
        </button>
        <button class="linkish" data-rename="${esc(g.id)}">rename</button>
      </li>`
    )
    .join('');

  shell(
    `${header('gyms')}
    <main class="list">
      ${gyms.length === 0 ? '<p class="empty">Add your gym to start tracking routes.</p>' : `<ul class="gyms">${items}</ul>`}
      <form id="gym-form" class="inline-form">
        <input name="name" placeholder="Gym name" required maxlength="120" />
        <button type="submit" class="btn primary">Add</button>
      </form>
      <button class="linkish logout" id="logout">Log out</button>
    </main>`,
    'gyms'
  );

  document.querySelectorAll<HTMLButtonElement>('[data-gym]').forEach((btn) =>
    btn.addEventListener('click', () => {
      setActiveGym(btn.dataset.gym!);
      routeFilters.gym = btn.dataset.gym!;
      window.location.hash = '#/routes';
    })
  );

  document.querySelectorAll<HTMLButtonElement>('[data-rename]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const gym = gyms.find((g) => g.id === btn.dataset.rename);
      const name = prompt('Rename gym', gym?.name ?? '');
      if (!name?.trim()) return;
      try {
        await api.updateGym(btn.dataset.rename!, { name: name.trim() });
        void renderGyms();
      } catch (err) {
        fail(err);
      }
    })
  );

  (document.getElementById('gym-form') as HTMLFormElement).addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = document.querySelector<HTMLInputElement>('#gym-form input[name=name]')!;
    try {
      const created = await api.createGym(input.value.trim());
      setActiveGym(created.gym.id);
      await loadGyms();
      window.location.hash = '#/routes';
    } catch (err) {
      fail(err);
    }
  });

  document.getElementById('logout')!.addEventListener('click', () => {
    setToken(null);
    setActiveGym(null);
    window.location.hash = '#/login';
  });
}

// ---------- router ----------

async function route(): Promise<void> {
  const hash = window.location.hash || '#/';

  if (!getToken()) {
    if (hash !== '#/login') {
      window.location.hash = '#/login';
      return;
    }
    renderLogin();
    return;
  }

  if (hash === '#/login') {
    window.location.hash = '#/';
    return;
  }

  if (gyms.length === 0) {
    try {
      await loadGyms();
    } catch {
      // token was stale; the 401 handler already redirected to #/login
      return;
    }
  }

  const detailMatch = hash.match(/^#\/route\/([\w-]+)$/);
  const editMatch = hash.match(/^#\/route\/([\w-]+)\/edit$/);
  const photoMatch = hash.match(/^#\/photo\/([\w-]+)$/);
  const newMatch = hash.match(/^#\/new(?:\?(.*))?$/);

  if (hash === '#/') {
    await renderLog();
  } else if (hash === '#/log/new') {
    await renderLogNew();
  } else if (hash === '#/routes') {
    await renderRoutes();
  } else if (newMatch) {
    await renderRouteForm(null, new URLSearchParams(newMatch[1] ?? '').get('photo'));
  } else if (editMatch) {
    await renderRouteForm(editMatch[1]);
  } else if (detailMatch) {
    await renderRouteDetail(detailMatch[1]);
  } else if (hash === '#/photos') {
    await renderGallery();
  } else if (photoMatch) {
    await renderPhotoDetail(photoMatch[1]);
  } else if (hash === '#/gyms') {
    await renderGyms();
  } else {
    window.location.hash = '#/';
  }
}

window.addEventListener('hashchange', () => void route());
void route();
