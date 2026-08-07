-- The external gyms the sync pulls, keyed by the slug in the gym's KAYA URL.
--
-- Additive only: ALTER TABLE ... ADD COLUMN, never a table rebuild. Rebuilding
-- routes or gyms here would cascade-delete attempts and route_images (see
-- test/migrations.test.mjs).

CREATE TABLE IF NOT EXISTS catalog_gyms (
  source TEXT NOT NULL,
  slug TEXT NOT NULL,
  -- Both filled in by the first successful sync; the app can't reach KAYA itself.
  source_gym_id TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ok', 'error')),
  error TEXT NOT NULL DEFAULT '',
  requested_at INTEGER NOT NULL,
  last_synced_at INTEGER,
  PRIMARY KEY (source, slug)
);

ALTER TABLE gym_catalog ADD COLUMN source_gym_slug TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_gym_catalog_slug ON gym_catalog(source, source_gym_slug, removed_at);

-- catalog_gym_id stays as provenance; nothing reads it to match a gym anymore.
ALTER TABLE gyms ADD COLUMN catalog_gym_slug TEXT NOT NULL DEFAULT '';

-- KAYA gym 211 is movementboulder, the only gym synced before this table.
UPDATE gym_catalog SET source_gym_slug = 'movementboulder'
  WHERE source = 'kaya' AND source_gym_id = '211' AND source_gym_slug = '';
UPDATE gyms SET catalog_gym_slug = 'movementboulder'
  WHERE catalog_source = 'kaya' AND catalog_gym_id = '211' AND catalog_gym_slug = '';
INSERT OR IGNORE INTO catalog_gyms (source, slug, source_gym_id, name, status, error, requested_at, last_synced_at)
  SELECT 'kaya', 'movementboulder', '211', MAX(source_gym_name), 'ok', '', MIN(first_seen_at), MAX(last_seen_at)
    FROM gym_catalog WHERE source = 'kaya' AND source_gym_id = '211';

-- KAYA writes grades lowercase ('v3'), the app's list is uppercase, so the two
-- never filtered as one grade. LIKE is case-insensitive, so this is idempotent.
UPDATE gym_catalog SET grade = 'V' || substr(grade, 2) WHERE grade LIKE 'v%';
UPDATE routes SET grade = 'V' || substr(grade, 2) WHERE grade LIKE 'v%';
