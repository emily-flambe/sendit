-- Migration number: 0004 	 2026-07-13
-- Photos become a user-level gallery; routes link to them. route_images is
-- rebuilt to reference photos BEFORE route_photos is dropped — dropping the
-- old parent first would cascade-delete every annotation.

CREATE TABLE IF NOT EXISTS photos (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  gym_id TEXT,
  r2_key TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (gym_id) REFERENCES gyms(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_photos_user ON photos(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_photos_gym ON photos(gym_id);

CREATE TABLE IF NOT EXISTS route_photo_links (
  route_id TEXT NOT NULL,
  photo_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (route_id, photo_id),
  FOREIGN KEY (route_id) REFERENCES routes(id) ON DELETE CASCADE,
  FOREIGN KEY (photo_id) REFERENCES photos(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_route_photo_links_photo ON route_photo_links(photo_id);

INSERT INTO photos (id, user_id, gym_id, r2_key, content_type, size, created_at, updated_at)
  SELECT p.id, g.user_id, r.gym_id, p.r2_key, p.content_type, p.size, p.created_at, p.created_at
  FROM route_photos p
  JOIN routes r ON r.id = p.route_id
  JOIN gyms g ON g.id = r.gym_id;

INSERT INTO route_photo_links (route_id, photo_id, created_at)
  SELECT route_id, id, created_at FROM route_photos;

CREATE TABLE route_images_new (
  route_id TEXT PRIMARY KEY,
  photo_id TEXT NOT NULL,
  markers TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (route_id) REFERENCES routes(id) ON DELETE CASCADE,
  FOREIGN KEY (photo_id) REFERENCES photos(id) ON DELETE CASCADE
);

INSERT INTO route_images_new SELECT route_id, photo_id, markers, updated_at FROM route_images;

DROP TABLE route_images;
ALTER TABLE route_images_new RENAME TO route_images;
CREATE INDEX IF NOT EXISTS idx_route_images_photo ON route_images(photo_id);

DROP TABLE route_photos;
