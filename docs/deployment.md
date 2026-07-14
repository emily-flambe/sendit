# Deployment

sendit runs as a single Cloudflare Worker (Hono API + static SPA assets) backed by a D1 database and an R2 bucket. Deploys are automated through GitHub Actions (`.github/workflows/ci.yml`); the manual `npm run deploy` path still works as a fallback.

## Pipeline overview

The `CI` workflow runs on every PR and on pushes to `main`.

| Job | Runs on | What it does |
|-----|---------|--------------|
| **Unit Tests** | PR + `main` | typecheck, vitest (workers pool), frontend build |
| **E2E Tests** | PR + `main` | Playwright smoke test against a local `wrangler dev` |
| **Preview Deploy** | PR only | `wrangler versions upload` → unique preview URL, posted as a sticky PR comment |
| **Deploy** | `main` only | applies D1 migrations, `wrangler deploy`, then curls the prod health endpoint |

`Deploy` needs `Unit Tests` and `E2E Tests` to pass first. Preview and Deploy both no-op with a warning if the `CLOUDFLARE_API_TOKEN` secret is missing, so tests still run on forks without deploy access.

## Preview deployments

Every PR uploads a Worker *version* (not a production deploy) via `wrangler versions upload`. This produces a unique URL like `https://<version>-sendit.emily-cogsdill.workers.dev` without shifting production traffic. A sticky comment (marker `<!-- sendit-preview -->`) is created or updated on the PR with the current URL.

Previews share the **production** D1 database and R2 bucket. Migrations added in a PR are **not** applied to the preview — they run only in the `main` Deploy job after merge. Keep that in mind when a PR's code depends on a new column: the preview will hit prod's current schema.

## Production deploys

On merge to `main`, the Deploy job:

1. `wrangler d1 migrations apply sendit-db --remote` — applies any new files in `migrations/`.
2. `wrangler deploy` — builds the frontend and publishes the Worker.
3. `curl https://sendit.emilycogsdill.com/api/health` — fails the job if prod isn't healthy.

Migrations run before the deploy so the schema is ready when new code goes live. Additive migrations (new tables/columns) are safe under this order; a destructive migration would need to be split across two PRs (add-and-backfill, then remove) so old code isn't serving against a dropped column.

## Manual deploy (fallback)

```bash
npm run db:migrate:remote   # wrangler d1 migrations apply sendit-db --remote
npm run deploy              # vite build + wrangler deploy
```

Use this if the pipeline is down or the deploy secret isn't configured.

## Secrets and configuration

**Worker runtime secret** (set once, per environment):

```bash
wrangler secret put JWT_SECRET
```

`JWT_SECRET` signs auth tokens; the app fails auth without it. It is not in `wrangler.toml` and is not needed by CI (unit tests inject a test value via `vitest.config.ts`; the e2e server passes a throwaway `--var JWT_SECRET`).

**GitHub Actions secret** (enables Preview + Deploy):

- `CLOUDFLARE_API_TOKEN` — a Cloudflare API token scoped to the personal account with **Workers Scripts: Edit** and **D1: Edit**. Set with:

  ```bash
  gh secret set CLOUDFLARE_API_TOKEN --repo emily-flambe/sendit
  ```

  Mint or edit the token at Cloudflare dashboard → My Profile → API Tokens. Workers-only tokens deploy the Worker but fail the migration step (D1 is required); include both permissions.

Bindings (`DB`, `PHOTOS`) and the D1 database id live in `wrangler.toml` and are not secret.
