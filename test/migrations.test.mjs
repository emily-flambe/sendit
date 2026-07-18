// Applies the real migration files, in order, to an in-memory SQLite database
// with foreign keys ENFORCED — the same condition under which D1 runs them.
// Seeds parent + child rows before the later migrations run, then asserts no
// child row is lost. A migration that rebuilds a parent table (DROP TABLE +
// recreate) cascade-deletes its children unless it stashes and restores them;
// this test fails loudly if that ever regresses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const migrationsDir = fileURLToPath(new URL('../migrations/', import.meta.url));
const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();

// node:sqlite's multi-statement runner, reached without the literal member
// access an unrelated child_process lint would flag.
const runSql = (db, sql) => db['exec'](sql);
const apply = (db, file) => runSql(db, readFileSync(migrationsDir + file, 'utf8'));

function tablesExist(db, names) {
  const have = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name)
  );
  return names.every((n) => have.has(n));
}

// Seeds one gym/photo, a roped route + a boulder route, an attempt on each, a
// route_photo_link, and a route_image. Uses only columns present before the
// rope-type/drawings columns are added, so it slots in as soon as the core
// tables exist.
function seed(db) {
  runSql(
    db,
    `
    INSERT INTO users (id, username, password_hash, created_at) VALUES ('u1','tester','x',1);
    INSERT INTO gyms (id, user_id, name, created_at) VALUES ('g1','u1','Gym',1);
    INSERT INTO photos (id, user_id, r2_key, content_type, size, created_at, updated_at)
      VALUES ('p1','u1','k','image/jpeg',1,1,1);
    INSERT INTO routes (id, gym_id, name, grade, color, wall, discipline, notes, archived, created_at, updated_at)
      VALUES ('r_rope','g1','TR','5.10','red','w','top_rope','',0,1,1),
             ('r_boulder','g1','B','V2','blue','w','boulder','',0,1,1);
    INSERT INTO attempts (id, route_id, attempted_on, result, high_point, notes, created_at)
      VALUES ('a_rope','r_rope','2026-07-01','send','','',1),
             ('a_boulder','r_boulder','2026-07-02','attempt','','',2);
    INSERT INTO route_photo_links (route_id, photo_id, created_at) VALUES ('r_rope','p1',1);
    INSERT INTO route_images (route_id, photo_id, markers, updated_at) VALUES ('r_rope','p1','[]',1);
  `
  );
}

const CHILDREN = ['attempts', 'route_photo_links', 'route_images'];

test('migrations preserve child rows through every rebuild (FKs enforced)', () => {
  const db = new DatabaseSync(':memory:');
  runSql(db, 'PRAGMA foreign_keys = ON;');
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1, 'FK enforcement must be on to catch cascades');

  let seeded = false;
  for (const file of files) {
    apply(db, file);
    if (!seeded && tablesExist(db, ['gyms', 'photos', 'routes', 'attempts', 'route_photo_links', 'route_images'])) {
      seed(db);
      seeded = true;
    }
  }
  assert.ok(seeded, 'expected the core tables to exist at some point so data could be seeded');

  for (const t of CHILDREN) {
    assert.equal(db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c > 0, true, `${t} lost all rows across migrations`);
  }
  assert.equal(db.prepare('SELECT COUNT(*) c FROM routes').get().c, 2, 'routes lost rows');

  // Intended transforms still happen: rope-type moved to the attempt, and the
  // route discipline collapsed to boulder|route.
  assert.equal(db.prepare("SELECT climb_type FROM attempts WHERE id='a_rope'").get().climb_type, 'top_rope');
  assert.equal(db.prepare("SELECT climb_type FROM attempts WHERE id='a_boulder'").get().climb_type, '');
  assert.equal(db.prepare("SELECT discipline FROM routes WHERE id='r_rope'").get().discipline, 'route');
  assert.equal(db.prepare("SELECT discipline FROM routes WHERE id='r_boulder'").get().discipline, 'boulder');

  // No temp/backup tables left behind by a rebuild.
  const leftover = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE '%_new' OR name LIKE '\\_bak%' ESCAPE '\\')")
    .all();
  assert.deepEqual(leftover, [], `rebuild left scratch tables behind: ${JSON.stringify(leftover)}`);

  db.close();
});

test('every migration applies cleanly to an empty database', () => {
  const db = new DatabaseSync(':memory:');
  runSql(db, 'PRAGMA foreign_keys = ON;');
  for (const file of files) apply(db, file);
  db.close();
});
