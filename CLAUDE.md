# CLAUDE.md

Route tracker on a Cloudflare Worker (Hono + D1 + R2) serving a vanilla-TS Vite SPA. See `README.md` for stack and local dev.

## Docs

- Deployment (CI/CD, previews, secrets): `docs/deployment.md`
- Feature designs: `docs/plans/`

## Conventions

- Every change ships through a PR; CI must be green before merge (see `docs/deployment.md`).
- New persisted fields need the full write path wired (migration, API schema, query, types) plus a test — allowlisted field maps drop unknown fields silently.
