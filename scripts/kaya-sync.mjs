// Pulls a gym's current climb inventory from KAYA and emits idempotent SQL for
// the gym_catalog table. Run by .github/workflows/kaya-sync.yml, which pipes the
// SQL into `wrangler d1 execute`.
//
//   node scripts/kaya-sync.mjs --gym movementboulder --sql catalog.sql
//   node scripts/kaya-sync.mjs --gym movementboulder --json raw.json
//
// Queries run inside a real browser page: KAYA's GraphQL host sits behind bot
// protection that rejects bare fetch/curl clients. Gym climbs are unnamed, so
// the catalog stores grade + color + wall as the identity.

import { chromium } from '@playwright/test';
import { writeFileSync } from 'node:fs';

const SOURCE = 'kaya';
const ORIGIN = 'https://kaya-app.kayaclimb.com';
const GRAPHQL = 'https://kaya-beta.kayaclimb.com/graphql';
// The server rejects count > 20 with "Count Limit Exceeded", so paging is not optional.
const PAGE_SIZE = 20;
const PAGE_DELAY_MS = 1200;

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const slug = arg('gym', 'movementboulder');
const sqlPath = arg('sql');
const jsonPath = arg('json');
if (!sqlPath && !jsonPath) {
  console.error('nothing to do: pass --sql <path> and/or --json <path>');
  process.exit(2);
}

const sqlStr = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
const sqlNum = (v) => (v === null || v === undefined ? 'NULL' : Number(v));

// KAYA's climb_type names map onto sendit's two disciplines.
const DISCIPLINE = { Bouldering: 'boulder', Routes: 'route' };

// KAYA writes boulder grades lowercase ('v3', 'vB'); the app's grade list is
// uppercase, and two spellings of one grade filter as two grades.
const gradeLabel = (g) => (/^v/.test(g) ? `V${g.slice(1)}` : g);

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto(`${ORIGIN}/gym/${slug}`, { waitUntil: 'domcontentloaded' });

  const gql = (query, variables) =>
    page.evaluate(
      async ([url, query, variables]) => {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ query, variables }),
        });
        return res.json();
      },
      [GRAPHQL, query, variables],
    );

  const unwrap = (res, field) => {
    if (res.errors) throw new Error(`${field}: ${res.errors.map((e) => e.message).join('; ')}`);
    return res.data[field];
  };

  const gym = unwrap(
    await gql(
      `query($slug:String!){webGym(slug:$slug){
         id slug name boulder_count route_count address city region country website
       }}`,
      { slug },
    ),
    'webGym',
  );
  console.error(`gym ${gym.name} (id ${gym.id}) reports ${gym.boulder_count} boulders / ${gym.route_count} routes`);

  const climbs = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const batch = unwrap(
      await gql(
        `query($id:ID!,$offset:Int!,$count:Int!){
           webClimbsForGym(gym_id:$id,offset:$offset,count:$count){
             id slug rating ascent_count is_closed date_updated
             grade { name } color { name } climb_type { name } wall { id name }
           }
         }`,
        { id: gym.id, offset, count: PAGE_SIZE },
      ),
      'webClimbsForGym',
    );
    climbs.push(...batch);
    console.error(`  fetched ${climbs.length}`);
    if (batch.length < PAGE_SIZE) break;
    await new Promise((r) => setTimeout(r, PAGE_DELAY_MS));
  }

  const byExternalId = new Map(climbs.map((c) => [c.id, c]));
  const unknownTypes = [
    ...new Set(climbs.map((c) => c.climb_type?.name).filter((n) => n && !DISCIPLINE[n])),
  ];
  if (unknownTypes.length) {
    // A new climb_type would otherwise be silently filed as a rope route.
    throw new Error(`unrecognized KAYA climb_type(s): ${unknownTypes.join(', ')}`);
  }

  if (jsonPath) {
    writeFileSync(jsonPath, JSON.stringify({ gym, climbs: [...byExternalId.values()] }, null, 2));
    console.error(`wrote ${jsonPath}`);
  }

  if (sqlPath) {
    const now = Date.now();
    const lines = [
      `-- ${SOURCE} catalog sync for ${gym.name} (gym ${gym.id}) at ${new Date(now).toISOString()}`,
      `-- ${byExternalId.size} climbs; gym reports ${gym.boulder_count} boulders / ${gym.route_count} routes`,
    ];

    for (const c of byExternalId.values()) {
      const cols = [
        sqlStr(`${SOURCE}:${c.id}`),
        sqlStr(SOURCE),
        sqlStr(gym.id),
        sqlStr(gym.slug ?? slug),
        sqlStr(gym.name ?? ''),
        sqlStr(c.id),
        sqlStr(c.slug ?? ''),
        sqlStr(gradeLabel(c.grade?.name ?? '')),
        sqlStr((c.color?.name ?? '').toLowerCase()),
        sqlStr(c.wall?.name ?? ''),
        sqlStr(DISCIPLINE[c.climb_type?.name] ?? 'route'),
        sqlNum(c.rating),
        sqlNum(c.ascent_count ?? 0),
        c.is_closed ? 1 : 0,
        now,
        now,
        sqlStr(c.date_updated ?? ''),
      ].join(', ');
      // first_seen_at survives an update so "new this week" stays meaningful;
      // removed_at clears because seeing the climb again means it is back.
      lines.push(
        `INSERT INTO gym_catalog (id, source, source_gym_id, source_gym_slug, source_gym_name, external_id, slug, grade, color, wall, discipline, rating, ascent_count, is_closed, first_seen_at, last_seen_at, source_updated_at)
VALUES (${cols})
ON CONFLICT(source, external_id) DO UPDATE SET
  source_gym_id = excluded.source_gym_id, source_gym_slug = excluded.source_gym_slug,
  source_gym_name = excluded.source_gym_name,
  slug = excluded.slug, grade = excluded.grade,
  color = excluded.color, wall = excluded.wall, discipline = excluded.discipline,
  rating = excluded.rating, ascent_count = excluded.ascent_count, is_closed = excluded.is_closed,
  last_seen_at = excluded.last_seen_at, source_updated_at = excluded.source_updated_at,
  removed_at = NULL;`,
      );
    }

    // Anything this run did not see has been stripped off the wall.
    lines.push(
      `UPDATE gym_catalog SET removed_at = ${now}
 WHERE source = ${sqlStr(SOURCE)} AND source_gym_slug = ${sqlStr(gym.slug ?? slug)}
   AND last_seen_at < ${now} AND removed_at IS NULL;`,
    );

    // Confirms the slug the app accepted on faith, and supplies the gym's real
    // name and id — neither of which the app can look up itself.
    lines.push(
      `INSERT INTO catalog_gyms (source, slug, source_gym_id, name, status, error, requested_at, last_synced_at)
VALUES (${sqlStr(SOURCE)}, ${sqlStr(gym.slug ?? slug)}, ${sqlStr(gym.id)}, ${sqlStr(gym.name ?? '')}, 'ok', '', ${now}, ${now})
ON CONFLICT(source, slug) DO UPDATE SET
  source_gym_id = excluded.source_gym_id, name = excluded.name,
  status = 'ok', error = '', last_synced_at = excluded.last_synced_at;`,
    );

    writeFileSync(sqlPath, lines.join('\n') + '\n');
    console.error(`wrote ${sqlPath} (${byExternalId.size} upserts)`);
  }
} finally {
  await browser.close();
}
