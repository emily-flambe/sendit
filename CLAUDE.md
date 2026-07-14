# CLAUDE.md

Route tracker on a Cloudflare Worker (Hono + D1 + R2) serving a vanilla-TS Vite SPA. See `README.md` for stack and local dev.

## Docs

- Deployment (CI/CD, previews, secrets): `docs/deployment.md`
- Feature designs: `docs/plans/`

## Conventions

- Every change ships through a PR; CI must be green before merge (see `docs/deployment.md`).
- New persisted fields need the full write path wired (migration, API schema, query, types) plus a test — allowlisted field maps drop unknown fields silently.

## Testing

- Durable test account for manual/agent verification (local and prod): `claude-test` / `sendit-claude-test-2026`. Register it if the environment doesn't have it yet; reuse it instead of creating throwaway users. Test data under it can stay, but keep it minimal and obviously test-named.
