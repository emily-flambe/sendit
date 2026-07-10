# Route photos

Take or upload photos of routes. Multiple photos per route; routes only (no attempt photos).

## Storage

- New R2 bucket `sendit-photos`, bound as `PHOTOS` in `wrangler.toml`. Objects keyed `photos/<routeId>/<photoId>`.
- New D1 table `route_photos` (migration 0002): `id`, `route_id` (FK → routes, cascade), `r2_key`, `content_type`, `size`, `created_at`. D1 row is the source of truth; R2 holds bytes only.

## API

All under the existing auth middleware; ownership enforced with the same route→gym→user join used everywhere else.

- `POST /api/routes/:id/photos` — raw image body (`Content-Type` must be image/jpeg, png, webp, or gif; 10 MB cap; 12 photos per route cap). Writes R2 first, then the D1 row. Returns the photo record.
- `GET /api/photos/:id` — streams the image with `Cache-Control: private, max-age=31536000, immutable` (photos are never mutated in place).
- `DELETE /api/photos/:id` — deletes the D1 row and the R2 object.
- `GET /api/routes/:id` — response gains a `photos` array.
- `DELETE /api/routes/:id` — also deletes the route's R2 objects (attempt cascade already handled by D1).
- `GET /api/gyms/:gymId/routes` — each route gains `photo_count` and `first_photo_id` for list thumbnails.

## Frontend

- Route detail: photo strip above Notes. "Add photo" uses `<input type="file" accept="image/*" capture="environment">` — on mobile this offers camera or library; on desktop it's a file picker. Images are downscaled client-side (canvas, max edge 1600 px, JPEG q0.85) before upload; if decoding fails and the original type is allowlisted, the original uploads as-is. Tap a thumbnail for a full-screen lightbox; delete from the lightbox.
- Route cards: first photo as a small thumbnail when present.
- Images require the Bearer token, so `<img src>` can't load them directly. A small loader fetches the blob with the auth header and sets an object URL, cached per session; the immutable cache header makes repeat fetches cheap.

## Testing

Workers-pool vitest as today (miniflare simulates R2 from the wrangler config). Cover: upload/list/fetch/delete round-trip, content-type and size rejection, per-route cap, cross-user 404s, and R2 cleanup on photo and route delete.

## Deploy

Create the `sendit-photos` bucket, apply migration 0002 remotely, `npm run deploy`.
