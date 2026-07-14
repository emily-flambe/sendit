import type { RouteMarker } from './api';

// In-browser climbing-hold SEGMENTATION. FastSAM-s (YOLOv8-seg, class-agnostic
// "segment everything"), int8-quantized to 12.6MB, run via onnxruntime-web/WASM.
// It masks every object on the wall; we keep the ones whose color matches the
// route and trace each into a polygon outline — so the route's holds render as
// their actual shapes, not dots. Output feeds the annotation editor.

const MODEL_URL = '/models/hold-seg.onnx';
const ORT_VERSION = '1.27.0';
const INPUT_SIZE = 1024; // must match the export imgsz
const CONF_THRESHOLD = 0.25;
const IOU_THRESHOLD = 0.6;
const MAX_HOLDS = 60; // safety cap on masks we bother decoding
const MAX_POLY_POINTS = 40;

// onnxruntime-web loads from jsDelivr at runtime (see the hold-detection design
// doc): its build references a 26MB WebGPU wasm that Vite would emit into dist
// and that exceeds Cloudflare's 25MiB asset limit. `@vite-ignore` keeps the
// whole runtime out of our bundle; only the model ships in dist. Types come
// from the devDependency.
const ORT_BASE = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;
const ORT_ENTRY = `${ORT_BASE}ort.wasm.bundle.min.mjs`;

type Ort = typeof import('onnxruntime-web');
let ortPromise: Promise<Ort> | null = null;
let sessionPromise: Promise<import('onnxruntime-web').InferenceSession> | null = null;

async function loadOrt(): Promise<Ort> {
  return (ortPromise ??= import(/* @vite-ignore */ ORT_ENTRY) as Promise<Ort>);
}

async function loadSession(): Promise<import('onnxruntime-web').InferenceSession> {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const ort = await loadOrt();
      ort.env.wasm.wasmPaths = ORT_BASE;
      ort.env.wasm.numThreads = 1;
      // Run inference in a worker so the ~6s doesn't freeze the editor and its
      // progress overlay keeps animating.
      ort.env.wasm.proxy = true;
      return ort.InferenceSession.create(MODEL_URL, { executionProviders: ['wasm'] });
    })();
  }
  return sessionPromise;
}

interface Det {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  score: number;
  coeffs: Float32Array; // 32 mask coefficients
}

// FastSAM output0 is (1, 37, N): rows are [cx, cy, w, h, conf, 32 coeffs] laid
// out channel-major, so value(channel, i) = data[channel * N + i].
function decodeBoxes(data: Float32Array, n: number): Det[] {
  const dets: Det[] = [];
  for (let i = 0; i < n; i++) {
    const score = data[4 * n + i];
    if (score < CONF_THRESHOLD) continue;
    const cx = data[i];
    const cy = data[n + i];
    const bw = data[2 * n + i];
    const bh = data[3 * n + i];
    const coeffs = new Float32Array(32);
    for (let k = 0; k < 32; k++) coeffs[k] = data[(5 + k) * n + i];
    dets.push({ x1: cx - bw / 2, y1: cy - bh / 2, x2: cx + bw / 2, y2: cy + bh / 2, score, coeffs });
  }
  return dets;
}

function boxIou(a: Det, b: Det): number {
  const ix = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1));
  const iy = Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
  const inter = ix * iy;
  const union = (a.x2 - a.x1) * (a.y2 - a.y1) + (b.x2 - b.x1) * (b.y2 - b.y1) - inter;
  return union <= 0 ? 0 : inter / union;
}

function nms(dets: Det[]): Det[] {
  const sorted = [...dets].sort((a, b) => b.score - a.score);
  const kept: Det[] = [];
  for (const d of sorted) {
    if (kept.every((k) => boxIou(k, d) < IOU_THRESHOLD)) kept.push(d);
  }
  return kept;
}

interface Hsv {
  h: number;
  s: number;
  v: number;
}

function rgbToHsv(r: number, g: number, b: number): Hsv {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

function hexToHsv(hex: string): Hsv {
  const m = hex.trim().match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) return { h: 0, s: 0, v: 0.5 };
  return rgbToHsv(parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16));
}

function hueDiff(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

function colorMatches(target: Hsv, s: Hsv): boolean {
  if (target.s < 0.18) {
    if (target.v > 0.7) return s.v > 0.6 && s.s < 0.28; // white
    if (target.v < 0.35) return s.v < 0.3; // black
    return s.s < 0.28 && s.v >= 0.3 && s.v <= 0.78; // gray
  }
  if (s.s < 0.2 || s.v < 0.2) return false;
  return hueDiff(target.h, s.h) < 26;
}

// Median HSV of a source-image region (per-channel median resists highlights).
function sampleHsv(image: ImageData, cx: number, cy: number, halfW: number, halfH: number): Hsv | null {
  const x0 = Math.max(0, Math.round(cx - halfW));
  const x1 = Math.min(image.width - 1, Math.round(cx + halfW));
  const y0 = Math.max(0, Math.round(cy - halfH));
  const y1 = Math.min(image.height - 1, Math.round(cy + halfH));
  if (x1 < x0 || y1 < y0) return null;
  const stepX = Math.max(1, ((x1 - x0) / 14) | 0);
  const stepY = Math.max(1, ((y1 - y0) / 14) | 0);
  const rs: number[] = [];
  const gs: number[] = [];
  const bs: number[] = [];
  for (let y = y0; y <= y1; y += stepY) {
    for (let x = x0; x <= x1; x += stepX) {
      const i = (y * image.width + x) * 4;
      rs.push(image.data[i]);
      gs.push(image.data[i + 1]);
      bs.push(image.data[i + 2]);
    }
  }
  if (rs.length === 0) return null;
  const med = (a: number[]): number => {
    a.sort((p, q) => p - q);
    return a[a.length >> 1];
  };
  return rgbToHsv(med(rs), med(gs), med(bs));
}

// sigmoid(coeffs · protos) for one detection → a proto-resolution mask.
function buildMask(coeffs: Float32Array, protos: Float32Array, protoSize: number): Float32Array {
  const plane = protoSize * protoSize;
  const mask = new Float32Array(plane);
  for (let k = 0; k < 32; k++) {
    const c = coeffs[k];
    if (c === 0) continue;
    const base = k * plane;
    for (let p = 0; p < plane; p++) mask[p] += c * protos[base + p];
  }
  for (let p = 0; p < plane; p++) mask[p] = 1 / (1 + Math.exp(-mask[p]));
  return mask;
}

// Moore-neighbor boundary trace of the largest blob touched from the first set
// pixel. Returns the outer contour as ordered [x,y] points in grid coordinates.
function traceContour(bin: Uint8Array, w: number, h: number): number[][] {
  let start = -1;
  for (let i = 0; i < bin.length; i++) {
    if (bin[i]) {
      start = i;
      break;
    }
  }
  if (start < 0) return [];
  const sx = start % w;
  const sy = (start / w) | 0;
  // 8-neighborhood, clockwise from east.
  const nbr = [
    [1, 0],
    [1, 1],
    [0, 1],
    [-1, 1],
    [-1, 0],
    [-1, -1],
    [0, -1],
    [1, -1],
  ];
  const at = (x: number, y: number): number => (x < 0 || y < 0 || x >= w || y >= h ? 0 : bin[y * w + x]);
  const contour: number[][] = [[sx, sy]];
  let cx = sx;
  let cy = sy;
  let dir = 6;
  const maxSteps = w * h * 2;
  for (let step = 0; step < maxSteps; step++) {
    let found = false;
    for (let k = 0; k < 8; k++) {
      const nd = (dir + k) % 8;
      const nx = cx + nbr[nd][0];
      const ny = cy + nbr[nd][1];
      if (at(nx, ny)) {
        cx = nx;
        cy = ny;
        contour.push([cx, cy]);
        dir = (nd + 6) % 8; // back up two steps (Moore)
        found = true;
        break;
      }
    }
    if (!found) break;
    if (cx === sx && cy === sy) break;
  }
  return contour;
}

// Perpendicular-distance polyline simplification (Douglas-Peucker).
function simplify(pts: number[][], epsilon: number): number[][] {
  if (pts.length < 3) return pts;
  let maxD = 0;
  let idx = 0;
  const [ax, ay] = pts[0];
  const [bx, by] = pts[pts.length - 1];
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy) || 1;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = Math.abs((pts[i][0] - ax) * dy - (pts[i][1] - ay) * dx) / len;
    if (d > maxD) {
      maxD = d;
      idx = i;
    }
  }
  if (maxD > epsilon) {
    const left = simplify(pts.slice(0, idx + 1), epsilon);
    const right = simplify(pts.slice(idx), epsilon);
    return left.slice(0, -1).concat(right);
  }
  return [pts[0], pts[pts.length - 1]];
}

// Douglas-Peucker for a CLOSED ring. Running plain DP on a closed contour
// collapses it (start == end makes the baseline degenerate, so every
// perpendicular distance is 0). Split at the point farthest from the start,
// simplify the two open halves, and rejoin.
function simplifyRing(pts: number[][], epsilon: number): number[][] {
  if (pts.length < 4) return pts;
  let far = 0;
  let fd = -1;
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i][0] - pts[0][0], pts[i][1] - pts[0][1]);
    if (d > fd) {
      fd = d;
      far = i;
    }
  }
  const a = simplify(pts.slice(0, far + 1), epsilon);
  const b = simplify(pts.slice(far), epsilon);
  return a.slice(0, -1).concat(b.slice(0, -1));
}

export interface DetectResult {
  markers: RouteMarker[];
  total: number; // objects detected before color filtering
}

// Detect and outline the route-colored holds. Markers carry a normalized
// polygon (x/y in [0,1]) plus a centroid + radius for hit-testing.
export async function detectHolds(img: HTMLImageElement, targetHex: string): Promise<DetectResult> {
  const session = await loadSession();
  const ort = await loadOrt();

  const w = img.naturalWidth;
  const h = img.naturalHeight;

  const srcCanvas = document.createElement('canvas');
  srcCanvas.width = w;
  srcCanvas.height = h;
  const srcCtx = srcCanvas.getContext('2d', { willReadFrequently: true })!;
  srcCtx.drawImage(img, 0, 0);
  const srcData = srcCtx.getImageData(0, 0, w, h);

  const scale = Math.min(INPUT_SIZE / w, INPUT_SIZE / h);
  const nw = Math.round(w * scale);
  const nh = Math.round(h * scale);
  const padX = (INPUT_SIZE - nw) / 2;
  const padY = (INPUT_SIZE - nh) / 2;
  const inCanvas = document.createElement('canvas');
  inCanvas.width = INPUT_SIZE;
  inCanvas.height = INPUT_SIZE;
  const inCtx = inCanvas.getContext('2d')!;
  inCtx.fillStyle = 'rgb(114,114,114)';
  inCtx.fillRect(0, 0, INPUT_SIZE, INPUT_SIZE);
  inCtx.drawImage(img, padX, padY, nw, nh);
  const inData = inCtx.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE).data;

  const plane = INPUT_SIZE * INPUT_SIZE;
  const chw = new Float32Array(3 * plane);
  for (let p = 0; p < plane; p++) {
    chw[p] = inData[p * 4] / 255;
    chw[plane + p] = inData[p * 4 + 1] / 255;
    chw[2 * plane + p] = inData[p * 4 + 2] / 255;
  }

  const input = new ort.Tensor('float32', chw, [1, 3, INPUT_SIZE, INPUT_SIZE]);
  const output = await session.run({ [session.inputNames[0]]: input });
  const out0 = output[session.outputNames[0]];
  const out1 = output[session.outputNames[1]];
  const nBoxes = out0.dims[2];
  const protoDim = out1.dims[2]; // 256
  const protoData = out1.data as Float32Array;

  const dets = nms(decodeBoxes(out0.data as Float32Array, nBoxes));

  const target = hexToHsv(targetHex);
  const toSrcX = (ix: number): number => (ix - padX) / scale;
  const toSrcY = (iy: number): number => (iy - padY) / scale;

  // Color-filter on boxes FIRST — decoding a mask per detection is the
  // expensive step, so only pay it for holds that match the route color.
  const matched = dets.filter((d) => {
    const cx = toSrcX((d.x1 + d.x2) / 2);
    const cy = toSrcY((d.y1 + d.y2) / 2);
    const hw = ((d.x2 - d.x1) / scale) * 0.3;
    const hh = ((d.y2 - d.y1) / scale) * 0.3;
    const hsv = sampleHsv(srcData, cx, cy, hw, hh);
    return hsv !== null && colorMatches(target, hsv);
  });

  const protoScale = protoDim / INPUT_SIZE; // 256/1024
  const markers: RouteMarker[] = [];

  for (const d of matched.slice(0, MAX_HOLDS)) {
    const mask = buildMask(d.coeffs, protoData, protoDim);
    const bx1 = Math.max(0, Math.floor(d.x1 * protoScale));
    const by1 = Math.max(0, Math.floor(d.y1 * protoScale));
    const bx2 = Math.min(protoDim - 1, Math.ceil(d.x2 * protoScale));
    const by2 = Math.min(protoDim - 1, Math.ceil(d.y2 * protoScale));
    const bin = new Uint8Array(protoDim * protoDim);
    for (let y = by1; y <= by2; y++) {
      for (let x = bx1; x <= bx2; x++) {
        if (mask[y * protoDim + x] > 0.5) bin[y * protoDim + x] = 1;
      }
    }
    const contour = traceContour(bin, protoDim, protoDim);
    if (contour.length < 3) continue;
    const eps = Math.max(1.5, contour.length * 0.01);
    const simplified = simplifyRing(contour, eps).slice(0, MAX_POLY_POINTS);
    if (simplified.length < 3) continue;

    // proto → input → source → normalized [0,1]
    const poly: [number, number][] = simplified.map(([px, py]) => {
      const nx = toSrcX(px / protoScale) / w;
      const ny = toSrcY(py / protoScale) / h;
      return [Math.min(1, Math.max(0, nx)), Math.min(1, Math.max(0, ny))];
    });

    let cxN = 0;
    let cyN = 0;
    for (const [px, py] of poly) {
      cxN += px;
      cyN += py;
    }
    cxN /= poly.length;
    cyN /= poly.length;
    let rN = 0;
    for (const [px, py] of poly) rN = Math.max(rN, Math.hypot(px - cxN, py - cyN));

    markers.push({ x: cxN, y: cyN, r: Math.min(0.12, Math.max(0.012, rN)), polygon: poly });
  }

  return { markers, total: dets.length };
}
