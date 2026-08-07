import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../env';
import * as queries from '../db/queries';
import { authMiddleware } from '../middleware/auth';
import { requestCatalogSync } from '../sync-trigger';

// Which external catalogs the app knows about. Gym-agnostic: this is the
// menu the user picks from when linking one of their gyms to a catalog.
const catalogs = new Hono<{ Bindings: Env }>();

// A slug is the last path segment of a gym's URL: kayaclimb.com/gym/thespotboulder.
const addSchema = z.object({
  source: z.enum(['kaya']).default('kaya'),
  slug: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .regex(/^[a-z0-9][a-z0-9-]*$/i, 'A KAYA slug looks like "thespotboulder" — letters, digits and dashes only'),
});

catalogs.use('*', authMiddleware);

catalogs.get('/', async (c) => {
  const sources = await queries.listCatalogSources(c.env.DB);
  return c.json({ sources });
});

// Registers a gym to sync. The Worker can't confirm the slug (KAYA rejects
// non-browser clients), so the row starts pending and the sync job is asked to
// run now; a failed trigger still leaves the gym for the nightly run.
catalogs.post('/', async (c) => {
  const parsed = addSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid slug' }, 400);
  }
  const { source, slug } = parsed.data;
  const catalog = await queries.addCatalogGym(c.env.DB, source, slug.toLowerCase());
  const sync = await requestCatalogSync(c.env, catalog.slug);
  return c.json({ catalog, sync }, 201);
});

export default catalogs;
