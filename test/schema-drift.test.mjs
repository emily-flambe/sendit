// Guards against drift between two independent copies of the schema: the real
// migration files (migrations/*.sql) and the inline schema the vitest suite
// builds its test database from (src/db/test-setup.ts). Every other test trusts
// that inline copy, so if it falls behind the migrations, the suite can pass
// against a schema production never has. This fails when they diverge in
// columns, foreign keys, or CHECK constraints.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const migrationsDir = fileURLToPath(new URL('../migrations/', import.meta.url));
const testSetupPath = fileURLToPath(new URL('../src/db/test-setup.ts', import.meta.url));
const runSql = (db, sql) => db['exec'](sql);

function dbFromMigrations() {
  const db = new DatabaseSync(':memory:');
  runSql(db, 'PRAGMA foreign_keys = ON;');
  for (const f of readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()) {
    runSql(db, readFileSync(migrationsDir + f, 'utf8'));
  }
  return db;
}

function dbFromInlineSchema() {
  const src = readFileSync(testSetupPath, 'utf8');
  const m = src.match(/const schema = `([\s\S]*?)`;/);
  assert.ok(m, 'could not find the inline `const schema = ` template in test-setup.ts');
  const db = new DatabaseSync(':memory:');
  runSql(db, 'PRAGMA foreign_keys = ON;');
  runSql(db, m[1]);
  return db;
}

// Balanced-paren scan of every top-level CHECK(...) in a CREATE statement,
// whitespace-normalized so cosmetic formatting doesn't count as drift.
function extractChecks(sql) {
  const checks = [];
  for (const m of sql.matchAll(/\bCHECK\s*\(/gi)) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < sql.length && depth > 0; i++) {
      if (sql[i] === '(') depth++;
      else if (sql[i] === ')') depth--;
    }
    checks.push(sql.slice(m.index, i).replace(/\s+/g, ' ').trim());
  }
  return checks.sort();
}

// Order-independent fingerprint of a table: its columns, foreign keys, and
// CHECK constraints. Column order is deliberately ignored — migrations append
// columns via ALTER, so order legitimately differs from an inline CREATE.
function fingerprint(db) {
  const tables = db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != 'd1_migrations'")
    .all();
  const out = {};
  for (const { name, sql } of tables) {
    const cols = db
      .prepare(`PRAGMA table_info(${name})`)
      .all()
      .map((c) => `${c.name}|${c.type}|notnull=${c.notnull}|dflt=${c.dflt_value}|pk=${c.pk}`)
      .sort();
    const fks = db
      .prepare(`PRAGMA foreign_key_list(${name})`)
      .all()
      .map((f) => `${f.table}(${f.from}->${f.to}) del=${f.on_delete} upd=${f.on_update}`)
      .sort();
    out[name] = { cols, fks, checks: extractChecks(sql) };
  }
  return out;
}

test('inline test schema matches what the migrations produce', () => {
  const mig = fingerprint(dbFromMigrations());
  const inl = fingerprint(dbFromInlineSchema());

  const migTables = Object.keys(mig).sort();
  const inlTables = Object.keys(inl).sort();
  assert.deepEqual(inlTables, migTables, 'table set differs between migrations and test-setup.ts inline schema');

  for (const t of migTables) {
    assert.deepEqual(inl[t].cols, mig[t].cols, `columns of "${t}" drifted from the migrations`);
    assert.deepEqual(inl[t].fks, mig[t].fks, `foreign keys of "${t}" drifted from the migrations`);
    assert.deepEqual(inl[t].checks, mig[t].checks, `CHECK constraints of "${t}" drifted from the migrations`);
  }
});
