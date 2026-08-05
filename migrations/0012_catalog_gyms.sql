-- Registry of the external gyms whose catalogs we sync, so a second gym can be
-- added from the app instead of by editing the workflow. The nightly sync reads
-- its gym list from this table.
--
-- Slug, not KAYA's numeric id, is the identifier everywhere: it is the part of
-- the gym's KAYA URL a user can actually see and type, and it is known before
-- the first sync resolves anything else.
--
-- Additive only: ALTER TABLE ... ADD COLUMN, never a table rebuild. Rebuilding
-- routes or gyms here would cascade-delete attempts and route_images (see
-- test/migrations.test.mjs).

CREATE TABLE IF NOT EXISTS catalog_gyms (
  source TEXT NOT NULL,
  slug TEXT NOT NULL,
  -- Filled in by the first successful sync, which is also where the name comes
  -- from: the app can't reach KAYA itself (bot protection needs a browser).
  source_gym_id TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  -- 'pending' until a sync has run, then 'ok', or 'error' with why.
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ok', 'error')),
  error TEXT NOT NULL DEFAULT '',
  requested_at INTEGER NOT NULL,
  last_synced_at INTEGER,
  PRIMARY KEY (source, slug)
);

-- Which external gym each catalog row belongs to, by slug. Denormalized onto
-- the row so listing a gym's catalog stays a single indexed filter.
ALTER TABLE gym_catalog ADD COLUMN source_gym_slug TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_gym_catalog_slug ON gym_catalog(source, source_gym_slug, removed_at);

-- A gym's catalog pointer, by slug. catalog_gym_id stays as provenance but is
-- no longer what reads join on.
ALTER TABLE gyms ADD COLUMN catalog_gym_slug TEXT NOT NULL DEFAULT '';

-- Backfill the one gym that existed before this table: KAYA 211 is
-- movementboulder (scripts/kaya-sync.mjs logs the id on every run).
UPDATE gym_catalog SET source_gym_slug = 'movementboulder'
  WHERE source = 'kaya' AND source_gym_id = '211' AND source_gym_slug = '';
UPDATE gyms SET catalog_gym_slug = 'movementboulder'
  WHERE catalog_source = 'kaya' AND catalog_gym_id = '211' AND catalog_gym_slug = '';
INSERT OR IGNORE INTO catalog_gyms (source, slug, source_gym_id, name, status, error, requested_at, last_synced_at)
  SELECT 'kaya', 'movementboulder', '211', MAX(source_gym_name), 'ok', '', MIN(first_seen_at), MAX(last_seen_at)
    FROM gym_catalog WHERE source = 'kaya' AND source_gym_id = '211';

-- KAYA writes boulder grades lowercase ('v3', 'vB') while the app's own grade
-- list is uppercase, so an imported route and a hand-entered one never filtered
-- as the same grade. Normalize both sides. LIKE is case-insensitive for ASCII,
-- so re-running this is a no-op on already-uppercase grades.
UPDATE gym_catalog SET grade = 'V' || substr(grade, 2) WHERE grade LIKE 'v%';
UPDATE routes SET grade = 'V' || substr(grade, 2) WHERE grade LIKE 'v%';
