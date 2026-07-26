import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../env';
import * as queries from '../db/queries';
import { MAX_CATALOG_IMPORT } from '../limits';
import { authMiddleware } from '../middleware/auth';
import { defaultRouteName } from './routes';

const gymSchema = z.object({
  name: z.string().trim().min(1).max(120),
  notes: z.string().max(2000).default(''),
});

const gymPatchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  notes: z.string().max(2000).optional(),
  archived: z.union([z.literal(0), z.literal(1)]).optional(),
  // Link the gym to an external catalog, or clear it with empty strings.
  catalog_source: z.enum(['', 'kaya']).optional(),
  catalog_gym_id: z.string().trim().max(64).optional(),
});

const catalogImportSchema = z.object({
  catalog_ids: z.array(z.string().trim().min(1)).min(1).max(MAX_CATALOG_IMPORT),
});

const routeSchema = z.object({
  name: z.string().trim().max(120).default(''),
  grade: z.string().trim().max(32).default(''),
  color: z.string().trim().max(32).default(''),
  wall: z.string().trim().max(120).default(''),
  discipline: z.enum(['boulder', 'route']).default('route'),
  notes: z.string().max(4000).default(''),
});

const gyms = new Hono<{ Bindings: Env }>();

gyms.use('*', authMiddleware);

gyms.get('/', async (c) => {
  const includeArchived = c.req.query('archived') === '1';
  const result = await queries.listGyms(c.env.DB, c.get('userId'), includeArchived);
  return c.json({ gyms: result });
});

gyms.post('/', async (c) => {
  const parsed = gymSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'Gym needs a name' }, 400);
  }
  const gym = await queries.createGym(c.env.DB, c.get('userId'), parsed.data.name, parsed.data.notes);
  return c.json({ gym }, 201);
});

gyms.patch('/:id', async (c) => {
  const parsed = gymPatchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'Invalid gym fields' }, 400);
  }
  const gym = await queries.updateGym(c.env.DB, c.get('userId'), c.req.param('id'), parsed.data);
  if (!gym) {
    return c.json({ error: 'Gym not found' }, 404);
  }
  return c.json({ gym });
});

gyms.get('/:id/routes', async (c) => {
  const gym = await queries.getGym(c.env.DB, c.get('userId'), c.req.param('id'));
  if (!gym) {
    return c.json({ error: 'Gym not found' }, 404);
  }
  const includeArchived = c.req.query('archived') === '1';
  const routes = await queries.listRoutes(c.env.DB, c.get('userId'), { gymId: gym.id, includeArchived });
  return c.json({ routes });
});

gyms.post('/:id/routes', async (c) => {
  const gym = await queries.getGym(c.env.DB, c.get('userId'), c.req.param('id'));
  if (!gym) {
    return c.json({ error: 'Gym not found' }, 404);
  }
  const parsed = routeSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'Invalid route fields' }, 400);
  }
  if (!parsed.data.name) {
    parsed.data.name = defaultRouteName(parsed.data.color, parsed.data.grade);
  }
  const route = await queries.createRoute(c.env.DB, gym.id, parsed.data);
  return c.json({ route }, 201);
});

// What the gym's linked catalog currently has set. Empty for a gym with no
// catalog link, which is not an error — the client just shows nothing to import.
gyms.get('/:id/catalog', async (c) => {
  const gym = await queries.getGym(c.env.DB, c.get('userId'), c.req.param('id'));
  if (!gym) {
    return c.json({ error: 'Gym not found' }, 404);
  }
  const includeRemoved = c.req.query('removed') === '1';
  const catalog = await queries.listGymCatalog(c.env.DB, gym, { includeRemoved });
  return c.json({ catalog });
});

gyms.post('/:id/catalog/import', async (c) => {
  const gym = await queries.getGym(c.env.DB, c.get('userId'), c.req.param('id'));
  if (!gym) {
    return c.json({ error: 'Gym not found' }, 404);
  }
  if (!gym.catalog_source || !gym.catalog_gym_id) {
    return c.json({ error: 'Gym is not linked to a catalog' }, 400);
  }
  const parsed = catalogImportSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'Invalid catalog ids' }, 400);
  }
  const { routes, skipped } = await queries.importCatalogEntries(c.env.DB, gym, parsed.data.catalog_ids);
  return c.json({ routes, skipped }, 201);
});

export default gyms;
