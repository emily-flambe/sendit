-- Migration number: 0002 	 2026-07-10
CREATE TABLE IF NOT EXISTS route_photos (
  id TEXT PRIMARY KEY,
  route_id TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (route_id) REFERENCES routes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_route_photos_route ON route_photos(route_id, created_at);
