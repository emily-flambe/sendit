import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../types';
import * as queries from '../db/queries';
import { authMiddleware } from '../middleware/auth';

const attemptPatchSchema = z.object({
  attempted_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  result: z.enum(['send', 'attempt']).optional(),
  high_point: z.string().trim().max(200).optional(),
  notes: z.string().max(4000).optional(),
});

const attempts = new Hono<{ Bindings: Env }>();

attempts.use('*', authMiddleware);

attempts.patch('/:id', async (c) => {
  const parsed = attemptPatchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'Invalid attempt fields' }, 400);
  }
  const attempt = await queries.updateAttempt(c.env.DB, c.get('userId'), c.req.param('id'), parsed.data);
  if (!attempt) {
    return c.json({ error: 'Attempt not found' }, 404);
  }
  return c.json({ attempt });
});

attempts.delete('/:id', async (c) => {
  const deleted = await queries.deleteAttempt(c.env.DB, c.get('userId'), c.req.param('id'));
  if (!deleted) {
    return c.json({ error: 'Attempt not found' }, 404);
  }
  return c.json({ success: true });
});

export default attempts;
