import type { RouteMarker } from './api';

// In-browser climbing-hold detection. A YOLOv8n model (single "hold" class),
// exported to ONNX, run via onnxruntime-web/WASM. Detects every hold on the
// wall, then keeps only those whose sampled color matches the route's color.
// Output feeds the annotation editor as pre-filled markers the user edits.

const MODEL_URL = '/models/holds.onnx';
const ORT_VERSION = '1.27.0';
const INPUT_SIZE = 1024; // must match the export imgsz
const CONF_THRESHOLD = 0.25;
const IOU_THRESHOLD = 0.45;

// onnxruntime-web (JS glue + WASM) is loaded from jsDelivr at runtime, pinned
// to the installed version, rather than bundled: its build references a 26MB
// WebGPU wasm via `new URL(...)` that Vite would emit into dist and that
// exceeds Cloudflare's 25MiB per-asset limit. `@vite-ignore` keeps the whole
// runtime out of our bundle — only the 12MB model ships in dist. onnxruntime-web
// stays a devDependency for types only. The wasm-only entry skips WebGL/WebGPU.
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
      // Single thread avoids the SharedArrayBuffer / cross-origin-isolation
      // requirement, which Cloudflare's asset host doesn't satisfy.
      ort.env.wasm.wasmPaths = ORT_BASE;
      ort.env.wasm.numThreads = 1;
      return ort.InferenceSession.create(MODEL_URL, { executionProviders: ['wasm'] });
    })();
  }
  return sessionPromise;
}

interface Box {
  cx: number;
  cy: number;
  w: number;
  h: number;
  score: number;
}

function decode(data: Float32Array, numBoxes: number): Box[] {
  const boxes: Box[] = [];
  for (let i = 0; i < numBoxes; i++) {
    const score = data[4 * numBoxes + i];
    if (score < CONF_THRESHOLD) continue;
    boxes.push({
      cx: data[i],
      cy: data[numBoxes + i],
      w: data[2 * numBoxes + i],
      h: data[3 * numBoxes + i],
      score,
    });
  }
  return boxes;
}

function iou(a: Box, b: Box): number {
  const ax1 = a.cx - a.w / 2;
  const ay1 = a.cy - a.h / 2;
  const ax2 = a.cx + a.w / 2;
  const ay2 = a.cy + a.h / 2;
  const bx1 = b.cx - b.w / 2;
  const by1 = b.cy - b.h / 2;
  const bx2 = b.cx + b.w / 2;
  const by2 = b.cy + b.h / 2;
  const ix = Math.max(0, Math.min(ax2, bx2) - Math.max(ax1, bx1));
  const iy = Math.max(0, Math.min(ay2, by2) - Math.max(ay1, by1));
  const inter = ix * iy;
  const union = a.w * a.h + b.w * b.h - inter;
  return union <= 0 ? 0 : inter / union;
}

function nms(boxes: Box[]): Box[] {
  const sorted = [...boxes].sort((a, b) => b.score - a.score);
  const kept: Box[] = [];
  for (const box of sorted) {
    if (kept.every((k) => iou(k, box) < IOU_THRESHOLD)) kept.push(box);
  }
  return kept;
}

interface Hsv {
  h: number; // 0-360
  s: number; // 0-1
  v: number; // 0-1
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
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) return { h: 0, s: 0, v: 0.5 };
  return rgbToHsv(parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16));
}

function hueDiff(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

// Does a sampled hold color belong to the target route color? The target is
// classified from its own saturation/value: achromatic targets (white/black/
// gray) match by brightness band, chromatic ones by hue proximity.
function colorMatches(target: Hsv, s: Hsv): boolean {
  if (target.s < 0.18) {
    if (target.v > 0.7) return s.v > 0.6 && s.s < 0.28; // white
    if (target.v < 0.35) return s.v < 0.3; // black
    return s.s < 0.28 && s.v >= 0.3 && s.v <= 0.78; // gray
  }
  if (s.s < 0.2 || s.v < 0.2) return false;
  return hueDiff(target.h, s.h) < 24;
}

// Per-channel median RGB of the box's central region, as HSV. The center
// avoids edge/shadow pixels; per-channel median resists specular highlights.
function sampleHsv(image: ImageData, cx: number, cy: number, w: number, h: number): Hsv | null {
  const rx = (w * 0.3) | 0;
  const ry = (h * 0.3) | 0;
  const x0 = Math.max(0, (cx | 0) - rx);
  const x1 = Math.min(image.width - 1, (cx | 0) + rx);
  const y0 = Math.max(0, (cy | 0) - ry);
  const y1 = Math.min(image.height - 1, (cy | 0) + ry);
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
  const median = (arr: number[]): number => {
    arr.sort((a, b) => a - b);
    return arr[arr.length >> 1];
  };
  return rgbToHsv(median(rs), median(gs), median(bs));
}

export interface DetectResult {
  markers: RouteMarker[];
  total: number; // holds detected before color filtering
}

// Detect holds on a decoded image and return markers for those matching the
// route color. Coordinates are normalized (x/y in [0,1], r as fraction of
// width) to match the annotation format.
export async function detectHolds(img: HTMLImageElement, targetHex: string): Promise<DetectResult> {
  const session = await loadSession();
  const ort = await loadOrt();

  const w = img.naturalWidth;
  const h = img.naturalHeight;

  // Full-resolution canvas for color sampling.
  const srcCanvas = document.createElement('canvas');
  srcCanvas.width = w;
  srcCanvas.height = h;
  const srcCtx = srcCanvas.getContext('2d', { willReadFrequently: true })!;
  srcCtx.drawImage(img, 0, 0);
  const srcData = srcCtx.getImageData(0, 0, w, h);

  // Letterbox into a square INPUT_SIZE canvas (gray padding, preserve aspect).
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

  // HWC bytes → CHW float32, normalized to [0,1].
  const plane = INPUT_SIZE * INPUT_SIZE;
  const chw = new Float32Array(3 * plane);
  for (let p = 0; p < plane; p++) {
    chw[p] = inData[p * 4] / 255;
    chw[plane + p] = inData[p * 4 + 1] / 255;
    chw[2 * plane + p] = inData[p * 4 + 2] / 255;
  }

  const input = new ort.Tensor('float32', chw, [1, 3, INPUT_SIZE, INPUT_SIZE]);
  const output = await session.run({ [session.inputNames[0]]: input });
  const result = output[session.outputNames[0]];
  const data = result.data as Float32Array;
  const numBoxes = result.dims[2]; // (1, 5, numBoxes)

  const kept = nms(decode(data, numBoxes));

  const markers: RouteMarker[] = [];
  const target = hexToHsv(targetHex);
  for (const box of kept) {
    // Letterbox space → source pixels.
    const sx = (box.cx - padX) / scale;
    const sy = (box.cy - padY) / scale;
    const sw = box.w / scale;
    const sh = box.h / scale;
    if (sx < 0 || sy < 0 || sx > w || sy > h) continue;

    const hsv = sampleHsv(srcData, sx, sy, sw, sh);
    if (!hsv || !colorMatches(target, hsv)) continue;

    const r = Math.min(0.08, Math.max(0.012, (0.5 * Math.max(sw, sh)) / w));
    markers.push({ x: sx / w, y: sy / h, r });
  }

  return { markers, total: kept.length };
}
