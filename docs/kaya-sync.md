# KAYA catalog sync

Movement Boulder publishes its current routes and boulders through [KAYA](https://kayaclimb.com), the app its setting team posts to. This syncs that inventory into `gym_catalog` once a day so routes can be imported instead of typed in by hand.

The sync only ever writes `gym_catalog`. Your own `routes` change when you import an entry, never automatically.

## How it runs

`.github/workflows/kaya-sync.yml` runs `scripts/kaya-sync.mjs` on a daily cron (02:00 UTC, evening in Colorado, after the day's setting), and applies the SQL it generates with `wrangler d1 execute --remote`. It reuses the `CLOUDFLARE_API_TOKEN` secret that Preview and Deploy already need (see [deployment](deployment.md)), and skips with a warning if that secret is absent.

It lives in Actions rather than in the Worker because the pull needs a headless browser, which Workers can't run. Both `catalog.sql` and the raw `catalog.json` are kept as run artifacts for 14 days so a bad sync can be diagnosed after the fact.

To run it by hand:

```bash
node scripts/kaya-sync.mjs --gym movementboulder --sql catalog.sql --json catalog.json
npx wrangler d1 execute sendit-db --remote --yes --file=catalog.sql
```

Trigger the workflow ad hoc from the Actions tab; the `gym` input takes a KAYA gym slug.

## Linking a gym and importing

A gym shows no catalog until it points at one. On the **Gyms** screen, each unlinked gym offers a "link a route catalog…" picker listing whatever the sync has data for (`GET /api/catalogs`); choosing one sets `catalog_source` + `catalog_gym_id` and drops you straight into the import screen. Linked gyms get an "import routes" link and an "unlink" button — unlinking only clears the pointer, so routes already imported stay put.

A route you entered by hand can be pointed at a catalog climb after the fact: open the route and pick from the **KAYA climb** list, which offers unclaimed climbs matching the route's discipline, colour and grade, newest set first. Blank colour or grade fields leave that part unconstrained, and the search box narrows the matches further. Linking adopts the catalog's wall label, overwriting whatever you typed — unlinking does not restore it. One climb can be claimed by at most one route per gym, so a second attempt is refused.

The import screen groups the current inventory by wall, with a per-wall "select all" toggle. Entries already imported stay listed as checked and locked rather than vanishing, so the list keeps mirroring the wall in front of you. Importing creates one route per selected entry; importing something twice is a no-op.

`catalog_gym_id` is KAYA's numeric gym id (`211` for Movement Boulder), which `scripts/kaya-sync.mjs` logs on every run. The same pointer can be set over the API directly:

```bash
curl -X PATCH .../api/gyms/<gym-id> -H 'Authorization: Bearer <token>' \
  -d '{"catalog_source":"kaya","catalog_gym_id":"211"}'
```

## What the data looks like

Gym climbs on KAYA have **no names** — Movement doesn't name them. Identity is grade + colour + wall, so imported routes are created with `name = ''` and the client composes a label from those three fields. The wall labels match the signs in the gym (`B4 - The Cave`, `Grey Wall`, `South Horseshoe`).

Per climb the catalog stores grade, colour, wall, discipline, `source_updated_at` (see below), plus `first_seen_at` / `last_seen_at` from our own syncs. KAYA's `rating` and `ascent_count` are stored but not shown anywhere.

`source_updated_at` is KAYA's `date_updated`, surfaced in the UI as the **set date** — the only field that distinguishes two same-colour, same-grade climbs on one wall. It is setter-driven rather than activity-driven: on 2026-07-31, `B3 - West Wall Right` had all 7 of its climbs dated 07-30 (a wall reset), while `South Horseshoe` still had climbs dated 2026-02-27 despite 161 of 219 climbs having logged ascents. A setter editing a grade would also bump it, so treat it as "last set or edited", not a guaranteed set date. The gym's own display name is denormalized onto each row as `source_gym_name` so the catalog picker can label itself without a second source of gym metadata. A climb the sync stops seeing gets `removed_at` set rather than deleted, so a route you already imported keeps its provenance after the set is stripped. Stripped entries are hidden from `GET /api/gyms/:id/catalog` unless you pass `?removed=1`.

Re-running is safe: entries upsert on `(source, external_id)`, and importing an entry twice skips it rather than creating a duplicate route.

## Notes and limits

- The GraphQL endpoint caps `count` at 20 per query — 24 or more returns `Count Limit Exceeded`. The script pages at 20 with a 1.2s delay.
- Sustained rapid querying trips a separate `Error. Try again later.` throttle that clears in about a minute. Don't lower the delay.
- KAYA's own `route_count` for Movement Boulder has read higher than what the paged query returns (119 vs 111 on 2026-07-25) while `boulder_count` matched exactly. The cause is unconfirmed; the script logs both numbers so drift is visible.
- An unrecognized KAYA `climb_type` fails the run rather than being filed as a rope route by default.
- Nothing in the catalog identifies a climb on its own. Wall + grade + colour collide in practice, and KAYA exposes no position data — `GymMapWall` carries only ids across ~90 probed field names, and beta videos (1 of 219 climbs) and comment threads (1 of 219) are too rare to help. The set date is the best available tiebreaker; picking a climb is ultimately the user's judgement.
- KAYA's terms of service prohibit scraping and automated access. This is a personal-use, low-volume sync of one gym; don't republish the data or raise the frequency.
