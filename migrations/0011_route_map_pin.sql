-- Where a route sits on the gym's floor map, placed by hand.
-- Normalized to the image (0..1) like route_images.markers, so the pin survives
-- the map being displayed at any size. NULL means "not placed".
--
-- The maps themselves are per-gym image URLs; a gym with neither set shows no
-- map at all. KAYA exposes no coordinates, so nothing here is synced.
--
-- Additive only: ALTER TABLE ... ADD COLUMN, no table rebuild.

ALTER TABLE routes ADD COLUMN map_x REAL;
ALTER TABLE routes ADD COLUMN map_y REAL;

ALTER TABLE gyms ADD COLUMN map_boulder_url TEXT NOT NULL DEFAULT '';
ALTER TABLE gyms ADD COLUMN map_route_url TEXT NOT NULL DEFAULT '';
