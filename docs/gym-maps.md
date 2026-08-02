# Gym floor maps

A gym can carry a floor map per discipline, and each route can hold a hand-placed pin on it. This is entirely local to sendit — KAYA exposes no coordinates for climbs, so nothing here is synced or derived.

## How it works

`gyms.map_boulder_url` and `gyms.map_route_url` hold an image URL each. A gym with neither set shows no map anywhere, so this stays invisible for gyms that don't have one.

The routes list shows one map at a time, chosen by the Routes/Boulders pill toggle at the top of the page; the whole page follows that toggle, so you only ever see one discipline at once. Pins there can be dragged to reposition a route, or tapped to open it — a short movement threshold separates the two, and drags are tracked on the window rather than via pointer capture, which doesn't hold reliably for an 18px target.

The route form picks the map matching the route's discipline and lets you tap to place a pin, drawn in the route's colour. Changing the gym or the discipline clears the pin, since it no longer refers to the same picture. The route detail page shows the map read-only when a pin is set.

Pins are stored in `routes.map_x` / `routes.map_y`, normalized to the image (0..1) the same way `route_images.markers` are, so they survive the map being displayed at any size. `NULL` means unplaced.

## Movement Boulder's maps

`src/frontend/public/maps/bouldering.png` and `routes.png` ship with the app and are served at `/maps/*.png`. They came from screenshots of KAYA's in-app maps with the climb-count bubbles removed; the area labels are the gym's own names.

Point a gym at them with:

```bash
curl -X PATCH .../api/gyms/<gym-id> -H 'Authorization: Bearer <token>' \
  -d '{"map_boulder_url":"/maps/bouldering.png","map_route_url":"/maps/routes.png"}'
```

Note the bouldering map is drawn in **zones**, which are coarser than the wall names in the catalog: "The 45" covers A1–A3, "West Wall" covers B1–B3, "East Wall" covers A4–A5, and "The Cave" is B4. The routes map matches the catalog one-to-one.
