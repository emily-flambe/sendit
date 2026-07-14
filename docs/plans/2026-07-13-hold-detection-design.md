# In-browser hold detection

"Auto-detect holds" in the annotation editor: runs a climbing-hold detector on the photo, keeps the holds matching the route's color, and pre-fills them as markers the user edits. Fulfills the original dream — upload a wall photo, get the purple route marked automatically.

## Model

`yolov8n-freeclimbs-detect-2` (YOLOv8n fine-tuned on climbing holds, single "hold" class), exported to ONNX at 1024px imgsz → 12MB, committed at `src/frontend/public/models/holds.onnx` and served as a static asset from the app's own domain (Cloudflare edge-caches it). Under the 25 MiB per-asset limit.

## Runtime

`onnxruntime-web` runs the model in the browser via WASM. It is **not bundled**: its build references a 26MB WebGPU wasm through `new URL(...)` that Vite would emit into `dist/`, exceeding Cloudflare's 25 MiB asset limit. Instead the JS glue + wasm load from jsDelivr at runtime (`@vite-ignore` dynamic import of `ort.wasm.bundle.min.mjs`, pinned to 1.27.0), so only the 12MB model ships in `dist`. `onnxruntime-web` stays a devDependency for types. Single-threaded (`numThreads = 1`) to avoid the SharedArrayBuffer / cross-origin-isolation requirement Cloudflare's asset host doesn't satisfy. Lazy: nothing downloads until the first tap of Auto-detect; the session is cached for the page lifetime.

## Pipeline (`src/frontend/detect.ts`)

1. Letterbox the image into 1024×1024 (gray pad, preserve aspect), HWC→CHW float32 /255.
2. Inference → `(1, 5, N)`: 4 box coords + 1 score per anchor.
3. Threshold (conf 0.25) + NMS (IoU 0.45).
4. Map surviving boxes back to source pixels.
5. **Color filter**: per-channel median RGB of each box's central region → HSV, matched against the route color (derived from its hex). Chromatic colors match by hue proximity (±24°); white/black/gray match by brightness band. This is what turns "all holds" into "the purple route."
6. Emit normalized `{x, y, r}` markers.

## UX

Auto-detect appends matched holds to the editor, skipping any that land on an existing marker (re-running is idempotent), capped at the 100-marker API limit. Toast reports how many were added, or — when holds were found but none matched the color — says so and invites manual tapping. Manual tap/remove/zoom are unchanged; detection only seeds them.

## Known limits

Adjacent hues blur (purple vs. blue, orange vs. red); a wall with two same-color routes yields both (color can't separate them spatially). Both are expected — the editor is the fix-up step. First detection freezes the UI briefly during single-threaded inference; a worker/proxy backend is the future improvement.
