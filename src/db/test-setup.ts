import { beforeAll } from 'vitest';
import { env } from 'cloudflare:test';

// Mirrors migrations/0001_init.sql — the workers pool can't read migration
// files at runtime, so the schema is inlined here (same convention as the
// workout tracker).
const schema = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);

CREATE TABLE IF NOT EXISTS gyms (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  archived INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_gyms_user ON gyms(user_id, archived);

CREATE TABLE IF NOT EXISTS routes (
  id TEXT PRIMARY KEY,
  gym_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  grade TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '',
  wall TEXT NOT NULL DEFAULT '',
  discipline TEXT NOT NULL DEFAULT 'boulder' CHECK (discipline IN ('boulder', 'top_rope', 'lead', 'autobelay')),
  notes TEXT NOT NULL DEFAULT '',
  archived INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (gym_id) REFERENCES gyms(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_routes_gym ON routes(gym_id, archived);

CREATE TABLE IF NOT EXISTS attempts (
  id TEXT PRIMARY KEY,
  route_id TEXT NOT NULL,
  attempted_on TEXT NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('send', 'attempt')),
  high_point TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  FOREIGN KEY (route_id) REFERENCES routes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_attempts_route ON attempts(route_id, attempted_on DESC, created_at DESC);

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

CREATE TABLE IF NOT EXISTS route_images (
  route_id TEXT PRIMARY KEY,
  photo_id TEXT NOT NULL,
  markers TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (route_id) REFERENCES routes(id) ON DELETE CASCADE,
  FOREIGN KEY (photo_id) REFERENCES route_photos(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_route_images_photo ON route_images(photo_id);
`;

beforeAll(async () => {
  const statements = schema
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  for (const statement of statements) {
    await env.DB.prepare(statement).run();
  }
});
