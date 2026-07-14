# Photo gallery, image editing, and annotation zoom

Photos become a first-class user-level gallery instead of belonging to routes, because one wall photo contains many routes. Routes link to gallery photos; annotations (route images) are marker sets drawn over a shared photo. Adds crop/rotate editing with automatic marker remapping, and pinch/scroll zoom in the annotation editor.

## Data model (migration 0004)

- `photos`: user-owned, optional `gym_id` tag (auto-filled from the route on upload, editable later), revisioned `r2_key`, `updated_at` bumped on edit.
- `route_photo_links`: many-to-many route ↔ photo, 12 links per route.
- `route_images` unchanged in shape, rebuilt to reference `photos`. **Migration ordering matters:** `route_images` had `ON DELETE CASCADE` against `route_photos`, so it is rebuilt against `photos` *before* `route_photos` is dropped — dropping the parent first would cascade-delete every annotation.

Deleting a route no longer touches photo bytes. Unlinking (route page) is distinct from deleting everywhere (gallery page, confirms cascade).

## Editing

Pixels are transformed client-side (canvas: quarter-turn rotations + rect crop) and posted to `POST /api/photos/:id/edit?mode=overwrite|new` with the transform description (rotate, normalized crop rect, original dims).

- `new`: separate gallery photo, same gym tag; annotations untouched.
- `overwrite`: new `r2_key` (old object deleted), `updated_at` bump for cache busting (`/api/photos/:id?v=updated_at` + versioned client-side object-URL cache), and every annotation on the photo has its markers remapped through the same rotate-then-crop transform (`src/markers.ts`). Markers cropped out are dropped; an annotation losing all markers is deleted.

## UX

- **Photos tab** (4th nav item): grid + gym filter + upload; tiles badge their link count.
- **Photo page**: view (zoomable), gym tag, Edit image (crop rect with corner handles, rotate, Save / Save as copy, with a note when marked routes will be remapped), Create route from this photo (`#/new?photo=` links it after create), Delete everywhere.
- **Route page**: the + photo tile opens a sheet — take/upload (uploads and links, tagged with the route's gym) or choose from gallery (same-gym or untagged photos not already linked). Lightbox "Delete photo" became "Remove from route".
- **Annotation editor**: pinch (touch), scroll wheel (desktop), and drag-to-pan when zoomed, via a shared gesture helper that distinguishes taps by pointer-travel slop. Tap coordinates stay correct at any zoom because the SVG's client rect reflects the CSS transform.
