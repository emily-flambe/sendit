import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../types';
import * as queries from '../db/queries';
import { authMiddleware } from '../middleware/auth';
import { MAX_PHOTOS_PER_ROUTE, photoR2Key, readPhotoUpload } from './photos';

const routePatchSchema = z.object({
  name: z.string().trim().max(120).optional(),
  grade: z.string().trim().max(32).optional(),
  color: z.string().trim().max(32).optional(),
  wall: z.string().trim().max(120).optional(),
  discipline: z.enum(['boulder', 'top_rope', 'lead', 'autobelay']).optional(),
  notes: z.string().max(4000).optional(),
  archived: z.union([z.literal(0), z.literal(1)]).optional(),
  gym_id: z.string().trim().min(1).optional(),
});

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

export const MAX_ROUTE_IMAGE_MARKERS = 100;

// Markers are normalized to the image (x/y in [0,1], r as fraction of width).
const markerSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  r: z.number().gt(0).max(0.25),
});

const routeImageSchema = z.object({
  photo_id: z.string().trim().min(1),
  markers: z.array(markerSchema).min(1).max(MAX_ROUTE_IMAGE_MARKERS),
});

const attemptSchema = z.object({
  attempted_on: dateString,
  result: z.enum(['send', 'attempt']),
  flashed: z.union([z.literal(0), z.literal(1)]).default(0),
  high_point: z.string().trim().max(200).default(''),
  notes: z.string().max(4000).default(''),
});

export function defaultRouteName(color: string, grade: string): string {
  const bits = [color, grade].filter(Boolean).join(' ');
  return `${bits || 'Route'} added on ${new Date().toISOString().slice(0, 10)}`;
}

const routes = new Hono<{ Bindings: Env }>();

routes.use('*', authMiddleware);

routes.get('/', async (c) => {
  const includeArchived = c.req.query('archived') === '1';
  const result = await queries.listAllRoutes(c.env.DB, c.get('userId'), includeArchived);
  return c.json({ routes: result });
});

routes.get('/:id', async (c) => {
  const route = await queries.getRoute(c.env.DB, c.get('userId'), c.req.param('id'));
  if (!route) {
    return c.json({ error: 'Route not found' }, 404);
  }
  const attempts = await queries.listAttempts(c.env.DB, c.get('userId'), route.id);
  const photos = await queries.listRoutePhotos(c.env.DB, c.get('userId'), route.id);
  const route_image = await queries.getRouteImage(c.env.DB, c.get('userId'), route.id);
  return c.json({ route, attempts, photos, route_image });
});

routes.put('/:id/image', async (c) => {
  const route = await queries.getRoute(c.env.DB, c.get('userId'), c.req.param('id'));
  if (!route) {
    return c.json({ error: 'Route not found' }, 404);
  }
  const parsed = routeImageSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'Invalid route image fields' }, 400);
  }
  const photo = await queries.getPhoto(c.env.DB, c.get('userId'), parsed.data.photo_id);
  if (!photo || !(await queries.isPhotoLinked(c.env.DB, route.id, photo.id))) {
    return c.json({ error: 'Photo not found on this route' }, 404);
  }
  const route_image = await queries.upsertRouteImage(c.env.DB, route.id, photo.id, parsed.data.markers);
  return c.json({ route_image });
});

routes.delete('/:id/image', async (c) => {
  const deleted = await queries.deleteRouteImage(c.env.DB, c.get('userId'), c.req.param('id'));
  if (!deleted) {
    return c.json({ error: 'Route image not found' }, 404);
  }
  return c.json({ success: true });
});

routes.patch('/:id', async (c) => {
  const parsed = routePatchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'Invalid route fields' }, 400);
  }
  if (parsed.data.gym_id && !(await queries.getGym(c.env.DB, c.get('userId'), parsed.data.gym_id))) {
    return c.json({ error: 'Gym not found' }, 404);
  }
  const route = await queries.updateRoute(c.env.DB, c.get('userId'), c.req.param('id'), parsed.data);
  if (!route) {
    return c.json({ error: 'Route not found' }, 404);
  }
  return c.json({ route });
});

routes.delete('/:id', async (c) => {
  // Photos live in the gallery, not on the route — deleting a route only
  // cascades its links and annotation, never photo bytes.
  const deleted = await queries.deleteRoute(c.env.DB, c.get('userId'), c.req.param('id'));
  if (!deleted) {
    return c.json({ error: 'Route not found' }, 404);
  }
  return c.json({ success: true });
});

// Upload a new photo straight onto a route: creates a gallery photo tagged
// with the route's gym, then links it.
routes.post('/:id/photos', async (c) => {
  const route = await queries.getRoute(c.env.DB, c.get('userId'), c.req.param('id'));
  if (!route) {
    return c.json({ error: 'Route not found' }, 404);
  }
  if ((await queries.countRoutePhotoLinks(c.env.DB, route.id)) >= MAX_PHOTOS_PER_ROUTE) {
    return c.json({ error: `Route already has ${MAX_PHOTOS_PER_ROUTE} photos` }, 400);
  }
  const upload = await readPhotoUpload(c);
  if ('error' in upload) {
    return c.json({ error: upload.error }, upload.status);
  }

  const photoId = crypto.randomUUID();
  const r2Key = photoR2Key(photoId);
  await c.env.PHOTOS.put(r2Key, upload.body, { httpMetadata: { contentType: upload.contentType } });
  const photo = await queries.createPhoto(c.env.DB, c.get('userId'), route.gym_id, {
    id: photoId,
    r2_key: r2Key,
    content_type: upload.contentType,
    size: upload.body.byteLength,
  });
  await queries.linkPhoto(c.env.DB, route.id, photo.id);
  return c.json({ photo }, 201);
});

// Link an existing gallery photo to a route.
routes.put('/:id/photos/:photoId', async (c) => {
  const route = await queries.getRoute(c.env.DB, c.get('userId'), c.req.param('id'));
  if (!route) {
    return c.json({ error: 'Route not found' }, 404);
  }
  const photo = await queries.getPhoto(c.env.DB, c.get('userId'), c.req.param('photoId'));
  if (!photo) {
    return c.json({ error: 'Photo not found' }, 404);
  }
  if (!(await queries.isPhotoLinked(c.env.DB, route.id, photo.id))) {
    if ((await queries.countRoutePhotoLinks(c.env.DB, route.id)) >= MAX_PHOTOS_PER_ROUTE) {
      return c.json({ error: `Route already has ${MAX_PHOTOS_PER_ROUTE} photos` }, 400);
    }
    await queries.linkPhoto(c.env.DB, route.id, photo.id);
  }
  return c.json({ photo });
});

// Unlink a photo from a route. The photo stays in the gallery; the route's
// annotation survives too if it was drawn on this photo (it still renders).
routes.delete('/:id/photos/:photoId', async (c) => {
  const route = await queries.getRoute(c.env.DB, c.get('userId'), c.req.param('id'));
  if (!route) {
    return c.json({ error: 'Route not found' }, 404);
  }
  const unlinked = await queries.unlinkPhoto(c.env.DB, route.id, c.req.param('photoId'));
  if (!unlinked) {
    return c.json({ error: 'Photo not linked to this route' }, 404);
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
