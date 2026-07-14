# Hold shapes: segmentation-based auto-detect

Supersedes the detection half of `2026-07-13-hold-detection-design.md`. Auto-detect now outlines each route-colored hold as its actual **shape** (a filled silhouette), instead of dropping a circle at the hold's center. The user's ask: "I want to visualize the shapes of the holds, not just see dots."

## Model

Switched from the detect-only YOLOv8n (boxes → circles) to **FastSAM-s** (YOLOv8-seg, class-agnostic "segment everything"), int8-quantized to **12.6MB** so it still ships as a Cloudflare static asset (`src/frontend/public/models/hold-seg.onnx`, under the 25 MiB limit). Verified running in onnxruntime-web/WASM (session ~0.2s, inference ~6s single-thread).

Why FastSAM over a dedicated holds-seg model: the only in-browser-viable holds-only seg checkpoint found (`yg-gulbi`, YOLO26n-seg, 512px) had far too low recall on a tall wall (2 purple holds vs. 16). Larger holds-seg models (dylmill8 medium) are 90MB+ ONNX — over the asset limit. FastSAM at 1024px has the recall; being class-agnostic is fine because we color-filter anyway.

## Pipeline (`src/frontend/detect.ts`)

1. Letterbox → 1024, infer → `output0 [1,37,N]` (box + 32 mask coeffs), `output1 [1,32,256,256]` protos.
2. Decode boxes (conf 0.25) + NMS.
3. **Color-filter boxes FIRST** — sample each box's central median color, keep only route-color matches. Decoding a mask is the expensive step, so this cuts it from ~165 boxes to ~16 before any mask work; inference cost is independent of hold count.
4. For each matched box: `sigmoid(coeffs · protos)` → threshold inside the box → Moore-neighbor contour trace → **Douglas-Peucker ring simplification** → normalized polygon.
5. Emit markers `{x, y, r, polygon}` (centroid + bounding radius for hit-testing, plus the outline).

**Gotcha that cost real time:** plain Douglas-Peucker collapses a *closed* contour to 2 points — start == end makes the baseline degenerate, so every perpendicular distance is 0. Fixed by splitting the ring at its farthest-from-start point and simplifying the two open halves (`simplifyRing`).

## Data model & rendering

`RouteMarker` gains an optional `polygon: [x,y][]` (normalized), validated in the API (3–80 points, each in [0,1]). Backward compatible: a manual tap still stores just `{x,y,r}` and renders as a circle; a marker with a polygon renders as a filled silhouette (translucent route-color fill + white casing stroke). Both coexist in one route image.

## UX

The editor's "✨ Auto-detect holds" shows a full-cover spinner ("Finding purple holds…") while it works — inference runs in a worker (`ort.env.wasm.proxy = true`) so the spinner animates instead of the page freezing. This directly fixes the earlier "it doesn't seem to do anything" (a 6s freeze that only added faint dots). Detected shapes append to the editor, skipping any that overlap an existing marker; tap a shape to remove it. Toast reports how many were outlined, or — when holds were found but none matched the color — says so.

## Known limits

int8 masks are slightly coarser than fp32; the 256-res prototypes make small holds blocky; adjacent hues (purple/blue) can bleed; a wall with two same-color routes yields both. The editor is the fix-up step. Retraining a nano holds-seg model at 1024 (documented in the model-hunt findings) is the path to better recall + smaller size if wanted.
