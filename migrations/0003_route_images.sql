-- Migration number: 0003 	 2026-07-13
CREATE TABLE IF NOT EXISTS route_images (
  route_id TEXT PRIMARY KEY,
  photo_id TEXT NOT NULL,
  markers TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (route_id) REFERENCES routes(id) ON DELETE CASCADE,
  FOREIGN KEY (photo_id) REFERENCES route_photos(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_route_images_photo ON route_images(photo_id);
