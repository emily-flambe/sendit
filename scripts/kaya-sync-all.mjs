// Syncs every external gym registered in `catalog_gyms`, one at a time, and
// applies each result to D1. Run by .github/workflows/kaya-sync.yml.
//
//   node scripts/kaya-sync-all.mjs                 # every registered gym
//   node scripts/kaya-sync-all.mjs --gym thespotboulder   # just this one
//   node scripts/kaya-sync-all.mjs --dry-run       # list what it would sync
//
// One gym failing marks its row 'error' and the run continues, but still exits
// non-zero so Actions shows the failure.

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
// In the workspace so the workflow can upload it as a run artifact.
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

// An explicit --gym is trusted as-is, so a manual run works before the app has
// registered the gym.
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
    // So a typo'd slug explains itself instead of sitting on "pending" forever.
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
