import type {
  Attempt,
  CatalogEntry,
  CatalogEntryWithImport,
  CatalogSource,
  Gym,
  LinkedRoute,
  LogEntry,
  Photo,
  PhotoWithLinks,
  Route,
  DrawingItem,
  RouteImage,
  RouteMarker,
  RouteWithGym,
  User,
} from '../types';

// Thumbnail source for a route, shared by the route lists and the climb log:
// the annotated route image if there is one (with its markers and photo version
// so the client can render the spotlit crop), else the first linked photo.
const THUMB_COLUMNS = `(SELECT l.photo_id FROM route_photo_links l WHERE l.route_id = r.id ORDER BY l.created_at LIMIT 1) AS first_photo_id,
       (SELECT ri.photo_id FROM route_images ri WHERE ri.route_id = r.id) AS image_photo_id,
       (SELECT ri.markers FROM route_images ri WHERE ri.route_id = r.id) AS image_markers,
       (SELECT p.updated_at FROM route_images ri JOIN photos p ON p.id = ri.photo_id WHERE ri.route_id = r.id) AS image_photo_v`;

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
    catalog_source: '',
    catalog_gym_id: '',
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
  fields: {
    name?: string;
    notes?: string;
    archived?: number;
    catalog_source?: string;
    catalog_gym_id?: string;
  }
): Promise<Gym | null> {
  const existing = await getGym(db, userId, gymId);
  if (!existing) return null;

  const next = { ...existing, ...fields };
  await db
    .prepare(
      `UPDATE gyms SET name = ?, notes = ?, archived = ?, catalog_source = ?, catalog_gym_id = ?
       WHERE id = ? AND user_id = ?`
    )
    .bind(next.name, next.notes, next.archived, next.catalog_source, next.catalog_gym_id, gymId, userId)
    .run();
  return next;
}

// ---------- gym catalog ----------

// Catalogs the sync has populated, for the "link this gym" picker. Not
// user-scoped: catalogs describe public gyms, not anyone's own data.
export async function listCatalogSources(db: D1Database): Promise<CatalogSource[]> {
  const result = await db
    .prepare(
      `SELECT source, source_gym_id, MAX(source_gym_name) AS source_gym_name,
              COUNT(*) AS climb_count, MAX(last_seen_at) AS last_synced_at
       FROM gym_catalog
       WHERE removed_at IS NULL
       GROUP BY source, source_gym_id
       ORDER BY source_gym_name`
    )
    .all<CatalogSource>();
  return result.results;
}

// Every climb the gym's linked catalog currently lists, newest set first, each
// annotated with the user's route if they already imported it. Climbs the sync
// stopped seeing (removed_at set) are excluded unless asked for.
export async function listGymCatalog(
  db: D1Database,
  gym: Gym,
  opts: { includeRemoved?: boolean } = {}
): Promise<CatalogEntryWithImport[]> {
  if (!gym.catalog_source || !gym.catalog_gym_id) return [];
  const removedClause = opts.includeRemoved ? '' : 'AND c.removed_at IS NULL';
  const result = await db
    .prepare(
      `SELECT c.*,
              (SELECT r.id FROM routes r
                WHERE r.gym_id = ? AND r.source = c.source AND r.source_external_id = c.external_id
                LIMIT 1) AS imported_route_id
       FROM gym_catalog c
       WHERE c.source = ? AND c.source_gym_id = ? ${removedClause}
       ORDER BY c.wall, c.first_seen_at DESC`
    )
    .bind(gym.id, gym.catalog_source, gym.catalog_gym_id)
    .all<CatalogEntryWithImport>();
  return result.results;
}

// Copies catalog entries into the user's routes. Entries already imported into
// this gym are skipped rather than duplicated, so re-running is harmless.
// `name` is left empty on purpose: gym climbs have no names, and the client
// composes a label from wall + grade + color.
export async function importCatalogEntries(
  db: D1Database,
  gym: Gym,
  catalogIds: string[]
): Promise<{ routes: Route[]; skipped: string[] }> {
  const entries = await listGymCatalog(db, gym, { includeRemoved: true });
  const wanted = new Set(catalogIds);
  const routes: Route[] = [];
  const skipped: string[] = [];

  for (const entry of entries) {
    if (!wanted.has(entry.id)) continue;
    if (entry.imported_route_id) {
      skipped.push(entry.id);
      continue;
    }
    routes.push(
      await createRoute(db, gym.id, {
        name: '',
        grade: entry.grade,
        color: entry.color,
        wall: entry.wall,
        discipline: entry.discipline,
        notes: '',
        source: entry.source,
        source_external_id: entry.external_id,
      })
    );
  }
  return { routes, skipped };
}

// Point an existing hand-entered route at a catalog climb. Adopts the catalog's
// wall label, which overwrites whatever the user typed — unlinking does not put
// it back. Returns null if the route or the entry isn't usable.
export async function linkRouteToCatalog(
  db: D1Database,
  userId: string,
  routeId: string,
  catalogId: string
): Promise<Route | null> {
  const route = await getRoute(db, userId, routeId);
  if (!route) return null;

  const gym = await getGym(db, userId, route.gym_id);
  if (!gym?.catalog_source || !gym.catalog_gym_id) return null;

  const entry = await db
    .prepare(
      `SELECT * FROM gym_catalog
       WHERE id = ? AND source = ? AND source_gym_id = ?`
    )
    .bind(catalogId, gym.catalog_source, gym.catalog_gym_id)
    .first<CatalogEntry>();
  if (!entry) return null;

  // One climb maps to at most one route per gym, so a second claim is refused
  // rather than silently splitting a climb's history across two routes.
  const claimed = await db
    .prepare(
      `SELECT id FROM routes
       WHERE gym_id = ? AND source = ? AND source_external_id = ? AND id <> ?`
    )
    .bind(route.gym_id, entry.source, entry.external_id, routeId)
    .first<{ id: string }>();
  if (claimed) return null;

  const next: Route = {
    ...route,
    wall: entry.wall,
    source: entry.source,
    source_external_id: entry.external_id,
    updated_at: Date.now(),
  };
  await db
    .prepare('UPDATE routes SET wall = ?, source = ?, source_external_id = ?, updated_at = ? WHERE id = ?')
    .bind(next.wall, next.source, next.source_external_id, next.updated_at, routeId)
    .run();
  return next;
}

// Drops the catalog association. The wall label stays as-is.
export async function unlinkRouteFromCatalog(
  db: D1Database,
  userId: string,
  routeId: string
): Promise<Route | null> {
  const route = await getRoute(db, userId, routeId);
  if (!route || !route.source) return null;

  const next: Route = { ...route, source: '', source_external_id: '', updated_at: Date.now() };
  await db
    .prepare("UPDATE routes SET source = '', source_external_id = '', updated_at = ? WHERE id = ?")
    .bind(next.updated_at, routeId)
    .run();
  return next;
}

// Route cards for the routes list, either across every gym or scoped to one.
export async function listRoutes(
  db: D1Database,
  userId: string,
  opts: { gymId?: string; includeArchived: boolean }
): Promise<RouteWithGym[]> {
  const archivedClause = opts.includeArchived ? '' : 'AND r.archived = 0';
  const gymClause = opts.gymId ? 'AND r.gym_id = ?' : '';
  const binds = opts.gymId ? [userId, opts.gymId] : [userId];
  const result = await db
    .prepare(
      `SELECT r.*,
              g.name AS gym_name,
              COUNT(a.id) AS attempt_count,
              COALESCE(SUM(a.result = 'send'), 0) AS send_count,
              MAX(a.attempted_on) AS last_attempted_on,
              (SELECT COUNT(*) FROM route_photo_links l WHERE l.route_id = r.id) AS photo_count,
              ${THUMB_COLUMNS}
       FROM routes r
       JOIN gyms g ON g.id = r.gym_id
       LEFT JOIN attempts a ON a.route_id = r.id
       WHERE g.user_id = ? ${gymClause} ${archivedClause}
       GROUP BY r.id
       ORDER BY r.created_at DESC`
    )
    .bind(...binds)
    .all<RouteWithGym>();
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
  source?: string;
  source_external_id?: string;
}

export async function createRoute(db: D1Database, gymId: string, input: RouteInput): Promise<Route> {
  const now = Date.now();
  const route: Route = {
    id: crypto.randomUUID(),
    gym_id: gymId,
    ...input,
    source: input.source ?? '',
    source_external_id: input.source_external_id ?? '',
    archived: 0,
    created_at: now,
    updated_at: now,
  };
  await db
    .prepare(
      `INSERT INTO routes (id, gym_id, name, grade, color, wall, discipline, notes, archived, created_at, updated_at, source, source_external_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`
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
      route.updated_at,
      route.source,
      route.source_external_id
    )
    .run();
  return route;
}

export async function updateRoute(
  db: D1Database,
  userId: string,
  routeId: string,
  fields: Partial<RouteInput> & { archived?: number; gym_id?: string }
): Promise<Route | null> {
  const existing = await getRoute(db, userId, routeId);
  if (!existing) return null;

  // Callers must verify a new gym_id belongs to this user before passing it.
  const next = { ...existing, ...fields, updated_at: Date.now() };
  await db
    .prepare(
      `UPDATE routes
       SET gym_id = ?, name = ?, grade = ?, color = ?, wall = ?, discipline = ?, notes = ?, archived = ?, updated_at = ?
       WHERE id = ?`
    )
    .bind(
      next.gym_id,
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
  climb_type: Attempt['climb_type'];
  flashed: number;
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
      `INSERT INTO attempts (id, route_id, attempted_on, result, climb_type, flashed, high_point, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      attempt.id,
      attempt.route_id,
      attempt.attempted_on,
      attempt.result,
      attempt.climb_type,
      attempt.flashed,
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
    .prepare(
      'UPDATE attempts SET attempted_on = ?, result = ?, climb_type = ?, flashed = ?, high_point = ?, notes = ? WHERE id = ?'
    )
    .bind(next.attempted_on, next.result, next.climb_type, next.flashed, next.high_point, next.notes, attemptId)
    .run();
  return next;
}

export async function deleteAttempt(db: D1Database, userId: string, attemptId: string): Promise<boolean> {
  const existing = await getAttempt(db, userId, attemptId);
  if (!existing) return false;
  await db.prepare('DELETE FROM attempts WHERE id = ?').bind(attemptId).run();
  return true;
}

export async function listRoutePhotos(db: D1Database, userId: string, routeId: string): Promise<Photo[]> {
  const result = await db
    .prepare(
      `SELECT p.* FROM photos p
       JOIN route_photo_links l ON l.photo_id = p.id
       WHERE l.route_id = ? AND p.user_id = ?
       ORDER BY l.created_at`
    )
    .bind(routeId, userId)
    .all<Photo>();
  return result.results;
}

export async function listGalleryPhotos(db: D1Database, userId: string, gymId: string | null): Promise<PhotoWithLinks[]> {
  const gymClause = gymId ? 'AND p.gym_id = ?' : '';
  const stmt = db.prepare(
    `SELECT p.*, (SELECT COUNT(*) FROM route_photo_links l WHERE l.photo_id = p.id) AS link_count
     FROM photos p
     WHERE p.user_id = ? ${gymClause}
     ORDER BY p.created_at DESC`
  );
  const result = await (gymId ? stmt.bind(userId, gymId) : stmt.bind(userId)).all<PhotoWithLinks>();
  return result.results;
}

export async function getPhoto(db: D1Database, userId: string, photoId: string): Promise<Photo | null> {
  return db.prepare('SELECT * FROM photos WHERE id = ? AND user_id = ?').bind(photoId, userId).first<Photo>();
}

export async function countRoutePhotoLinks(db: D1Database, routeId: string): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS n FROM route_photo_links WHERE route_id = ?')
    .bind(routeId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function createPhoto(
  db: D1Database,
  userId: string,
  gymId: string | null,
  input: { id: string; r2_key: string; content_type: string; size: number }
): Promise<Photo> {
  const now = Date.now();
  const photo: Photo = {
    id: input.id,
    user_id: userId,
    gym_id: gymId,
    r2_key: input.r2_key,
    content_type: input.content_type,
    size: input.size,
    created_at: now,
    updated_at: now,
  };
  await db
    .prepare(
      `INSERT INTO photos (id, user_id, gym_id, r2_key, content_type, size, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      photo.id,
      photo.user_id,
      photo.gym_id,
      photo.r2_key,
      photo.content_type,
      photo.size,
      photo.created_at,
      photo.updated_at
    )
    .run();
  return photo;
}

export async function overwritePhoto(
  db: D1Database,
  photoId: string,
  input: { r2_key: string; content_type: string; size: number }
): Promise<number> {
  const updatedAt = Date.now();
  await db
    .prepare('UPDATE photos SET r2_key = ?, content_type = ?, size = ?, updated_at = ? WHERE id = ?')
    .bind(input.r2_key, input.content_type, input.size, updatedAt, photoId)
    .run();
  return updatedAt;
}

export async function updatePhotoGym(db: D1Database, photoId: string, gymId: string | null): Promise<void> {
  await db.prepare('UPDATE photos SET gym_id = ? WHERE id = ?').bind(gymId, photoId).run();
}

export async function deletePhoto(db: D1Database, photoId: string): Promise<void> {
  await db.prepare('DELETE FROM photos WHERE id = ?').bind(photoId).run();
}

export async function linkPhoto(db: D1Database, routeId: string, photoId: string): Promise<void> {
  await db
    .prepare('INSERT OR IGNORE INTO route_photo_links (route_id, photo_id, created_at) VALUES (?, ?, ?)')
    .bind(routeId, photoId, Date.now())
    .run();
}

export async function isPhotoLinked(db: D1Database, routeId: string, photoId: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT 1 AS one FROM route_photo_links WHERE route_id = ? AND photo_id = ?')
    .bind(routeId, photoId)
    .first<{ one: number }>();
  return row !== null;
}

export async function unlinkPhoto(db: D1Database, routeId: string, photoId: string): Promise<boolean> {
  const result = await db
    .prepare('DELETE FROM route_photo_links WHERE route_id = ? AND photo_id = ?')
    .bind(routeId, photoId)
    .run();
  return result.meta.changes > 0;
}

export async function listLinkedRoutes(db: D1Database, userId: string, photoId: string): Promise<LinkedRoute[]> {
  const result = await db
    .prepare(
      `SELECT r.id AS route_id, r.name, r.grade, r.color,
              EXISTS(SELECT 1 FROM route_images ri WHERE ri.route_id = r.id AND ri.photo_id = l.photo_id) AS has_annotation
       FROM route_photo_links l
       JOIN routes r ON r.id = l.route_id
       JOIN gyms g ON g.id = r.gym_id
       WHERE l.photo_id = ? AND g.user_id = ?
       ORDER BY l.created_at`
    )
    .bind(photoId, userId)
    .all<LinkedRoute>();
  return result.results;
}

// Internal (no user scoping — callers verify photo ownership first): all
// annotations drawn on a photo, for marker remapping when the photo is edited.
export async function listRouteImagesByPhoto(db: D1Database, photoId: string): Promise<RouteImage[]> {
  const result = await db
    .prepare('SELECT * FROM route_images WHERE photo_id = ?')
    .bind(photoId)
    .all<RouteImageRow>();
  return result.results.map(parseRouteImageRow);
}

export async function setRouteImageMarkers(
  db: D1Database,
  routeId: string,
  markers: RouteMarker[],
  drawings: DrawingItem[]
): Promise<void> {
  await db
    .prepare('UPDATE route_images SET markers = ?, drawings = ?, updated_at = ? WHERE route_id = ?')
    .bind(JSON.stringify(markers), JSON.stringify(drawings), Date.now(), routeId)
    .run();
}

export async function deleteRouteImageRow(db: D1Database, routeId: string): Promise<void> {
  await db.prepare('DELETE FROM route_images WHERE route_id = ?').bind(routeId).run();
}

interface RouteImageRow {
  route_id: string;
  photo_id: string;
  markers: string;
  drawings: string | null;
  updated_at: number;
}

function parseRouteImageRow(row: RouteImageRow): RouteImage {
  return {
    ...row,
    markers: JSON.parse(row.markers) as RouteMarker[],
    drawings: JSON.parse(row.drawings ?? '[]') as DrawingItem[],
  };
}

export async function getRouteImage(db: D1Database, userId: string, routeId: string): Promise<RouteImage | null> {
  const row = await db
    .prepare(
      `SELECT ri.* FROM route_images ri
       JOIN routes r ON r.id = ri.route_id
       JOIN gyms g ON g.id = r.gym_id
       WHERE ri.route_id = ? AND g.user_id = ?`
    )
    .bind(routeId, userId)
    .first<RouteImageRow>();
  if (!row) return null;
  return parseRouteImageRow(row);
}

export async function upsertRouteImage(
  db: D1Database,
  routeId: string,
  photoId: string,
  markers: RouteMarker[],
  drawings: DrawingItem[]
): Promise<RouteImage> {
  const image: RouteImage = {
    route_id: routeId,
    photo_id: photoId,
    markers,
    drawings,
    updated_at: Date.now(),
  };
  await db
    .prepare(
      `INSERT INTO route_images (route_id, photo_id, markers, drawings, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(route_id) DO UPDATE SET
         photo_id = excluded.photo_id,
         markers = excluded.markers,
         drawings = excluded.drawings,
         updated_at = excluded.updated_at`
    )
    .bind(image.route_id, image.photo_id, JSON.stringify(image.markers), JSON.stringify(image.drawings), image.updated_at)
    .run();
  return image;
}

export async function deleteRouteImage(db: D1Database, userId: string, routeId: string): Promise<boolean> {
  const existing = await getRouteImage(db, userId, routeId);
  if (!existing) return false;
  await db.prepare('DELETE FROM route_images WHERE route_id = ?').bind(routeId).run();
  return true;
}

export async function listLog(db: D1Database, userId: string, limit = 100): Promise<LogEntry[]> {
  const result = await db
    .prepare(
      `SELECT a.*,
              r.name AS route_name,
              r.grade AS route_grade,
              r.color AS route_color,
              r.wall AS route_wall,
              r.discipline AS route_discipline,
              g.id AS gym_id,
              g.name AS gym_name,
              ${THUMB_COLUMNS}
       FROM attempts a
       JOIN routes r ON r.id = a.route_id
       JOIN gyms g ON g.id = r.gym_id
       WHERE g.user_id = ?
       ORDER BY a.attempted_on DESC, a.created_at DESC
       LIMIT ?`
    )
    .bind(userId, limit)
    .all<LogEntry>();
  return result.results;
}
