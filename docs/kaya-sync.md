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

## Linking a gym

A gym shows no catalog until it points at one. Set both fields on the gym:

```bash
curl -X PATCH .../api/gyms/<gym-id> -H 'Authorization: Bearer <token>' \
  -d '{"catalog_source":"kaya","catalog_gym_id":"211"}'
```

`catalog_gym_id` is KAYA's numeric gym id (`211` for Movement Boulder), which `scripts/kaya-sync.mjs` logs on every run. Setting both to `""` unlinks the gym.

## What the data looks like

Gym climbs on KAYA have **no names** — Movement doesn't name them. Identity is grade + colour + wall, so imported routes are created with `name = ''` and the client composes a label from those three fields. The wall labels match the signs in the gym (`B4 - The Cave`, `Grey Wall`, `South Horseshoe`).

Per climb the catalog stores grade, colour, wall, discipline, KAYA's community `rating` and `ascent_count`, plus `first_seen_at` / `last_seen_at`. A climb the sync stops seeing gets `removed_at` set rather than deleted, so a route you already imported keeps its provenance after the set is stripped. Stripped entries are hidden from `GET /api/gyms/:id/catalog` unless you pass `?removed=1`.

Re-running is safe: entries upsert on `(source, external_id)`, and importing an entry twice skips it rather than creating a duplicate route.

## Notes and limits

- The GraphQL endpoint caps `count` at 20 per query — 24 or more returns `Count Limit Exceeded`. The script pages at 20 with a 1.2s delay.
- Sustained rapid querying trips a separate `Error. Try again later.` throttle that clears in about a minute. Don't lower the delay.
- KAYA's own `route_count` for Movement Boulder has read higher than what the paged query returns (119 vs 111 on 2026-07-25) while `boulder_count` matched exactly. The cause is unconfirmed; the script logs both numbers so drift is visible.
- An unrecognized KAYA `climb_type` fails the run rather than being filed as a rope route by default.
- KAYA's terms of service prohibit scraping and automated access. This is a personal-use, low-volume sync of one gym; don't republish the data or raise the frequency.
