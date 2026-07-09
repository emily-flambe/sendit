import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../types';
import * as queries from '../db/queries';
import { authMiddleware } from '../middleware/auth';

const routePatchSchema = z.object({
  name: z.string().trim().max(120).optional(),
  grade: z.string().trim().max(32).optional(),
  color: z.string().trim().max(32).optional(),
  wall: z.string().trim().max(120).optional(),
  discipline: z.enum(['boulder', 'top_rope', 'lead', 'autobelay']).optional(),
  notes: z.string().max(4000).optional(),
  archived: z.union([z.literal(0), z.literal(1)]).optional(),
});

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

const attemptSchema = z.object({
  attempted_on: dateString,
  result: z.enum(['send', 'attempt']),
  high_point: z.string().trim().max(200).default(''),
  notes: z.string().max(4000).default(''),
});

const routes = new Hono<{ Bindings: Env }>();

routes.use('*', authMiddleware);

routes.get('/:id', async (c) => {
  const route = await queries.getRoute(c.env.DB, c.get('userId'), c.req.param('id'));
  if (!route) {
    return c.json({ error: 'Route not found' }, 404);
  }
  const attempts = await queries.listAttempts(c.env.DB, c.get('userId'), route.id);
  return c.json({ route, attempts });
});

routes.patch('/:id', async (c) => {
  const parsed = routePatchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'Invalid route fields' }, 400);
  }
  const route = await queries.updateRoute(c.env.DB, c.get('userId'), c.req.param('id'), parsed.data);
  if (!route) {
    return c.json({ error: 'Route not found' }, 404);
  }
  return c.json({ route });
});

routes.delete('/:id', async (c) => {
  const deleted = await queries.deleteRoute(c.env.DB, c.get('userId'), c.req.param('id'));
  if (!deleted) {
    return c.json({ error: 'Route not found' }, 404);
  }
  return c.json({ success: true });
});

routes.post('/:id/attempts', async (c) => {
  const route = await queries.getRoute(c.env.DB, c.get('userId'), c.req.param('id'));
  if (!route) {
    return c.json({ error: 'Route not found' }, 404);
  }
  const parsed = attemptSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'Invalid attempt fields' }, 400);
  }
  const attempt = await queries.createAttempt(c.env.DB, route.id, parsed.data);
  return c.json({ attempt }, 201);
});

export default routes;
