# Route images (annotated topos)

Each route can have one **route image**: a photo of the wall with tap-placed circles marking the holds. Manual-first — no computer vision in v1 — but the data model is shaped so auto-detection can pre-fill markers later.

## Background

Prototyped three hold-detection approaches on a real gym wall photo (classical HSV thresholding, FastSAM segmentation + color clustering, and a pretrained YOLOv8 hold detector). All worked; the YOLOv8n checkpoint (7MB, ONNX-exportable, browser-runnable) is the likely v2 path. Every approach output the same shape — hold positions + sizes — which is exactly what the manual editor stores, so detection later just pre-populates the editor.

## Data model

One row per route in `route_images` (migration 0003): `route_id` (PK), `photo_id`, `markers` (JSON), `updated_at`. Both FKs cascade — deleting the photo or the route deletes the annotation.

Markers are an array of objects normalized to the image: `{x, y, r}` with x/y in [0,1] and r as a fraction of image width. Objects rather than tuples so future fields (`kind: "start"`, `source: "detected"`, `outline`) need no migration; readers ignore unknown keys.

## API

- `PUT /api/routes/:id/image` — `{photo_id, markers}`, upserts. Validates the photo belongs to the route; zod-validates markers (1–100, coords in range, r bounded).
- `DELETE /api/routes/:id/image` — removes the annotation, keeps the photo.
- `GET /api/routes/:id` — response includes `route_image` (or null).

The Worker never processes pixels; the annotated image is always rendered client-side (`<img>` + SVG overlay). No composited image is stored, so marker styling can evolve and old annotations pick it up.

## UX

Route detail gets a "Route image" section. Without one: a "Create route image" button → photo picker over the route's photos (straight to the editor if there's exactly one; toast prompting a photo upload if none). With one: the annotated image inline (tap for full-screen viewer) plus Edit / Remove.

The editor is a full-screen overlay: tap to add a circle (default r = 0.02, drawn in the route's color with a white casing), tap a circle to remove it, Save/Cancel. No drag, no resize, no marker roles in v1 — deliberately cut; the stored `r` and object-shaped markers keep the upgrade path open.

## v2 path (not built)

Export YOLOv8n hold weights to ONNX, run in-browser via onnxruntime-web, filter detections by the route's `color`, pre-fill the editor. The two-purple-routes problem (color alone can't isolate one route) is solved by the same tap-to-fix editor.
