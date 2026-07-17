# Free-drawing annotations on route images

A toggleable drawing layer on a route's route image: freehand marker strokes with
adjustable color and width, plus tap-to-place text labels. Drawings live alongside
the existing hold markers and edit in the same editor.

## Scope

- Route images only (not gallery photos, not per route-photo link).
- Vector data stored in D1, not flattened raster overlays.
- No post-placement editing of strokes/labels (delete + redraw), no per-item
  opacity, no font choices.

## Data model

New `drawings` JSON column on `route_images` (migration, default `'[]'`). Items are
normalized to the image exactly like `RouteMarker`: x/y in [0,1], width/size as a
fraction of image width.

```ts
type DrawingItem =
  | { kind: 'stroke'; color: string; width: number; points: [number, number][] }
  | { kind: 'text'; color: string; size: number; x: number; y: number; text: string };
```

- `color` is a hex string (`/^#[0-9a-f]{6}$/i`); the editor offers a fixed palette
  but validation stays a regex.
- Caps: ≤ 200 items, ≤ 500 points per stroke (pointer points thinned by minimum
  distance before save), text ≤ 100 chars.

### Transform on re-crop

`transformMarkers` remaps markers through rotate-then-crop when the route image is
edited. Add `transformDrawings` in `src/markers.ts`: map every stroke point and
text anchor through the same math; drop strokes whose points all land outside the
crop, and labels whose anchor does.

## API

- `PUT /api/routes/:id/image` body gains optional `drawings: DrawingItem[]`
  (Zod-validated; omitted = `[]`).
- `queries.upsertRouteImage` writes the column; every read of `route_images`
  returns `drawings` (existing rows read back as `[]`).
- Full write-path round-trip test per repo convention — the allowlisted field map
  silently drops unknown fields.

## Editor

Tools added to `openRouteImageEditor`'s button row: **✏️ Draw** and **T Text**.
Modes are mutually exclusive with each other and with shape-tracing/preview.

### Draw mode

- `wireZoomAndTap` gains a draw-mode path: single-pointer drags capture a stroke
  (down starts, moves append normalized points, up commits); two-finger
  pinch/pan still zooms so fine detail can be drawn zoomed in.
- Live render as SVG `polyline`, round caps/joins, into the existing overlay SVG.
- Color swatch row (6–8 fixed colors). The existing size slider drives stroke
  width in draw mode; the preview dot shows current color + width.
- **↩ Undo** removes the last-added item (stroke or text).
- **Clear drawing** wipes the drawing layer after confirm (markers untouched).
- Eraser: a *tap* in draw mode (under the tap-slop threshold, so never confused
  with a stroke) hit-tests drawing items — nearest stroke segment or text box
  within a small radius — and deletes it.

### Text mode

Tap a spot → inline input in the footer; commit places the label at the tapped
point in the current color, size relative to image width, rendered as SVG
`<text>` with a thin white casing for legibility. Tapping an existing label in
text mode deletes it.

Save persists markers + drawings in one `PUT`, as today.

## Viewer

- The full-screen viewer gains a **Drawing** toggle, independent of **Outlines**.
  Default on when the route has any drawings; off-state kept for the session only.
- `drawDrawings(svg, items, w, h)` appends after the spotlight/outline layers so
  drawings render on top.
- **Download** includes the drawing layer iff the toggle is on (download already
  serializes current SVG state).
- Spotlit card thumbnails stay drawings-free.

## Testing

- Unit: `transformDrawings` remap/drop behavior next to `markers.test.ts`; Zod
  rejection cases (oversized strokes, bad colors, over-cap payloads).
- API: round-trip test — `PUT` markers + drawings, `GET` returns both intact.
- Manual/E2E with the `claude-test` account: draw strokes + a label, save, reopen
  the viewer, toggle the layer, reload, confirm persistence.
