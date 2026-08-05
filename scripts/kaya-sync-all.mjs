// Syncs every external gym registered in `catalog_gyms`, one at a time, and
// applies each result to D1. Run by .github/workflows/kaya-sync.yml.
//
//   node scripts/kaya-sync-all.mjs                 # every registered gym
//   node scripts/kaya-sync-all.mjs --gym thespotboulder   # just this one
//   node scripts/kaya-sync-all.mjs --dry-run       # list what it would sync
//
// One gym failing does not stop the others: its row is marked 'error' with the
// message, which the app shows next to the gym, and the run continues. The exit
// code is still non-zero so a broken sync is visible in Actions.

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SOURCE = 'kaya';
const DB = 'sendit-db';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const only = arg('gym');
const dryRun = process.argv.includes('--dry-run');
// Kept in the workspace so the workflow can upload the SQL and raw JSON as run
// artifacts, the same as the single-gym sync did.
const work = arg('out', 'catalog-sync');
mkdirSync(work, { recursive: true });
const sqlStr = (v) => `'${String(v ?? '').replace(/'/g, "''")}'`;

const wrangler = (args) =>
  execFileSync('npx', ['wrangler', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

const d1 = (args) => wrangler(['d1', 'execute', DB, '--remote', '--yes', ...args]);

function registeredSlugs() {
  const out = d1(['--json', '--command', `SELECT slug FROM catalog_gyms WHERE source = '${SOURCE}' ORDER BY slug`]);
  // wrangler --json prints an array of statement results.
  const parsed = JSON.parse(out);
  const rows = (Array.isArray(parsed) ? parsed : [parsed]).flatMap((r) => r.results ?? []);
  return rows.map((r) => r.slug).filter(Boolean);
}

// A gym asked for by hand may not be registered yet (the app registers it, but
// a manual run should still work), so an explicit --gym is trusted as-is.
const slugs = only ? [only] : registeredSlugs();
if (slugs.length === 0) {
  console.error('no gyms registered in catalog_gyms; nothing to sync');
  process.exit(0);
}
console.error(`syncing ${slugs.length} gym(s): ${slugs.join(', ')}`);
if (dryRun) process.exit(0);

const failures = [];
for (const slug of slugs) {
  const sqlPath = join(work, `${slug}.sql`);
  const jsonPath = join(work, `${slug}.json`);
  try {
    execFileSync('node', ['scripts/kaya-sync.mjs', '--gym', slug, '--sql', sqlPath, '--json', jsonPath], {
      stdio: 'inherit',
    });
    d1(['--file', sqlPath]);
    console.error(`✓ ${slug}`);
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 400);
    console.error(`✗ ${slug}: ${message}`);
    failures.push(slug);
    // Surfaced in the app next to the gym, so a typo'd slug explains itself
    // instead of sitting on "pending" forever.
    const errPath = join(work, `${slug}-error.sql`);
    writeFileSync(
      errPath,
      `INSERT INTO catalog_gyms (source, slug, status, error, requested_at)
VALUES (${sqlStr(SOURCE)}, ${sqlStr(slug)}, 'error', ${sqlStr(message)}, ${Date.now()})
ON CONFLICT(source, slug) DO UPDATE SET status = 'error', error = excluded.error;\n`,
    );
    try {
      d1(['--file', errPath]);
    } catch {
      console.error(`  (could not record the failure for ${slug})`);
    }
  }
}

console.error(`done: ${slugs.length - failures.length} ok, ${failures.length} failed`);
console.error(`artifacts in ${work}`);
if (failures.length) process.exit(1);
