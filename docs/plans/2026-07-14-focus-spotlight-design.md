# Focus spotlight for route images

## What this is

A route image should read as "this route, spotlit": the marked holds stay bright and
sharp, everything else on the wall is dimmed, blurred, and desaturated. The hold
shapes are the mask that defines where the spotlight falls. Users can define a
hold's actual shape by tracing it, not just tapping a dot.

Decisions made with the user (2026-07-14):

- **Live overlay, not a baked image.** The effect is rendered at view time from the
  stored markers; nothing new is persisted. A "download/share a flattened image"
  export is a possible follow-up.
- **Tap-to-trace polygons** for manual shapes, keeping single-tap circles as the
  fast path. Circles and polygons coexist in the mask.
- **Soft feathered edges** with a small dilation of each hold region, so holds sit
  fully inside the bright zone and imperfect traces still look intentional.
- **Spotlight shows on the finished route image** (detail card, viewer). The editor
  shows the plain photo + outlines, with a Preview toggle.
- **The final image has no outlines.** Outlines designate holds during editing;
  they are a separate layer, off by default on the finished image (the viewer has
  an "Outlines" toggle). Preview in the editor matches the final look.
- Stretch goal (separate PR): tap a hold and let the segmentation model trace its
  shape (point-prompted single-mask decode from the existing FastSAM session).

## Data model

None of this changes storage. A marker is already `{ x, y, r, polygon? }`,
normalized to [0,1]. A circle contributes a circular focus region; a polygon
contributes its outline. The focus mask is the union of all marker regions.

Hand-traced polygons reuse the same derivation as auto-detected ones
(`markerFromPolygon` in `src/markers.ts`): `x,y` = vertex centroid, `r` = max
vertex distance from the centroid, clamped to [0.012, 0.12].

## Rendering

All inside the existing single `<svg>` overlay in `.annot-wrap`, in natural-pixel
viewBox coordinates so it survives resize and zoom:

```
<defs>
  <filter id=dim>   feGaussianBlur + saturate matrix + linear brightness  </filter>
  <filter id=feather> feGaussianBlur </filter>
  <mask id=m>
    <rect white full-size/>                      ← dimmed everywhere…
    <g filter=feather fill=black stroke=black stroke-width=D>  ← …except holds
      <circle/> <polygon/> …
    </g>
  </mask>
</defs>
<image href={same blob URL as the img} filter=url(#dim) mask=url(#m)/>
<g> thin color rims per hold </g>
```

The black stroke on mask shapes is the dilation (uniform `D/2` in every
direction); the feather blur softens the edge. Filter params scale with the
image's natural width so the effect is resolution-independent. IDs are
per-instance (counter) since two annotated images can be on screen at once.

Known cosmetic tradeoff: feGaussianBlur fades the dim layer's outer few pixels,
letting the sharp base image peek through at the border. At the blur radii used
(~0.4% of width) it is not visible in practice.

## Editor interaction

- Default tap: add circle / remove hold under the tap (unchanged).
- **Draw shape**: enters trace mode. Each tap adds a vertex; vertices and the
  in-progress outline render live; tapping the first vertex (or Done, ≥3 points)
  closes the shape into a polygon marker. Undo removes the last vertex; Cancel
  exits without adding. Taps never delete markers while tracing.
- **Preview**: toggles the finished spotlight rendering inside the editor.
- Polygon point count is capped at the API's limit (80).
