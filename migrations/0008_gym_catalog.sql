-- Catalog of climbs a gym currently has set, synced from an external platform.
-- Not user data: one row per climb, shared by every user whose gym points at
-- the same source. Users copy entries into their own `routes` to log on them.
--
-- Additive only: ALTER TABLE ... ADD COLUMN, never a table rebuild. Rebuilding
-- routes or gyms here would cascade-delete attempts and route_images (see
-- test/migrations.test.mjs).

CREATE TABLE IF NOT EXISTS gym_catalog (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  source_gym_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  slug TEXT NOT NULL DEFAULT '',
  grade TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '',
  wall TEXT NOT NULL DEFAULT '',
  discipline TEXT NOT NULL DEFAULT 'route' CHECK (discipline IN ('boulder', 'route')),
  rating REAL,
  ascent_count INTEGER NOT NULL DEFAULT 0,
  is_closed INTEGER NOT NULL DEFAULT 0,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  -- Set when a sync no longer sees the climb (stripped or reset). Kept rather
  -- than deleted so already-imported routes retain their provenance.
  removed_at INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_gym_catalog_external ON gym_catalog(source, external_id);
CREATE INDEX IF NOT EXISTS idx_gym_catalog_gym ON gym_catalog(source, source_gym_id, removed_at);

-- Which external gym a user's gym mirrors. Empty means "no catalog", which is
-- every gym until the user opts one in.
ALTER TABLE gyms ADD COLUMN catalog_source TEXT NOT NULL DEFAULT '';
ALTER TABLE gyms ADD COLUMN catalog_gym_id TEXT NOT NULL DEFAULT '';

-- Provenance for imported routes, so a re-import updates instead of duplicating.
ALTER TABLE routes ADD COLUMN source TEXT NOT NULL DEFAULT '';
ALTER TABLE routes ADD COLUMN source_external_id TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_routes_source ON routes(gym_id, source, source_external_id);
