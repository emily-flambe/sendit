import { Hono } from 'hono';
import type { Env } from '../types';
import * as queries from '../db/queries';
import { authMiddleware } from '../middleware/auth';

export const PHOTO_CONTENT_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
export const MAX_PHOTOS_PER_ROUTE = 12;

const photos = new Hono<{ Bindings: Env }>();

photos.use('*', authMiddleware);

photos.get('/:id', async (c) => {
  const photo = await queries.getPhoto(c.env.DB, c.get('userId'), c.req.param('id'));
  if (!photo) {
    return c.json({ error: 'Photo not found' }, 404);
  }
  const object = await c.env.PHOTOS.get(photo.r2_key);
  if (!object) {
    return c.json({ error: 'Photo not found' }, 404);
  }
  return c.body(object.body, 200, {
    'Content-Type': photo.content_type,
    'Content-Length': String(photo.size),
    // Photos are immutable (delete + re-upload, never edit), so cache hard.
    'Cache-Control': 'private, max-age=31536000, immutable',
  });
});

photos.delete('/:id', async (c) => {
  const photo = await queries.getPhoto(c.env.DB, c.get('userId'), c.req.param('id'));
  if (!photo) {
    return c.json({ error: 'Photo not found' }, 404);
  }
  await queries.deletePhoto(c.env.DB, photo.id);
  await c.env.PHOTOS.delete(photo.r2_key);
  return c.json({ success: true });
});

export default photos;
