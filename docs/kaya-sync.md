# KAYA catalog sync

Gyms like Movement Boulder and The Spot publish their current routes and boulders through [KAYA](https://kayaclimb.com), the app their setting teams post to. This syncs that inventory into `gym_catalog` once a day so routes can be imported instead of typed in by hand.

The sync only ever writes `gym_catalog` and `catalog_gyms`. Your own `routes` change when you import an entry, never automatically.

## Which gyms get synced

`catalog_gyms` is the list, one row per external gym, keyed by `(source, slug)`. The slug is the last part of a gym's KAYA URL — `kayaclimb.com/gym/thespotboulder` — and it is the identifier everything else keys on, because it's the only one a user can see and type. KAYA's numeric gym id and the gym's display name land on the row at the first successful sync; until then the row reads `pending`, or `error` with the message if the slug turned out to be wrong.

Add a gym from the **Gyms** screen (see below) or over the API:

```bash
curl -X POST .../api/catalogs -H 'Authorization: Bearer <token>' \
  -d '{"slug":"thespotboulder"}'
```

## How it runs

`.github/workflows/kaya-sync.yml` runs `scripts/kaya-sync-all.mjs` on a daily cron (02:00 UTC, evening in Colorado, after the day's setting). That script reads the gym list out of `catalog_gyms`, runs `scripts/kaya-sync.mjs` per gym, and applies each result with `wrangler d1 execute --remote`. It reuses the `CLOUDFLARE_API_TOKEN` secret that Preview and Deploy already need (see [deployment](deployment.md)), and skips with a warning if that secret is absent.

One gym failing doesn't stop the rest: its row is marked `error` with the message, the run continues, and the job still exits non-zero so the failure is visible in Actions. Everything written to `catalog-sync/` is kept as a run artifact for 14 days, so a bad sync can be diagnosed after the fact.

It lives in Actions rather than in the Worker because the pull needs a headless browser, which Workers can't run.

To run it by hand:

```bash
node scripts/kaya-sync-all.mjs                       # every registered gym
node scripts/kaya-sync-all.mjs --gym thespotboulder  # one gym
node scripts/kaya-sync-all.mjs --dry-run             # just list what it would sync
```

`scripts/kaya-sync.mjs` is still the single-gym pull, if you want the SQL without applying it:

```bash
node scripts/kaya-sync.mjs --gym movementboulder --sql catalog.sql --json catalog.json
npx wrangler d1 execute sendit-db --remote --yes --file=catalog.sql
```

The workflow can also be triggered ad hoc from the Actions tab; its `gym` input takes a slug, and a blank input syncs everything registered.

### Syncing on demand from the app

Adding a gym in the app asks GitHub to run the sync immediately, so the catalog arrives in a couple of minutes rather than after the next cron. That needs two optional Worker settings:

```bash
npx wrangler secret put GITHUB_TOKEN   # fine-grained PAT with Actions: read and write on this repo
npx wrangler secret put GITHUB_REPO    # emily-flambe/sendit
```

Without them, adding a gym still works — it just stays `pending` until the nightly run. The response from `POST /api/catalogs` says which happened (`sync.started`).

## Linking a gym and importing

A gym shows no catalog until it points at one. On the **Gyms** screen, each unlinked gym offers a "link a route catalog…" picker listing every gym in `catalog_gyms` (`GET /api/catalogs`), plus **add a KAYA gym by slug…** for one the app hasn't seen. That option explains where to find the slug, and adding it links this gym and starts the sync in one step; the gym then shows "syncing…" until climbs land, or "catalog failed" with the reason on hover. Linked gyms get an "import routes" link and an "unlink" button — unlinking only clears the pointer, so routes already imported stay put.

A route you entered by hand can be pointed at a catalog climb after the fact: open the route and pick from the **KAYA climb** list, which offers unclaimed climbs of the same discipline, newest set first, filterable by wall, grade or colour. Linking adopts the catalog's wall label, overwriting whatever you typed — unlinking does not restore it. One climb can be claimed by at most one route per gym, so a second attempt is refused.

The import screen groups the current inventory by wall, with a per-wall "select all" toggle. Entries already imported stay listed as checked and locked rather than vanishing, so the list keeps mirroring the wall in front of you. Importing creates one route per selected entry; importing something twice is a no-op.

The pointer can also be set over the API directly:

```bash
curl -X PATCH .../api/gyms/<gym-id> -H 'Authorization: Bearer <token>' \
  -d '{"catalog_source":"kaya","catalog_gym_slug":"movementboulder"}'
```

`gyms.catalog_gym_id` and `gym_catalog.source_gym_id` still hold KAYA's numeric id (`211` for Movement Boulder, `888` for The Spot Boulder) as provenance, but nothing reads them to match a gym to its catalog.

## What the data looks like

Gym climbs on KAYA have **no names** — neither Movement nor The Spot names them. Identity is grade + colour + wall, so imported routes are created with `name = ''` and the client composes a label from those three fields. The wall labels match the signs in the gym (`B4 - The Cave`, `Grey Wall`, `South Horseshoe` at Movement; `Yosemite`, `Hueco`, `Dojo` at The Spot).

Grades arrive lowercase (`v3`, `vB`) and are stored uppercased, so an imported route and one you typed in filter as the same grade. Colours are stored as the gym names them, including spellings like `dk green` that only one gym uses.

Per climb the catalog stores grade, colour, wall, discipline, `source_updated_at` (see below), plus `first_seen_at` / `last_seen_at` from our own syncs. KAYA's `rating` and `ascent_count` are stored but not shown anywhere.

`source_updated_at` is KAYA's `date_updated`, surfaced in the UI as the **set date** — the only field that distinguishes two same-colour, same-grade climbs on one wall. It is setter-driven rather than activity-driven: on 2026-07-31, `B3 - West Wall Right` had all 7 of its climbs dated 07-30 (a wall reset), while `South Horseshoe` still had climbs dated 2026-02-27 despite 161 of 219 climbs having logged ascents. A setter editing a grade would also bump it, so treat it as "last set or edited", not a guaranteed set date. The gym's own display name is denormalized onto each row as `source_gym_name` so the catalog picker can label itself without a second source of gym metadata. A climb the sync stops seeing gets `removed_at` set rather than deleted, so a route you already imported keeps its provenance after the set is stripped. Stripped entries are hidden from `GET /api/gyms/:id/catalog` unless you pass `?removed=1`.

Re-running is safe: entries upsert on `(source, external_id)`, and importing an entry twice skips it rather than creating a duplicate route.

## Notes and limits

- The GraphQL endpoint caps `count` at 20 per query — 24 or more returns `Count Limit Exceeded`. The script pages at 20 with a 1.2s delay.
- Sustained rapid querying trips a separate `Error. Try again later.` throttle that clears in about a minute. Don't lower the delay.
- KAYA's own `route_count` for Movement Boulder has read higher than what the paged query returns (119 vs 111 on 2026-07-25) while `boulder_count` matched exactly. The cause is unconfirmed; the script logs both numbers so drift is visible.
- An unrecognized KAYA `climb_type` fails the run rather than being filed as a rope route by default.
- Nothing in the catalog identifies a climb on its own. Wall + grade + colour collide in practice, and KAYA exposes no position data — `GymMapWall` carries only ids across ~90 probed field names, and beta videos (1 of 219 climbs) and comment threads (1 of 219) are too rare to help. The set date is the best available tiebreaker; picking a climb is ultimately the user's judgement.
- KAYA exposes no gym search: `webGym(slug:)` is the only lookup, so a gym has to be named by slug and a wrong slug can only be caught by trying it. Guessing slugs in bulk would be exactly the rapid querying the throttle above punishes.
- KAYA's terms of service prohibit scraping and automated access. This is a personal-use, low-volume sync of a couple of gyms someone actually climbs at; don't republish the data, add gyms you don't use, or raise the frequency.
