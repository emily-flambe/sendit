import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../types';
import { hashPassword, verifyPassword, createToken } from '../auth';
import { createUser, getUserByUsername, getUserById } from '../db/queries';
import { authMiddleware } from '../middleware/auth';

const credentialsSchema = z.object({
  username: z.string().trim().min(3).max(64),
  password: z.string().min(8).max(256),
});

const auth = new Hono<{ Bindings: Env }>();

auth.post('/register', async (c) => {
  const parsed = credentialsSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'Username must be 3+ characters and password 8+ characters' }, 400);
  }
  const { username, password } = parsed.data;

  const existing = await getUserByUsername(c.env.DB, username);
  if (existing) {
    return c.json({ error: 'Username already taken' }, 400);
  }

  const user = await createUser(c.env.DB, username, await hashPassword(password));
  const token = await createToken(user.id, c.env.JWT_SECRET);
  return c.json({ token, user }, 201);
});

auth.post('/login', async (c) => {
  const parsed = credentialsSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'Invalid username or password' }, 401);
  }

  const row = await getUserByUsername(c.env.DB, parsed.data.username);
  if (!row || !(await verifyPassword(parsed.data.password, row.password_hash))) {
    return c.json({ error: 'Invalid username or password' }, 401);
  }

  const token = await createToken(row.id, c.env.JWT_SECRET);
  return c.json({ token, user: { id: row.id, username: row.username, created_at: row.created_at } });
});

auth.get('/me', authMiddleware, async (c) => {
  const user = await getUserById(c.env.DB, c.get('userId'));
  if (!user) {
    return c.json({ error: 'User not found' }, 404);
  }
  return c.json({ user });
});

export default auth;
