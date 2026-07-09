-- Migration number: 0001 	 2026-07-09
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
