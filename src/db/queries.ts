import type { Attempt, Gym, Route, RoutePhoto, RouteWithStats, User } from '../types';

interface UserRow extends User {
  password_hash: string;
}

// Every gym/route/attempt query is scoped by user_id so one user can never
// read or write another user's data, even with a guessed id.

export async function createUser(db: D1Database, username: string, passwordHash: string): Promise<User> {
  const user: UserRow = {
    id: crypto.randomUUID(),
    username,
    password_hash: passwordHash,
    created_at: Date.now(),
  };
  await db
    .prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)')
    .bind(user.id, user.username, user.password_hash, user.created_at)
    .run();
  return { id: user.id, username: user.username, created_at: user.created_at };
}

export async function getUserByUsername(db: D1Database, username: string): Promise<UserRow | null> {
  return db.prepare('SELECT * FROM users WHERE username = ?').bind(username).first<UserRow>();
}

export async function getUserById(db: D1Database, id: string): Promise<User | null> {
  return db.prepare('SELECT id, username, created_at FROM users WHERE id = ?').bind(id).first<User>();
}

export async function listGyms(db: D1Database, userId: string, includeArchived: boolean): Promise<Gym[]> {
  const sql = includeArchived
    ? 'SELECT * FROM gyms WHERE user_id = ? ORDER BY archived, name COLLATE NOCASE'
    : 'SELECT * FROM gyms WHERE user_id = ? AND archived = 0 ORDER BY name COLLATE NOCASE';
  const result = await db.prepare(sql).bind(userId).all<Gym>();
  return result.results;
}

export async function getGym(db: D1Database, userId: string, gymId: string): Promise<Gym | null> {
  return db.prepare('SELECT * FROM gyms WHERE id = ? AND user_id = ?').bind(gymId, userId).first<Gym>();
}

export async function createGym(db: D1Database, userId: string, name: string, notes: string): Promise<Gym> {
  const gym: Gym = {
    id: crypto.randomUUID(),
    user_id: userId,
    name,
    notes,
    archived: 0,
    created_at: Date.now(),
  };
  await db
    .prepare('INSERT INTO gyms (id, user_id, name, notes, archived, created_at) VALUES (?, ?, ?, ?, 0, ?)')
    .bind(gym.id, gym.user_id, gym.name, gym.notes, gym.created_at)
    .run();
  return gym;
}

export async function updateGym(
  db: D1Database,
  userId: string,
  gymId: string,
  fields: { name?: string; notes?: string; archived?: number }
): Promise<Gym | null> {
  const existing = await getGym(db, userId, gymId);
  if (!existing) return null;

  const next = { ...existing, ...fields };
  await db
    .prepare('UPDATE gyms SET name = ?, notes = ?, archived = ? WHERE id = ? AND user_id = ?')
    .bind(next.name, next.notes, next.archived, gymId, userId)
    .run();
  return next;
}

export async function listRoutes(
  db: D1Database,
  userId: string,
  gymId: string,
  includeArchived: boolean
): Promise<RouteWithStats[]> {
  const archivedClause = includeArchived ? '' : 'AND r.archived = 0';
  const result = await db
    .prepare(
      `SELECT r.*,
              COUNT(a.id) AS attempt_count,
              COALESCE(SUM(a.result = 'send'), 0) AS send_count,
              MAX(a.attempted_on) AS last_attempted_on,
              (SELECT COUNT(*) FROM route_photos p WHERE p.route_id = r.id) AS photo_count,
              (SELECT p.id FROM route_photos p WHERE p.route_id = r.id ORDER BY p.created_at LIMIT 1) AS first_photo_id
       FROM routes r
       JOIN gyms g ON g.id = r.gym_id
       LEFT JOIN attempts a ON a.route_id = r.id
       WHERE r.gym_id = ? AND g.user_id = ? ${archivedClause}
       GROUP BY r.id
       ORDER BY r.created_at DESC`
    )
    .bind(gymId, userId)
    .all<RouteWithStats>();
  return result.results;
}

export async function getRoute(db: D1Database, userId: string, routeId: string): Promise<Route | null> {
  return db
    .prepare(
      `SELECT r.* FROM routes r
       JOIN gyms g ON g.id = r.gym_id
       WHERE r.id = ? AND g.user_id = ?`
    )
    .bind(routeId, userId)
    .first<Route>();
}

export interface RouteInput {
  name: string;
  grade: string;
  color: string;
  wall: string;
  discipline: Route['discipline'];
  notes: string;
}

export async function createRoute(db: D1Database, gymId: string, input: RouteInput): Promise<Route> {
  const now = Date.now();
  const route: Route = {
    id: crypto.randomUUID(),
    gym_id: gymId,
    ...input,
    archived: 0,
    created_at: now,
    updated_at: now,
  };
  await db
    .prepare(
      `INSERT INTO routes (id, gym_id, name, grade, color, wall, discipline, notes, archived, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
    )
    .bind(
      route.id,
      route.gym_id,
      route.name,
      route.grade,
      route.color,
      route.wall,
      route.discipline,
      route.notes,
      route.created_at,
      route.updated_at
    )
    .run();
  return route;
}

export async function updateRoute(
  db: D1Database,
  userId: string,
  routeId: string,
  fields: Partial<RouteInput> & { archived?: number }
): Promise<Route | null> {
  const existing = await getRoute(db, userId, routeId);
  if (!existing) return null;

  const next = { ...existing, ...fields, updated_at: Date.now() };
  await db
    .prepare(
      `UPDATE routes
       SET name = ?, grade = ?, color = ?, wall = ?, discipline = ?, notes = ?, archived = ?, updated_at = ?
       WHERE id = ?`
    )
    .bind(
      next.name,
      next.grade,
      next.color,
      next.wall,
      next.discipline,
      next.notes,
      next.archived,
      next.updated_at,
      routeId
    )
    .run();
  return next;
}

export async function deleteRoute(db: D1Database, userId: string, routeId: string): Promise<boolean> {
  const existing = await getRoute(db, userId, routeId);
  if (!existing) return false;
  await db.prepare('DELETE FROM routes WHERE id = ?').bind(routeId).run();
  return true;
}

export async function listAttempts(db: D1Database, userId: string, routeId: string): Promise<Attempt[]> {
  const result = await db
    .prepare(
      `SELECT a.* FROM attempts a
       JOIN routes r ON r.id = a.route_id
       JOIN gyms g ON g.id = r.gym_id
       WHERE a.route_id = ? AND g.user_id = ?
       ORDER BY a.attempted_on DESC, a.created_at DESC`
    )
    .bind(routeId, userId)
    .all<Attempt>();
  return result.results;
}

export interface AttemptInput {
  attempted_on: string;
  result: Attempt['result'];
  high_point: string;
  notes: string;
}

export async function createAttempt(db: D1Database, routeId: string, input: AttemptInput): Promise<Attempt> {
  const attempt: Attempt = {
    id: crypto.randomUUID(),
    route_id: routeId,
    ...input,
    created_at: Date.now(),
  };
  await db
    .prepare(
      `INSERT INTO attempts (id, route_id, attempted_on, result, high_point, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      attempt.id,
      attempt.route_id,
      attempt.attempted_on,
      attempt.result,
      attempt.high_point,
      attempt.notes,
      attempt.created_at
    )
    .run();
  return attempt;
}

export async function getAttempt(db: D1Database, userId: string, attemptId: string): Promise<Attempt | null> {
  return db
    .prepare(
      `SELECT a.* FROM attempts a
       JOIN routes r ON r.id = a.route_id
       JOIN gyms g ON g.id = r.gym_id
       WHERE a.id = ? AND g.user_id = ?`
    )
    .bind(attemptId, userId)
    .first<Attempt>();
}

export async function updateAttempt(
  db: D1Database,
  userId: string,
  attemptId: string,
  fields: Partial<AttemptInput>
): Promise<Attempt | null> {
  const existing = await getAttempt(db, userId, attemptId);
  if (!existing) return null;

  const next = { ...existing, ...fields };
  await db
    .prepare('UPDATE attempts SET attempted_on = ?, result = ?, high_point = ?, notes = ? WHERE id = ?')
    .bind(next.attempted_on, next.result, next.high_point, next.notes, attemptId)
    .run();
  return next;
}

export async function deleteAttempt(db: D1Database, userId: string, attemptId: string): Promise<boolean> {
  const existing = await getAttempt(db, userId, attemptId);
  if (!existing) return false;
  await db.prepare('DELETE FROM attempts WHERE id = ?').bind(attemptId).run();
  return true;
}

export async function listPhotos(db: D1Database, userId: string, routeId: string): Promise<RoutePhoto[]> {
  const result = await db
    .prepare(
      `SELECT p.* FROM route_photos p
       JOIN routes r ON r.id = p.route_id
       JOIN gyms g ON g.id = r.gym_id
       WHERE p.route_id = ? AND g.user_id = ?
       ORDER BY p.created_at`
    )
    .bind(routeId, userId)
    .all<RoutePhoto>();
  return result.results;
}

export async function getPhoto(db: D1Database, userId: string, photoId: string): Promise<RoutePhoto | null> {
  return db
    .prepare(
      `SELECT p.* FROM route_photos p
       JOIN routes r ON r.id = p.route_id
       JOIN gyms g ON g.id = r.gym_id
       WHERE p.id = ? AND g.user_id = ?`
    )
    .bind(photoId, userId)
    .first<RoutePhoto>();
}

export async function countPhotos(db: D1Database, routeId: string): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS n FROM route_photos WHERE route_id = ?')
    .bind(routeId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function createPhoto(
  db: D1Database,
  routeId: string,
  input: { id: string; r2_key: string; content_type: string; size: number }
): Promise<RoutePhoto> {
  const photo: RoutePhoto = {
    id: input.id,
    route_id: routeId,
    r2_key: input.r2_key,
    content_type: input.content_type,
    size: input.size,
    created_at: Date.now(),
  };
  await db
    .prepare(
      `INSERT INTO route_photos (id, route_id, r2_key, content_type, size, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(photo.id, photo.route_id, photo.r2_key, photo.content_type, photo.size, photo.created_at)
    .run();
  return photo;
}

export async function deletePhoto(db: D1Database, photoId: string): Promise<void> {
  await db.prepare('DELETE FROM route_photos WHERE id = ?').bind(photoId).run();
}
