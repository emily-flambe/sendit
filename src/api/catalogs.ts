import { Hono } from 'hono';
import type { Env } from '../env';
import * as queries from '../db/queries';
import { authMiddleware } from '../middleware/auth';

// Which external catalogs the sync has data for. Gym-agnostic: this is the
// menu the user picks from when linking one of their gyms to a catalog.
const catalogs = new Hono<{ Bindings: Env }>();

catalogs.use('*', authMiddleware);

catalogs.get('/', async (c) => {
  const sources = await queries.listCatalogSources(c.env.DB);
  return c.json({ sources });
});

export default catalogs;
