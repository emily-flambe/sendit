# sendit

Route tracker for the climbing gym. Log attempts, keep project notes, and actually remember which pink one on the overhang shut you down last week.

Live at [sendit.emilycogsdill.com](https://sendit.emilycogsdill.com).

## Stack

Cloudflare Worker (Hono + D1) serving a vanilla TypeScript SPA built with Vite. Same general shape as the [workout tracker](https://github.com/emily-flambe/exercise-tracker-thingy).

## Development

```bash
npm install
npm run db:migrate:local   # apply migrations to the local D1 db
npm run dev                # vite build + wrangler dev on :8788
npm test                   # vitest (workers pool)
npm run typecheck
```

## Deploy

```bash
npm run db:migrate:remote
npm run deploy
```

Requires the `JWT_SECRET` worker secret (`wrangler secret put JWT_SECRET`).
