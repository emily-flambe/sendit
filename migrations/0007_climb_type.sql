-- Migration number: 0007 	 2026-07-17
-- A route is just boulder or route; how a roped line was climbed (top rope /
-- lead / auto belay) is a property of the attempt, not the route. Add
-- attempts.climb_type and backfill it from each attempt's route's old
-- discipline so nothing is lost (a top_rope route's attempts become top_rope,
-- lead -> lead, autobelay -> autobelay). Boulders have no climb_type ('').
-- Then collapse routes.discipline to boulder|route.

ALTER TABLE attempts ADD COLUMN climb_type TEXT NOT NULL DEFAULT ''
  CHECK (climb_type IN ('', 'top_rope', 'lead', 'autobelay'));

UPDATE attempts
SET climb_type = (SELECT r.discipline FROM routes r WHERE r.id = attempts.route_id)
WHERE (SELECT r.discipline FROM routes r WHERE r.id = attempts.route_id)
      IN ('top_rope', 'lead', 'autobelay');

-- SQLite can't alter a CHECK constraint in place, so routes must be rebuilt.
-- attempts, route_images, and route_photo_links all reference routes(id) with
-- ON DELETE CASCADE, and `DROP TABLE routes` performs an implicit DELETE that
-- fires those cascades, deleting every child row. `defer_foreign_keys` does
-- NOT prevent this: it defers constraint *checking* to commit time but does not
-- suppress cascade *actions*. So stash the child rows first and restore them
-- after the swap. (An earlier version of this migration lost every attempt to
-- exactly this cascade.)
CREATE TABLE _bak_attempts AS SELECT * FROM attempts;
CREATE TABLE _bak_route_images AS SELECT * FROM route_images;
CREATE TABLE _bak_route_photo_links AS SELECT * FROM route_photo_links;

PRAGMA defer_foreign_keys = TRUE;

CREATE TABLE routes_new (
  id TEXT PRIMARY KEY,
  gym_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  grade TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '',
  wall TEXT NOT NULL DEFAULT '',
  discipline TEXT NOT NULL DEFAULT 'route' CHECK (discipline IN ('boulder', 'route')),
  notes TEXT NOT NULL DEFAULT '',
  archived INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (gym_id) REFERENCES gyms(id) ON DELETE CASCADE
);

INSERT INTO routes_new (id, gym_id, name, grade, color, wall, discipline, notes, archived, created_at, updated_at)
  SELECT id, gym_id, name, grade, color, wall,
         CASE discipline WHEN 'boulder' THEN 'boulder' ELSE 'route' END,
         notes, archived, created_at, updated_at
  FROM routes;

DROP TABLE routes;
ALTER TABLE routes_new RENAME TO routes;
CREATE INDEX IF NOT EXISTS idx_routes_gym ON routes(gym_id, archived);

-- Restore the child rows the cascade cleared. routes now exists with the same
-- ids, so the deferred foreign keys validate at commit.
INSERT INTO attempts SELECT * FROM _bak_attempts;
INSERT INTO route_images SELECT * FROM _bak_route_images;
INSERT INTO route_photo_links SELECT * FROM _bak_route_photo_links;

DROP TABLE _bak_attempts;
DROP TABLE _bak_route_images;
DROP TABLE _bak_route_photo_links;
