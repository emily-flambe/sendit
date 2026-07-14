import { Hono } from 'hono';
import { z } from 'zod';
import type { Context } from 'hono';
import type { Env } from '../types';
import * as queries from '../db/queries';
import { transformMarkers, type EditTransform } from '../markers';
import { authMiddleware } from '../middleware/auth';

export const PHOTO_CONTENT_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
export const MAX_PHOTOS_PER_ROUTE = 12;

type UploadError = { error: string; status: 400 | 413 };
type Upload = { contentType: string; body: ArrayBuffer };

export async function readPhotoUpload(c: Context<{ Bindings: Env }>): Promise<Upload | UploadError> {
  const contentType = (c.req.header('Content-Type') ?? '').split(';')[0].trim().toLowerCase();
  if (!PHOTO_CONTENT_TYPES.has(contentType)) {
    return { error: 'Unsupported image type', status: 400 };
  }
  const declaredLength = Number(c.req.header('Content-Length') ?? 0);
  if (declaredLength > MAX_PHOTO_BYTES) {
    return { error: 'Photo too large (10 MB max)', status: 413 };
  }
  const body = await c.req.arrayBuffer();
  if (body.byteLength === 0) {
    return { error: 'Empty upload', status: 400 };
  }
  if (body.byteLength > MAX_PHOTO_BYTES) {
    return { error: 'Photo too large (10 MB max)', status: 413 };
  }
  return { contentType, body };
}

export function photoR2Key(photoId: string): string {
  // Revisioned key: an edit-overwrite writes a fresh object, so the old one
  // can be deleted without racing readers of the previous URL.
  return `photos/${photoId}/${Date.now()}`;
}

const editQuerySchema = z.object({
  mode: z.enum(['overwrite', 'new']),
  rotate: z.coerce.number().int().min(0).max(3).default(0),
  crop_x: z.coerce.number().min(0).max(1).default(0),
  crop_y: z.coerce.number().min(0).max(1).default(0),
  crop_w: z.coerce.number().gt(0).max(1).default(1),
  crop_h: z.coerce.number().gt(0).max(1).default(1),
  width: z.coerce.number().int().positive(),
  height: z.coerce.number().int().positive(),
});

const photos = new Hono<{ Bindings: Env }>();

photos.use('*', authMiddleware);

photos.get('/', async (c) => {
  const gym = c.req.query('gym') ?? null;
  const result = await queries.listGalleryPhotos(c.env.DB, c.get('userId'), gym);
  return c.json({ photos: result });
});

photos.post('/', async (c) => {
  const gymId = c.req.query('gym') || null;
  if (gymId && !(await queries.getGym(c.env.DB, c.get('userId'), gymId))) {
    return c.json({ error: 'Gym not found' }, 404);
  }
  const upload = await readPhotoUpload(c);
  if ('error' in upload) {
    return c.json({ error: upload.error }, upload.status);
  }
  const photoId = crypto.randomUUID();
  const r2Key = photoR2Key(photoId);
  await c.env.PHOTOS.put(r2Key, upload.body, { httpMetadata: { contentType: upload.contentType } });
  const photo = await queries.createPhoto(c.env.DB, c.get('userId'), gymId, {
    id: photoId,
    r2_key: r2Key,
    content_type: upload.contentType,
    size: upload.body.byteLength,
  });
  return c.json({ photo }, 201);
});

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
    // Edits write a new r2_key and bump updated_at, and clients fetch with a
    // ?v=updated_at param — so a given URL's bytes never change. Cache hard.
    'Cache-Control': 'private, max-age=31536000, immutable',
  });
});

photos.get('/:id/info', async (c) => {
  const photo = await queries.getPhoto(c.env.DB, c.get('userId'), c.req.param('id'));
  if (!photo) {
    return c.json({ error: 'Photo not found' }, 404);
  }
  const routes = await queries.listLinkedRoutes(c.env.DB, c.get('userId'), photo.id);
  return c.json({ photo, routes });
});

photos.patch('/:id', async (c) => {
  const photo = await queries.getPhoto(c.env.DB, c.get('userId'), c.req.param('id'));
  if (!photo) {
    return c.json({ error: 'Photo not found' }, 404);
  }
  const parsed = z
    .object({ gym_id: z.string().trim().min(1).nullable() })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'Invalid photo fields' }, 400);
  }
  if (parsed.data.gym_id && !(await queries.getGym(c.env.DB, c.get('userId'), parsed.data.gym_id))) {
    return c.json({ error: 'Gym not found' }, 404);
  }
  await queries.updatePhotoGym(c.env.DB, photo.id, parsed.data.gym_id);
  return c.json({ photo: { ...photo, gym_id: parsed.data.gym_id } });
});

// Cropped/rotated pixels are produced client-side; this endpoint stores them
// and (in overwrite mode) remaps every annotation drawn on the photo through
// the same geometric transform so markers stay glued to their holds.
photos.post('/:id/edit', async (c) => {
  const photo = await queries.getPhoto(c.env.DB, c.get('userId'), c.req.param('id'));
  if (!photo) {
    return c.json({ error: 'Photo not found' }, 404);
  }
  const parsedQuery = editQuerySchema.safeParse(c.req.query());
  if (!parsedQuery.success) {
    return c.json({ error: 'Invalid edit parameters' }, 400);
  }
  const q = parsedQuery.data;
  if (q.crop_x + q.crop_w > 1 || q.crop_y + q.crop_h > 1) {
    return c.json({ error: 'Invalid edit parameters' }, 400);
  }
  const upload = await readPhotoUpload(c);
  if ('error' in upload) {
    return c.json({ error: upload.error }, upload.status);
  }

  if (q.mode === 'new') {
    const photoId = crypto.randomUUID();
    const r2Key = photoR2Key(photoId);
    await c.env.PHOTOS.put(r2Key, upload.body, { httpMetadata: { contentType: upload.contentType } });
    const created = await queries.createPhoto(c.env.DB, c.get('userId'), photo.gym_id, {
      id: photoId,
      r2_key: r2Key,
      content_type: upload.contentType,
      size: upload.body.byteLength,
    });
    return c.json({ photo: created }, 201);
  }

  const edit: EditTransform = {
    rotate: q.rotate as EditTransform['rotate'],
    crop: { x: q.crop_x, y: q.crop_y, w: q.crop_w, h: q.crop_h },
    width: q.width,
    height: q.height,
  };

  const oldKey = photo.r2_key;
  const r2Key = photoR2Key(photo.id);
  await c.env.PHOTOS.put(r2Key, upload.body, { httpMetadata: { contentType: upload.contentType } });
  const updatedAt = await queries.overwritePhoto(c.env.DB, photo.id, {
    r2_key: r2Key,
    content_type: upload.contentType,
    size: upload.body.byteLength,
  });
  await c.env.PHOTOS.delete(oldKey);

  const annotations = await queries.listRouteImagesByPhoto(c.env.DB, photo.id);
  for (const annotation of annotations) {
    const remapped = transformMarkers(annotation.markers, edit);
    if (remapped.length > 0) {
      await queries.setRouteImageMarkers(c.env.DB, annotation.route_id, remapped);
    } else {
      // Every marker was cropped out — the annotation no longer exists.
      await queries.deleteRouteImageRow(c.env.DB, annotation.route_id);
    }
  }

  return c.json({
    photo: {
      ...photo,
      r2_key: r2Key,
      content_type: upload.contentType,
      size: upload.body.byteLength,
      updated_at: updatedAt,
    },
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
