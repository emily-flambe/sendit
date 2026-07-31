import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import app from './index';

type Json = Record<string, any>;

async function call(method: string, path: string, body?: unknown, token?: string) {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await app.request(
    path,
    { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined },
    env
  );
  return { status: res.status, data: (await res.json()) as Json };
}

async function registerUser(username: string): Promise<string> {
  const { status, data } = await call('POST', '/api/auth/register', { username, password: 'password123' });
  expect(status).toBe(201);
  return data.token as string;
}

describe('health', () => {
  it('responds without auth', async () => {
    const { status, data } = await call('GET', '/api/health');
    expect(status).toBe(200);
    expect(data.status).toBe('ok');
  });
});

describe('auth', () => {
  it('registers and logs in', async () => {
    const token = await registerUser('alice');
    expect(token).toBeTruthy();

    const login = await call('POST', '/api/auth/login', { username: 'alice', password: 'password123' });
    expect(login.status).toBe(200);
    expect(login.data.user.username).toBe('alice');

    const me = await call('GET', '/api/auth/me', undefined, login.data.token);
    expect(me.status).toBe(200);
    expect(me.data.user.username).toBe('alice');
  });

  it('rejects duplicate usernames', async () => {
    await registerUser('bob');
    const dup = await call('POST', '/api/auth/register', { username: 'bob', password: 'password123' });
    expect(dup.status).toBe(400);
  });

  it('rejects bad passwords', async () => {
    await registerUser('carol');
    const bad = await call('POST', '/api/auth/login', { username: 'carol', password: 'wrong-password' });
    expect(bad.status).toBe(401);
  });

  it('rejects short passwords on register', async () => {
    const { status } = await call('POST', '/api/auth/register', { username: 'dave', password: 'short' });
    expect(status).toBe(400);
  });
});

describe('authorization', () => {
  it('blocks unauthenticated access to gyms, routes, and attempts', async () => {
    for (const [method, path] of [
      ['GET', '/api/gyms'],
      ['POST', '/api/gyms'],
      ['GET', '/api/routes/xyz'],
      ['PATCH', '/api/attempts/xyz'],
    ] as const) {
      const { status } = await call(method, path, method === 'GET' ? undefined : {});
      expect(status, `${method} ${path}`).toBe(401);
    }
  });

  it("hides one user's data from another", async () => {
    const tokenA = await registerUser('owner');
    const tokenB = await registerUser('snoop');

    const gym = await call('POST', '/api/gyms', { name: 'Secret Crag' }, tokenA);
    const route = await call('POST', `/api/gyms/${gym.data.gym.id}/routes`, { grade: 'V5' }, tokenA);

    const gymPeek = await call('GET', `/api/gyms/${gym.data.gym.id}/routes`, undefined, tokenB);
    expect(gymPeek.status).toBe(404);

    const routePeek = await call('GET', `/api/routes/${route.data.route.id}`, undefined, tokenB);
    expect(routePeek.status).toBe(404);

    const routeEdit = await call('PATCH', `/api/routes/${route.data.route.id}`, { grade: 'V0' }, tokenB);
    expect(routeEdit.status).toBe(404);
  });
});

describe('gyms and routes', () => {
  let token: string;
  let gymId: string;

  beforeAll(async () => {
    token = await registerUser('climber');
    const gym = await call('POST', '/api/gyms', { name: 'Main Gym' }, token);
    gymId = gym.data.gym.id;
  });

  it('creates and lists routes with attempt rollups', async () => {
    const created = await call(
      'POST',
      `/api/gyms/${gymId}/routes`,
      { grade: 'V4', color: 'pink', wall: 'Overhang' },
      token
    );
    expect(created.status).toBe(201);
    const routeId = created.data.route.id as string;

    const attempt = await call(
      'POST',
      `/api/routes/${routeId}/attempts`,
      { attempted_on: '2026-07-01', result: 'attempt', high_point: 'past the crux' },
      token
    );
    expect(attempt.status).toBe(201);

    const send = await call(
      'POST',
      `/api/routes/${routeId}/attempts`,
      { attempted_on: '2026-07-08', result: 'send' },
      token
    );
    expect(send.status).toBe(201);

    const list = await call('GET', `/api/gyms/${gymId}/routes`, undefined, token);
    expect(list.status).toBe(200);
    const row = list.data.routes.find((r: Json) => r.id === routeId);
    expect(row.attempt_count).toBe(2);
    expect(row.send_count).toBe(1);
    expect(row.last_attempted_on).toBe('2026-07-08');
  });

  it('records climb type per attempt and defaults it by route type', async () => {
    // Roped route: climb type defaults to top rope; an explicit value sticks.
    const rope = await call('POST', `/api/gyms/${gymId}/routes`, { grade: '5.10a' }, token);
    expect(rope.data.route.discipline).toBe('route');
    const ropeId = rope.data.route.id as string;

    const tr = await call(
      'POST',
      `/api/routes/${ropeId}/attempts`,
      { attempted_on: '2026-07-01', result: 'attempt' },
      token
    );
    expect(tr.data.attempt.climb_type).toBe('top_rope');

    const lead = await call(
      'POST',
      `/api/routes/${ropeId}/attempts`,
      { attempted_on: '2026-07-02', result: 'send', climb_type: 'lead' },
      token
    );
    expect(lead.data.attempt.climb_type).toBe('lead');

    // Boulder: climb type is forced empty even if the client sends one.
    const boulder = await call('POST', `/api/gyms/${gymId}/routes`, { grade: 'V4', discipline: 'boulder' }, token);
    const boulderId = boulder.data.route.id as string;
    const bAttempt = await call(
      'POST',
      `/api/routes/${boulderId}/attempts`,
      { attempted_on: '2026-07-03', result: 'send', climb_type: 'lead' },
      token
    );
    expect(bAttempt.data.attempt.climb_type).toBe('');

    // Round-trips through the log feed.
    const log = await call('GET', '/api/attempts', undefined, token);
    const leadEntry = log.data.entries.find((e: Json) => e.id === lead.data.attempt.id);
    expect(leadEntry.climb_type).toBe('lead');
    expect(leadEntry.route_discipline).toBe('route');

    // A bogus climb type is rejected.
    const bad = await call(
      'POST',
      `/api/routes/${ropeId}/attempts`,
      { attempted_on: '2026-07-04', result: 'send', climb_type: 'solo' },
      token
    );
    expect(bad.status).toBe(400);
  });

  it('archives routes out of the default list', async () => {
    const created = await call('POST', `/api/gyms/${gymId}/routes`, { grade: 'V2', color: 'green' }, token);
    const routeId = created.data.route.id as string;

    const patched = await call('PATCH', `/api/routes/${routeId}`, { archived: 1 }, token);
    expect(patched.status).toBe(200);

    const activeList = await call('GET', `/api/gyms/${gymId}/routes`, undefined, token);
    expect(activeList.data.routes.some((r: Json) => r.id === routeId)).toBe(false);

    const fullList = await call('GET', `/api/gyms/${gymId}/routes?archived=1`, undefined, token);
    expect(fullList.data.routes.some((r: Json) => r.id === routeId)).toBe(true);
  });

  it('stores and toggles the flashed flag', async () => {
    const created = await call('POST', `/api/gyms/${gymId}/routes`, { grade: 'V6' }, token);
    const routeId = created.data.route.id as string;

    const plain = await call(
      'POST',
      `/api/routes/${routeId}/attempts`,
      { attempted_on: '2026-07-01', result: 'send' },
      token
    );
    expect(plain.status).toBe(201);
    expect(plain.data.attempt.flashed).toBe(0);

    const flash = await call(
      'POST',
      `/api/routes/${routeId}/attempts`,
      { attempted_on: '2026-07-02', result: 'send', flashed: 1 },
      token
    );
    expect(flash.status).toBe(201);
    expect(flash.data.attempt.flashed).toBe(1);

    const unset = await call('PATCH', `/api/attempts/${flash.data.attempt.id}`, { flashed: 0 }, token);
    expect(unset.status).toBe(200);
    expect(unset.data.attempt.flashed).toBe(0);

    const set = await call('PATCH', `/api/attempts/${plain.data.attempt.id}`, { flashed: 1 }, token);
    expect(set.status).toBe(200);
    expect(set.data.attempt.flashed).toBe(1);

    const detail = await call('GET', `/api/routes/${routeId}`, undefined, token);
    const byId = Object.fromEntries(detail.data.attempts.map((a: Json) => [a.id, a.flashed]));
    expect(byId[plain.data.attempt.id]).toBe(1);
    expect(byId[flash.data.attempt.id]).toBe(0);

    const bad = await call(
      'POST',
      `/api/routes/${routeId}/attempts`,
      { attempted_on: '2026-07-03', result: 'send', flashed: true },
      token
    );
    expect(bad.status).toBe(400);
  });

  it('rejects malformed attempts', async () => {
    const created = await call('POST', `/api/gyms/${gymId}/routes`, { grade: 'V1' }, token);
    const routeId = created.data.route.id as string;

    const badDate = await call(
      'POST',
      `/api/routes/${routeId}/attempts`,
      { attempted_on: 'July 8th', result: 'send' },
      token
    );
    expect(badDate.status).toBe(400);

    const badResult = await call(
      'POST',
      `/api/routes/${routeId}/attempts`,
      { attempted_on: '2026-07-08', result: 'crushed' },
      token
    );
    expect(badResult.status).toBe(400);
  });

  it('deletes attempts and routes', async () => {
    const created = await call('POST', `/api/gyms/${gymId}/routes`, { grade: 'V3' }, token);
    const routeId = created.data.route.id as string;

    const attempt = await call(
      'POST',
      `/api/routes/${routeId}/attempts`,
      { attempted_on: '2026-07-09', result: 'attempt' },
      token
    );
    const attemptId = attempt.data.attempt.id as string;

    const delAttempt = await call('DELETE', `/api/attempts/${attemptId}`, undefined, token);
    expect(delAttempt.status).toBe(200);

    const delRoute = await call('DELETE', `/api/routes/${routeId}`, undefined, token);
    expect(delRoute.status).toBe(200);

    const gone = await call('GET', `/api/routes/${routeId}`, undefined, token);
    expect(gone.status).toBe(404);
  });
});

describe('photos and gallery', () => {
  let token: string;
  let gymId: string;

  const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

  async function upload(path: string, authToken: string, contentType = 'image/jpeg', bytes: BodyInit = JPEG_BYTES) {
    const res = await app.request(
      path,
      {
        method: 'POST',
        headers: { 'Content-Type': contentType, Authorization: `Bearer ${authToken}` },
        body: bytes,
      },
      env
    );
    return { status: res.status, data: (await res.json()) as Json };
  }

  async function createRoute(): Promise<string> {
    const created = await call('POST', `/api/gyms/${gymId}/routes`, { grade: 'V4', color: 'blue' }, token);
    expect(created.status).toBe(201);
    return created.data.route.id as string;
  }

  beforeAll(async () => {
    token = await registerUser('photographer');
    const gym = await call('POST', '/api/gyms', { name: 'Photo Gym' }, token);
    gymId = gym.data.gym.id;
  });

  it('uploading to a route creates a gym-tagged gallery photo and links it', async () => {
    const routeId = await createRoute();

    const uploaded = await upload(`/api/routes/${routeId}/photos`, token);
    expect(uploaded.status).toBe(201);
    const photoId = uploaded.data.photo.id as string;
    expect(uploaded.data.photo.gym_id).toBe(gymId);

    const detail = await call('GET', `/api/routes/${routeId}`, undefined, token);
    expect(detail.data.photos).toHaveLength(1);
    expect(detail.data.photos[0].id).toBe(photoId);

    const gallery = await call('GET', '/api/photos', undefined, token);
    const row = gallery.data.photos.find((ph: Json) => ph.id === photoId);
    expect(row.link_count).toBe(1);

    const img = await app.request(`/api/photos/${photoId}`, { headers: { Authorization: `Bearer ${token}` } }, env);
    expect(img.status).toBe(200);
    expect(new Uint8Array(await img.arrayBuffer())).toEqual(JPEG_BYTES);
  });

  it('surfaces photo rollups in the route list', async () => {
    const routeId = await createRoute();
    const first = await upload(`/api/routes/${routeId}/photos`, token);
    await upload(`/api/routes/${routeId}/photos`, token);

    const list = await call('GET', `/api/gyms/${gymId}/routes`, undefined, token);
    const row = list.data.routes.find((r: Json) => r.id === routeId);
    expect(row.photo_count).toBe(2);
    expect(row.first_photo_id).toBe(first.data.photo.id);
  });

  it('surfaces the route image in route lists for spotlit thumbnails', async () => {
    const routeId = await createRoute();
    const photo = await upload(`/api/routes/${routeId}/photos`, token);
    const markers = [{ x: 0.4, y: 0.5, r: 0.02, polygon: [[0.39, 0.49], [0.41, 0.49], [0.4, 0.52]] }];
    await call('PUT', `/api/routes/${routeId}/image`, { photo_id: photo.data.photo.id, markers }, token);

    for (const path of [`/api/gyms/${gymId}/routes`, '/api/routes']) {
      const list = await call('GET', path, undefined, token);
      const row = list.data.routes.find((r: Json) => r.id === routeId);
      expect(row.image_photo_id).toBe(photo.data.photo.id);
      expect(JSON.parse(row.image_markers)).toEqual(markers);
      expect(row.image_photo_v).toBeGreaterThan(0);
    }
  });

  it('uploads straight to the gallery, with and without a gym tag', async () => {
    const tagged = await upload(`/api/photos?gym=${gymId}`, token);
    expect(tagged.status).toBe(201);
    expect(tagged.data.photo.gym_id).toBe(gymId);

    const untagged = await upload('/api/photos', token);
    expect(untagged.status).toBe(201);
    expect(untagged.data.photo.gym_id).toBeNull();

    const filtered = await call('GET', `/api/photos?gym=${gymId}`, undefined, token);
    expect(filtered.data.photos.some((ph: Json) => ph.id === tagged.data.photo.id)).toBe(true);
    expect(filtered.data.photos.some((ph: Json) => ph.id === untagged.data.photo.id)).toBe(false);
  });

  it('links and unlinks gallery photos', async () => {
    const routeId = await createRoute();
    const photo = await upload('/api/photos', token);
    const photoId = photo.data.photo.id as string;

    const linked = await call('PUT', `/api/routes/${routeId}/photos/${photoId}`, undefined, token);
    expect(linked.status).toBe(200);
    const again = await call('PUT', `/api/routes/${routeId}/photos/${photoId}`, undefined, token);
    expect(again.status).toBe(200);

    let detail = await call('GET', `/api/routes/${routeId}`, undefined, token);
    expect(detail.data.photos).toHaveLength(1);

    const unlinked = await call('DELETE', `/api/routes/${routeId}/photos/${photoId}`, undefined, token);
    expect(unlinked.status).toBe(200);
    detail = await call('GET', `/api/routes/${routeId}`, undefined, token);
    expect(detail.data.photos).toHaveLength(0);

    const gallery = await call('GET', '/api/photos', undefined, token);
    expect(gallery.data.photos.some((ph: Json) => ph.id === photoId)).toBe(true);

    const reUnlink = await call('DELETE', `/api/routes/${routeId}/photos/${photoId}`, undefined, token);
    expect(reUnlink.status).toBe(404);
  });

  it('enforces the per-route link cap', async () => {
    const routeId = await createRoute();
    for (let i = 0; i < 12; i++) {
      const ok = await upload(`/api/routes/${routeId}/photos`, token);
      expect(ok.status).toBe(201);
    }
    const overflowUpload = await upload(`/api/routes/${routeId}/photos`, token);
    expect(overflowUpload.status).toBe(400);

    const extra = await upload('/api/photos', token);
    const overflowLink = await call('PUT', `/api/routes/${routeId}/photos/${extra.data.photo.id}`, undefined, token);
    expect(overflowLink.status).toBe(400);
  });

  it('rejects bad uploads', async () => {
    const badType = await upload('/api/photos', token, 'application/pdf');
    expect(badType.status).toBe(400);

    const empty = await upload('/api/photos', token, 'image/png', new Uint8Array(0));
    expect(empty.status).toBe(400);

    const huge = await upload('/api/photos', token, 'image/jpeg', new Uint8Array(10 * 1024 * 1024 + 1));
    expect(huge.status).toBe(413);
  });

  it('keeps photos in the gallery when a route is deleted', async () => {
    const routeId = await createRoute();
    const uploaded = await upload(`/api/routes/${routeId}/photos`, token);
    const photoId = uploaded.data.photo.id as string;
    const key = uploaded.data.photo.r2_key as string;

    const del = await call('DELETE', `/api/routes/${routeId}`, undefined, token);
    expect(del.status).toBe(200);

    const gallery = await call('GET', '/api/photos', undefined, token);
    const row = gallery.data.photos.find((ph: Json) => ph.id === photoId);
    expect(row).toBeTruthy();
    expect(row.link_count).toBe(0);

    const stored = await env.PHOTOS.get(key);
    expect(stored).not.toBeNull();
    await stored!.arrayBuffer();
  });

  it('deleting a photo removes it from every route and cleans up R2 and annotations', async () => {
    const routeA = await createRoute();
    const routeB = await createRoute();
    const uploaded = await upload(`/api/routes/${routeA}/photos`, token);
    const photoId = uploaded.data.photo.id as string;
    const key = uploaded.data.photo.r2_key as string;
    await call('PUT', `/api/routes/${routeB}/photos/${photoId}`, undefined, token);
    await call('PUT', `/api/routes/${routeA}/image`, { photo_id: photoId, markers: [{ x: 0.5, y: 0.5, r: 0.02 }] }, token);

    const info = await call('GET', `/api/photos/${photoId}/info`, undefined, token);
    expect(info.data.routes).toHaveLength(2);
    expect(info.data.routes.find((r: Json) => r.route_id === routeA).has_annotation).toBe(1);

    const del = await call('DELETE', `/api/photos/${photoId}`, undefined, token);
    expect(del.status).toBe(200);

    for (const routeId of [routeA, routeB]) {
      const detail = await call('GET', `/api/routes/${routeId}`, undefined, token);
      expect(detail.data.photos).toHaveLength(0);
      expect(detail.data.route_image).toBeNull();
    }
    expect(await env.PHOTOS.get(key)).toBeNull();
  });

  it('updates the gym tag', async () => {
    const uploaded = await upload('/api/photos', token);
    const photoId = uploaded.data.photo.id as string;

    const tag = await call('PATCH', `/api/photos/${photoId}`, { gym_id: gymId }, token);
    expect(tag.status).toBe(200);
    expect(tag.data.photo.gym_id).toBe(gymId);

    const untag = await call('PATCH', `/api/photos/${photoId}`, { gym_id: null }, token);
    expect(untag.status).toBe(200);
    expect(untag.data.photo.gym_id).toBeNull();

    const stranger = await registerUser('gym-tagger');
    const strangersGym = (await call('POST', '/api/gyms', { name: 'Elsewhere' }, stranger)).data.gym.id;
    const wrongGym = await call('PATCH', `/api/photos/${photoId}`, { gym_id: strangersGym }, token);
    expect(wrongGym.status).toBe(404);
  });

  it("hides one user's photos from another", async () => {
    const snoop = await registerUser('photo-snoop');
    const routeId = await createRoute();
    const uploaded = await upload(`/api/routes/${routeId}/photos`, token);
    const photoId = uploaded.data.photo.id as string;

    expect((await call('GET', `/api/photos/${photoId}`, undefined, snoop)).status).toBe(404);
    expect((await call('GET', `/api/photos/${photoId}/info`, undefined, snoop)).status).toBe(404);
    expect((await call('DELETE', `/api/photos/${photoId}`, undefined, snoop)).status).toBe(404);
    expect((await call('PATCH', `/api/photos/${photoId}`, { gym_id: null }, snoop)).status).toBe(404);

    const snoopGym = (await call('POST', '/api/gyms', { name: 'Snoop Gym' }, snoop)).data.gym.id;
    const snoopRoute = (await call('POST', `/api/gyms/${snoopGym}/routes`, { grade: 'V1' }, snoop)).data.route.id;
    expect((await call('PUT', `/api/routes/${snoopRoute}/photos/${photoId}`, undefined, snoop)).status).toBe(404);

    const gallery = await call('GET', '/api/photos', undefined, snoop);
    expect(gallery.data.photos.some((ph: Json) => ph.id === photoId)).toBe(false);
  });
});

describe('photo editing', () => {
  let token: string;
  let gymId: string;

  const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
  const EDITED_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x01]);

  async function setupAnnotatedPhoto(markers: Json[], drawings: Json[] = []): Promise<{ routeId: string; photoId: string; r2Key: string }> {
    const route = await call('POST', `/api/gyms/${gymId}/routes`, { grade: '5.10b', color: 'purple' }, token);
    const routeId = route.data.route.id as string;
    const res = await app.request(
      `/api/routes/${routeId}/photos`,
      { method: 'POST', headers: { 'Content-Type': 'image/jpeg', Authorization: `Bearer ${token}` }, body: JPEG_BYTES },
      env
    );
    const data = (await res.json()) as Json;
    const photoId = data.photo.id as string;
    await call('PUT', `/api/routes/${routeId}/image`, { photo_id: photoId, markers, drawings }, token);
    return { routeId, photoId, r2Key: data.photo.r2_key as string };
  }

  async function edit(photoId: string, params: string, bytes: BodyInit = EDITED_BYTES) {
    const res = await app.request(
      `/api/photos/${photoId}/edit?${params}`,
      { method: 'POST', headers: { 'Content-Type': 'image/jpeg', Authorization: `Bearer ${token}` }, body: bytes },
      env
    );
    return { status: res.status, data: (await res.json()) as Json };
  }

  beforeAll(async () => {
    token = await registerUser('editor');
    const gym = await call('POST', '/api/gyms', { name: 'Edit Gym' }, token);
    gymId = gym.data.gym.id;
  });

  it('save-as-new creates a separate photo and leaves the original alone', async () => {
    const { routeId, photoId } = await setupAnnotatedPhoto([{ x: 0.2, y: 0.4, r: 0.02 }]);

    const res = await edit(photoId, 'mode=new&rotate=1&width=1000&height=2000');
    expect(res.status).toBe(201);
    expect(res.data.photo.id).not.toBe(photoId);
    expect(res.data.photo.gym_id).toBe(gymId);

    const detail = await call('GET', `/api/routes/${routeId}`, undefined, token);
    expect(detail.data.route_image.markers).toEqual([{ x: 0.2, y: 0.4, r: 0.02 }]);
    const original = await app.request(`/api/photos/${photoId}`, { headers: { Authorization: `Bearer ${token}` } }, env);
    expect(new Uint8Array(await original.arrayBuffer())).toEqual(JPEG_BYTES);
  });

  it('overwrite remaps markers through a rotation', async () => {
    const { routeId, photoId, r2Key } = await setupAnnotatedPhoto([{ x: 0.2, y: 0.4, r: 0.02 }]);

    const res = await edit(photoId, 'mode=overwrite&rotate=1&width=1000&height=2000');
    expect(res.status).toBe(200);
    expect(res.data.photo.r2_key).not.toBe(r2Key);

    const detail = await call('GET', `/api/routes/${routeId}`, undefined, token);
    const [m] = detail.data.route_image.markers;
    expect(m.x).toBeCloseTo(0.6);
    expect(m.y).toBeCloseTo(0.2);
    expect(m.r).toBeCloseTo(0.01);

    expect(await env.PHOTOS.get(r2Key)).toBeNull();
    const served = await app.request(`/api/photos/${photoId}`, { headers: { Authorization: `Bearer ${token}` } }, env);
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(EDITED_BYTES);
  });

  it('overwrite remaps the drawing layer alongside markers', async () => {
    const { routeId, photoId } = await setupAnnotatedPhoto(
      [{ x: 0.2, y: 0.4, r: 0.02 }],
      [
        { kind: 'stroke', color: '#ff3b30', width: 0.01, points: [[0.2, 0.4], [0.3, 0.5]] },
        { kind: 'text', color: '#0a84ff', size: 0.05, x: 0.2, y: 0.4, text: 'go' },
      ]
    );

    const res = await edit(photoId, 'mode=overwrite&rotate=1&width=1000&height=2000');
    expect(res.status).toBe(200);

    const detail = await call('GET', `/api/routes/${routeId}`, undefined, token);
    const [s, t] = detail.data.route_image.drawings;
    // rotate CW: (x,y) → (1-y, x); width fraction rescales by 1000/2000.
    expect(s.points[0][0]).toBeCloseTo(0.6);
    expect(s.points[0][1]).toBeCloseTo(0.2);
    expect(s.width).toBeCloseTo(0.005);
    expect(t.x).toBeCloseTo(0.6);
    expect(t.y).toBeCloseTo(0.2);
    expect(t.size).toBeCloseTo(0.025);
  });

  it('overwrite remaps markers through a crop and drops the ones outside', async () => {
    const { routeId, photoId } = await setupAnnotatedPhoto([
      { x: 0.75, y: 0.25, r: 0.02 },
      { x: 0.2, y: 0.8, r: 0.02 },
    ]);

    const res = await edit(photoId, 'mode=overwrite&crop_x=0.5&crop_y=0&crop_w=0.5&crop_h=0.5&width=1000&height=2000');
    expect(res.status).toBe(200);

    const detail = await call('GET', `/api/routes/${routeId}`, undefined, token);
    expect(detail.data.route_image.markers).toHaveLength(1);
    const [m] = detail.data.route_image.markers;
    expect(m.x).toBeCloseTo(0.5);
    expect(m.y).toBeCloseTo(0.5);
    expect(m.r).toBeCloseTo(0.04);
  });

  it('overwrite deletes an annotation whose markers are all cropped out', async () => {
    const { routeId, photoId } = await setupAnnotatedPhoto([{ x: 0.1, y: 0.9, r: 0.02 }]);

    const res = await edit(photoId, 'mode=overwrite&crop_x=0.5&crop_y=0&crop_w=0.5&crop_h=0.5&width=1000&height=2000');
    expect(res.status).toBe(200);

    const detail = await call('GET', `/api/routes/${routeId}`, undefined, token);
    expect(detail.data.route_image).toBeNull();
  });

  it('rejects invalid edit parameters', async () => {
    const { photoId } = await setupAnnotatedPhoto([{ x: 0.5, y: 0.5, r: 0.02 }]);
    for (const params of [
      'mode=overwrite', // missing dims
      'mode=overwrite&rotate=5&width=100&height=100',
      'mode=overwrite&crop_w=0&width=100&height=100',
      'mode=overwrite&crop_x=0.6&crop_w=0.5&width=100&height=100',
      'mode=sideways&width=100&height=100',
    ]) {
      const res = await edit(photoId, params);
      expect(res.status, params).toBe(400);
    }
  });
});

describe('route images', () => {
  let token: string;
  let gymId: string;

  const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
  const MARKERS = [
    { x: 0.41, y: 0.18, r: 0.02 },
    { x: 0.44, y: 0.31, r: 0.02 },
  ];

  async function createRouteWithPhoto(): Promise<{ routeId: string; photoId: string }> {
    const created = await call('POST', `/api/gyms/${gymId}/routes`, { grade: '5.10b', color: 'purple' }, token);
    expect(created.status).toBe(201);
    const routeId = created.data.route.id as string;
    const res = await app.request(
      `/api/routes/${routeId}/photos`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'image/jpeg', Authorization: `Bearer ${token}` },
        body: JPEG_BYTES,
      },
      env
    );
    const data = (await res.json()) as Json;
    expect(res.status).toBe(201);
    return { routeId, photoId: data.photo.id as string };
  }

  beforeAll(async () => {
    token = await registerUser('annotator');
    const gym = await call('POST', '/api/gyms', { name: 'Topo Gym' }, token);
    gymId = gym.data.gym.id;
  });

  it('sets, reads, updates, and removes a route image', async () => {
    const { routeId, photoId } = await createRouteWithPhoto();

    const bare = await call('GET', `/api/routes/${routeId}`, undefined, token);
    expect(bare.data.route_image).toBeNull();

    const set = await call('PUT', `/api/routes/${routeId}/image`, { photo_id: photoId, markers: MARKERS }, token);
    expect(set.status).toBe(200);
    expect(set.data.route_image.markers).toEqual(MARKERS);

    const detail = await call('GET', `/api/routes/${routeId}`, undefined, token);
    expect(detail.data.route_image.photo_id).toBe(photoId);
    expect(detail.data.route_image.markers).toEqual(MARKERS);

    const updated = await call(
      'PUT',
      `/api/routes/${routeId}/image`,
      { photo_id: photoId, markers: [{ x: 0.5, y: 0.5, r: 0.03 }] },
      token
    );
    expect(updated.status).toBe(200);
    expect(updated.data.route_image.markers).toHaveLength(1);

    const del = await call('DELETE', `/api/routes/${routeId}/image`, undefined, token);
    expect(del.status).toBe(200);
    const after = await call('GET', `/api/routes/${routeId}`, undefined, token);
    expect(after.data.route_image).toBeNull();

    const delAgain = await call('DELETE', `/api/routes/${routeId}/image`, undefined, token);
    expect(delAgain.status).toBe(404);
  });

  it('rejects invalid markers', async () => {
    const { routeId, photoId } = await createRouteWithPhoto();

    for (const markers of [
      [],
      [{ x: 1.5, y: 0.5, r: 0.02 }],
      [{ x: 0.5, y: -0.1, r: 0.02 }],
      [{ x: 0.5, y: 0.5, r: 0 }],
      [{ x: 0.5, y: 0.5, r: 0.5 }],
      Array.from({ length: 101 }, () => ({ x: 0.5, y: 0.5, r: 0.02 })),
      [{ x: '0.5', y: 0.5, r: 0.02 }],
    ]) {
      const res = await call('PUT', `/api/routes/${routeId}/image`, { photo_id: photoId, markers }, token);
      expect(res.status, JSON.stringify(markers).slice(0, 60)).toBe(400);
    }
  });

  it('round-trips markers carrying detected polygons', async () => {
    const { routeId, photoId } = await createRouteWithPhoto();
    const markers = [
      { x: 0.4, y: 0.3, r: 0.05, polygon: [[0.36, 0.26], [0.44, 0.27], [0.45, 0.34], [0.35, 0.33]] },
      { x: 0.6, y: 0.6, r: 0.02 }, // a plain manual circle alongside
    ];
    const set = await call('PUT', `/api/routes/${routeId}/image`, { photo_id: photoId, markers }, token);
    expect(set.status).toBe(200);
    const detail = await call('GET', `/api/routes/${routeId}`, undefined, token);
    expect(detail.data.route_image.markers[0].polygon).toHaveLength(4);
    expect(detail.data.route_image.markers[1].polygon).toBeUndefined();
  });

  it('round-trips the free-drawing layer alongside markers', async () => {
    const { routeId, photoId } = await createRouteWithPhoto();
    const drawings = [
      { kind: 'stroke', color: '#ff3b30', width: 0.01, points: [[0.1, 0.1], [0.2, 0.3], [0.25, 0.4]] },
      { kind: 'text', color: '#0a84ff', size: 0.05, x: 0.5, y: 0.6, text: 'crux' },
    ];
    const set = await call('PUT', `/api/routes/${routeId}/image`, { photo_id: photoId, markers: MARKERS, drawings }, token);
    expect(set.status).toBe(200);
    expect(set.data.route_image.drawings).toEqual(drawings);

    const detail = await call('GET', `/api/routes/${routeId}`, undefined, token);
    expect(detail.data.route_image.markers).toEqual(MARKERS);
    expect(detail.data.route_image.drawings).toEqual(drawings);
  });

  it('defaults drawings to empty when omitted', async () => {
    const { routeId, photoId } = await createRouteWithPhoto();
    const set = await call('PUT', `/api/routes/${routeId}/image`, { photo_id: photoId, markers: MARKERS }, token);
    expect(set.status).toBe(200);
    expect(set.data.route_image.drawings).toEqual([]);
    const detail = await call('GET', `/api/routes/${routeId}`, undefined, token);
    expect(detail.data.route_image.drawings).toEqual([]);
  });

  it('rejects invalid drawings', async () => {
    const { routeId, photoId } = await createRouteWithPhoto();
    for (const drawings of [
      [{ kind: 'stroke', color: 'red', width: 0.01, points: [[0.1, 0.1], [0.2, 0.2]] }], // color not hex
      [{ kind: 'stroke', color: '#ff0000', width: 0.01, points: [[0.1, 0.1]] }], // too few points
      [{ kind: 'stroke', color: '#ff0000', width: 0.01, points: [[1.2, 0.1], [0.2, 0.2]] }], // out of range
      [{ kind: 'text', color: '#ff0000', size: 0.05, x: 0.5, y: 0.5, text: '' }], // empty text
      [{ kind: 'blob', color: '#ff0000' }], // unknown kind
      Array.from({ length: 201 }, () => ({ kind: 'text', color: '#ff0000', size: 0.05, x: 0.5, y: 0.5, text: 'x' })),
    ]) {
      const res = await call('PUT', `/api/routes/${routeId}/image`, { photo_id: photoId, markers: MARKERS, drawings }, token);
      expect(res.status, JSON.stringify(drawings).slice(0, 60)).toBe(400);
    }
  });

  it('rejects malformed polygons', async () => {
    const { routeId, photoId } = await createRouteWithPhoto();
    for (const polygon of [
      [[0.1, 0.1], [0.2, 0.2]], // too few points
      [[0.1, 0.1], [0.2, 0.2], [1.4, 0.3]], // out of range
      [[0.1, 0.1], [0.2], [0.3, 0.3]], // not a pair
    ]) {
      const res = await call(
        'PUT',
        `/api/routes/${routeId}/image`,
        { photo_id: photoId, markers: [{ x: 0.4, y: 0.3, r: 0.05, polygon }] },
        token
      );
      expect(res.status, JSON.stringify(polygon).slice(0, 50)).toBe(400);
    }
  });

  it("rejects a photo that isn't on the route", async () => {
    const { routeId } = await createRouteWithPhoto();
    const other = await createRouteWithPhoto();

    const wrongRoute = await call(
      'PUT',
      `/api/routes/${routeId}/image`,
      { photo_id: other.photoId, markers: MARKERS },
      token
    );
    expect(wrongRoute.status).toBe(404);

    const noPhoto = await call(
      'PUT',
      `/api/routes/${routeId}/image`,
      { photo_id: 'nonexistent', markers: MARKERS },
      token
    );
    expect(noPhoto.status).toBe(404);
  });

  it("hides one user's route image from another", async () => {
    const { routeId, photoId } = await createRouteWithPhoto();
    await call('PUT', `/api/routes/${routeId}/image`, { photo_id: photoId, markers: MARKERS }, token);

    const snoop = await registerUser('topo-snoop');
    const put = await call(
      'PUT',
      `/api/routes/${routeId}/image`,
      { photo_id: photoId, markers: MARKERS },
      snoop
    );
    expect(put.status).toBe(404);
    const del = await call('DELETE', `/api/routes/${routeId}/image`, undefined, snoop);
    expect(del.status).toBe(404);
  });

  it('removes the route image when its photo is deleted', async () => {
    const { routeId, photoId } = await createRouteWithPhoto();
    await call('PUT', `/api/routes/${routeId}/image`, { photo_id: photoId, markers: MARKERS }, token);

    const del = await call('DELETE', `/api/photos/${photoId}`, undefined, token);
    expect(del.status).toBe(200);

    const detail = await call('GET', `/api/routes/${routeId}`, undefined, token);
    expect(detail.data.route_image).toBeNull();
  });
});

describe('cross-gym listing and log feed', () => {
  let token: string;
  let gymA: string;
  let gymB: string;

  beforeAll(async () => {
    token = await registerUser('multigym');
    gymA = (await call('POST', '/api/gyms', { name: 'Gym A' }, token)).data.gym.id;
    gymB = (await call('POST', '/api/gyms', { name: 'Gym B' }, token)).data.gym.id;
  });

  it('lists routes across all gyms with gym names', async () => {
    await call('POST', `/api/gyms/${gymA}/routes`, { grade: 'V1', color: 'red' }, token);
    await call('POST', `/api/gyms/${gymB}/routes`, { grade: '5.10a', color: 'blue' }, token);

    const list = await call('GET', '/api/routes', undefined, token);
    expect(list.status).toBe(200);
    const names = list.data.routes.map((r: Json) => r.gym_name).sort();
    expect(names).toContain('Gym A');
    expect(names).toContain('Gym B');
  });

  it('returns a log feed with route and gym context', async () => {
    const route = await call('POST', `/api/gyms/${gymA}/routes`, { grade: 'V3', color: 'green' }, token);
    await call(
      'POST',
      `/api/routes/${route.data.route.id}/attempts`,
      { attempted_on: '2026-07-10', result: 'send' },
      token
    );

    const log = await call('GET', '/api/attempts', undefined, token);
    expect(log.status).toBe(200);
    const entry = log.data.entries.find((e: Json) => e.route_id === route.data.route.id);
    expect(entry.gym_id).toBe(gymA);
    expect(entry.gym_name).toBe('Gym A');
    expect(entry.route_grade).toBe('V3');
    expect(entry.result).toBe('send');
  });

  it('exposes route thumbnail fields on the log feed', async () => {
    const route = await call('POST', `/api/gyms/${gymA}/routes`, { grade: 'V2', color: 'orange' }, token);
    const routeId = route.data.route.id as string;
    const up = await app.request(
      `/api/routes/${routeId}/photos`,
      { method: 'POST', headers: { 'Content-Type': 'image/jpeg', Authorization: `Bearer ${token}` }, body: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]) },
      env
    );
    const photoId = ((await up.json()) as Json).photo.id as string;
    const markers = [{ x: 0.5, y: 0.5, r: 0.02 }];
    await call('PUT', `/api/routes/${routeId}/image`, { photo_id: photoId, markers }, token);
    await call('POST', `/api/routes/${routeId}/attempts`, { attempted_on: '2026-07-11', result: 'attempt' }, token);

    const log = await call('GET', '/api/attempts', undefined, token);
    const entry = log.data.entries.find((e: Json) => e.route_id === routeId);
    expect(entry.first_photo_id).toBe(photoId);
    expect(entry.image_photo_id).toBe(photoId);
    expect(JSON.parse(entry.image_markers)).toEqual(markers);
    expect(entry.image_photo_v).toBeGreaterThan(0);
  });

  it('generates a name when none is given', async () => {
    const route = await call('POST', `/api/gyms/${gymA}/routes`, { grade: 'V4', color: 'pink' }, token);
    expect(route.data.route.name).toMatch(/^pink V4 added on \d{4}-\d{2}-\d{2}$/);

    const named = await call('POST', `/api/gyms/${gymA}/routes`, { name: 'Slopey Nonsense', grade: 'V2' }, token);
    expect(named.data.route.name).toBe('Slopey Nonsense');
  });

  it('moves a route between gyms but only into your own gym', async () => {
    const route = await call('POST', `/api/gyms/${gymA}/routes`, { grade: 'V5' }, token);
    const routeId = route.data.route.id as string;

    const moved = await call('PATCH', `/api/routes/${routeId}`, { gym_id: gymB }, token);
    expect(moved.status).toBe(200);
    expect(moved.data.route.gym_id).toBe(gymB);

    const stranger = await registerUser('gym-thief');
    const strangersGym = (await call('POST', '/api/gyms', { name: 'Not Yours' }, stranger)).data.gym.id;
    const steal = await call('PATCH', `/api/routes/${routeId}`, { gym_id: strangersGym }, token);
    expect(steal.status).toBe(404);
  });
});

// The workers pool isolates storage per test, so anything a test needs to
// already exist is seeded in beforeAll; each test's own writes are rolled back.
describe('gym catalog', () => {
  let token: string;
  let gymId: string;

  // Stands in for what the KAYA sync writes: unnamed climbs identified by
  // grade + color + wall.
  async function seedCatalog(
    rows: { external_id: string; grade: string; color: string; wall: string; discipline: string; removed?: boolean }[]
  ) {
    for (const r of rows) {
      await env.DB.prepare(
        `INSERT INTO gym_catalog (id, source, source_gym_id, external_id, slug, grade, color, wall, discipline, rating, ascent_count, is_closed, first_seen_at, last_seen_at, removed_at)
         VALUES (?, 'kaya', '211', ?, '', ?, ?, ?, ?, 4.5, 7, 0, 1, 1, ?)`
      )
        .bind(`kaya:${r.external_id}`, r.external_id, r.grade, r.color, r.wall, r.discipline, r.removed ? 2 : null)
        .run();
    }
  }

  beforeAll(async () => {
    token = await registerUser('catalog-user');
    gymId = (await call('POST', '/api/gyms', { name: 'Movement Boulder' }, token)).data.gym.id;
    await call('PATCH', `/api/gyms/${gymId}`, { catalog_source: 'kaya', catalog_gym_id: '211' }, token);
    await seedCatalog([
      { external_id: 'c1', grade: 'v2', color: 'blue', wall: 'B4 - The Cave', discipline: 'boulder' },
      { external_id: 'c2', grade: '5.11c', color: 'green', wall: 'Grey Wall', discipline: 'route' },
      { external_id: 'c3', grade: 'v5', color: 'pink', wall: 'A2 - 45 Right', discipline: 'boulder', removed: true },
    ]);
  });

  const catalogOf = async (gym: string, query = '') =>
    (await call('GET', `/api/gyms/${gym}/catalog${query}`, undefined, token)).data.catalog as Json[];

  it('lists the linked catalog and hides climbs that were stripped', async () => {
    const live = await catalogOf(gymId);
    expect(live).toHaveLength(2);
    expect(live.map((e) => e.external_id).sort()).toEqual(['c1', 'c2']);
    expect(live.every((e) => e.imported_route_id === null)).toBe(true);

    const withRemoved = await catalogOf(gymId, '?removed=1');
    expect(withRemoved).toHaveLength(3);
  });

  it('returns nothing for a gym with no catalog link', async () => {
    const unlinked = (await call('POST', '/api/gyms', { name: 'Unlinked' }, token)).data.gym.id;
    expect(await catalogOf(unlinked)).toEqual([]);
  });

  it('imports entries as unnamed routes carrying wall, grade and colour', async () => {
    const boulder = (await catalogOf(gymId)).find((e) => e.external_id === 'c1')!;

    const imported = await call('POST', `/api/gyms/${gymId}/catalog/import`, { catalog_ids: [boulder.id] }, token);
    expect(imported.status).toBe(201);
    expect(imported.data.routes).toHaveLength(1);

    const route = imported.data.routes[0] as Json;
    expect(route.name).toBe(''); // gym climbs are unnamed; the client builds a label
    expect(route.grade).toBe('v2');
    expect(route.color).toBe('blue');
    expect(route.wall).toBe('B4 - The Cave');
    expect(route.discipline).toBe('boulder');
    expect(route.source).toBe('kaya');
    expect(route.source_external_id).toBe('c1');

    const entry = (await catalogOf(gymId)).find((e) => e.external_id === 'c1')!;
    expect(entry.imported_route_id).toBe(route.id);
  });

  it('skips entries already imported instead of duplicating them', async () => {
    const ids = (await catalogOf(gymId)).map((e) => e.id);

    const first = await call('POST', `/api/gyms/${gymId}/catalog/import`, { catalog_ids: ids }, token);
    expect(first.data.routes).toHaveLength(2);
    expect(first.data.skipped).toEqual([]);

    const second = await call('POST', `/api/gyms/${gymId}/catalog/import`, { catalog_ids: ids }, token);
    expect(second.status).toBe(201);
    expect(second.data.routes).toHaveLength(0);
    expect(second.data.skipped).toHaveLength(2);

    const routes = (await call('GET', `/api/gyms/${gymId}/routes`, undefined, token)).data.routes as Json[];
    expect(routes.filter((r) => r.source === 'kaya')).toHaveLength(2);
  });

  it('imports a stripped climb only when explicitly asked for by id', async () => {
    const removed = (await catalogOf(gymId, '?removed=1')).find((e) => e.external_id === 'c3')!;
    const res = await call('POST', `/api/gyms/${gymId}/catalog/import`, { catalog_ids: [removed.id] }, token);
    expect(res.status).toBe(201);
    expect(res.data.routes).toHaveLength(1);
    expect(res.data.routes[0].wall).toBe('A2 - 45 Right');
  });

  it('rejects an import into a gym with no catalog link', async () => {
    const unlinked = (await call('POST', '/api/gyms', { name: 'Unlinked' }, token)).data.gym.id;
    const res = await call('POST', `/api/gyms/${unlinked}/catalog/import`, { catalog_ids: ['kaya:c1'] }, token);
    expect(res.status).toBe(400);
  });

  it('rejects an empty or oversized id list', async () => {
    expect((await call('POST', `/api/gyms/${gymId}/catalog/import`, { catalog_ids: [] }, token)).status).toBe(400);
    const tooMany = Array.from({ length: 501 }, (_, i) => `kaya:x${i}`);
    expect((await call('POST', `/api/gyms/${gymId}/catalog/import`, { catalog_ids: tooMany }, token)).status).toBe(400);
  });

  it('ignores catalog ids belonging to a different gym', async () => {
    await seedCatalog([{ external_id: 'other', grade: 'v9', color: 'red', wall: 'Elsewhere', discipline: 'boulder' }]);
    await env.DB.prepare("UPDATE gym_catalog SET source_gym_id = '999' WHERE external_id = 'other'").run();

    const res = await call('POST', `/api/gyms/${gymId}/catalog/import`, { catalog_ids: ['kaya:other'] }, token);
    expect(res.status).toBe(201);
    expect(res.data.routes).toEqual([]);
  });

  it('does not expose the catalog of a gym the caller does not own', async () => {
    const stranger = await registerUser('catalog-snoop');
    expect((await call('GET', `/api/gyms/${gymId}/catalog`, undefined, stranger)).status).toBe(404);
    expect(
      (await call('POST', `/api/gyms/${gymId}/catalog/import`, { catalog_ids: ['kaya:c2'] }, stranger)).status
    ).toBe(404);
  });
});

describe('catalog sources', () => {
  let token: string;

  beforeAll(async () => {
    token = await registerUser('catalog-picker');
    await env.DB.prepare(
      `INSERT INTO gym_catalog (id, source, source_gym_id, source_gym_name, external_id, slug, grade, color, wall, discipline, rating, ascent_count, is_closed, first_seen_at, last_seen_at, removed_at)
       VALUES ('kaya:p1','kaya','211','Movement Boulder','p1','','v3','red','Grey Wall','boulder',4,2,0,1,5,NULL),
              ('kaya:p2','kaya','211','Movement Boulder','p2','','v4','blue','Grey Wall','boulder',4,2,0,1,9,NULL),
              ('kaya:p3','kaya','999','Somewhere Else','p3','','v1','pink','Slab','boulder',4,2,0,1,3,NULL),
              ('kaya:p4','kaya','211','Movement Boulder','p4','','v9','black','Cave','boulder',4,2,0,1,4,7)`
    ).run();
  });

  it('groups synced climbs by gym and ignores stripped ones', async () => {
    const { status, data } = await call('GET', '/api/catalogs', undefined, token);
    expect(status).toBe(200);

    const sources = data.sources as Json[];
    const boulder = sources.find((s) => s.source_gym_id === '211')!;
    expect(boulder.source_gym_name).toBe('Movement Boulder');
    expect(boulder.climb_count).toBe(2); // p4 is removed
    expect(boulder.last_synced_at).toBe(9);
    expect(sources.find((s) => s.source_gym_id === '999')!.climb_count).toBe(1);
  });

  it('needs auth', async () => {
    expect((await call('GET', '/api/catalogs')).status).toBe(401);
  });
});

describe('log entries expose the route wall', () => {
  it('carries wall through to the log feed so unnamed climbs stay identifiable', async () => {
    const token = await registerUser('wall-logger');
    const gymId = (await call('POST', '/api/gyms', { name: 'Movement' }, token)).data.gym.id;
    const route = await call(
      'POST',
      `/api/gyms/${gymId}/routes`,
      { name: '', grade: 'v2', color: 'blue', wall: 'B4 - The Cave', discipline: 'boulder' },
      token
    );
    await call(
      'POST',
      `/api/routes/${route.data.route.id}/attempts`,
      { attempted_on: '2026-07-20', result: 'send' },
      token
    );

    const log = await call('GET', '/api/attempts', undefined, token);
    expect(log.data.entries[0].route_wall).toBe('B4 - The Cave');
  });
});

describe('linking an existing route to a catalog climb', () => {
  let token: string;
  let gymId: string;
  let routeId: string;

  beforeAll(async () => {
    token = await registerUser('linker');
    gymId = (await call('POST', '/api/gyms', { name: 'Movement' }, token)).data.gym.id;
    await call('PATCH', `/api/gyms/${gymId}`, { catalog_source: 'kaya', catalog_gym_id: '211' }, token);
    await env.DB.prepare(
      `INSERT INTO gym_catalog (id, source, source_gym_id, source_gym_name, external_id, slug, grade, color, wall, discipline, rating, ascent_count, is_closed, first_seen_at, last_seen_at, removed_at, source_updated_at)
       VALUES ('kaya:L1','kaya','211','Movement Boulder','L1','','v4','pink','B3 - West Wall Right','boulder',NULL,0,0,1,1,NULL,'2026-07-30T12:00:00.000Z'),
              ('kaya:L2','kaya','211','Movement Boulder','L2','','v4','pink','B3 - West Wall Right','boulder',NULL,0,0,1,1,NULL,'2026-06-01T12:00:00.000Z')`
    ).run();
    routeId = (
      await call('POST', `/api/gyms/${gymId}/routes`, { grade: 'V4', color: 'pink', wall: 'my own words' }, token)
    ).data.route.id;
  });

  it('links a hand-entered route and adopts the catalog wall label', async () => {
    const res = await call('PUT', `/api/routes/${routeId}/catalog-link`, { catalog_id: 'kaya:L1' }, token);
    expect(res.status).toBe(200);
    expect(res.data.route.source).toBe('kaya');
    expect(res.data.route.source_external_id).toBe('L1');
    expect(res.data.route.wall).toBe('B3 - West Wall Right'); // replaces "my own words"

    // The catalog now reports it as claimed, which is what keeps the import
    // screen from offering it again.
    const catalog = (await call('GET', `/api/gyms/${gymId}/catalog`, undefined, token)).data.catalog as Json[];
    expect(catalog.find((e) => e.external_id === 'L1')!.imported_route_id).toBe(routeId);
  });

  it('exposes the set date, which is the only way to tell the two v4 pinks apart', async () => {
    const catalog = (await call('GET', `/api/gyms/${gymId}/catalog`, undefined, token)).data.catalog as Json[];
    expect(catalog.map((e) => e.source_updated_at).sort()).toEqual([
      '2026-06-01T12:00:00.000Z',
      '2026-07-30T12:00:00.000Z',
    ]);
  });

  it('refuses a climb already claimed by another route', async () => {
    await call('PUT', `/api/routes/${routeId}/catalog-link`, { catalog_id: 'kaya:L1' }, token);
    const other = (await call('POST', `/api/gyms/${gymId}/routes`, { grade: 'V4', color: 'pink' }, token)).data.route.id;
    const res = await call('PUT', `/api/routes/${other}/catalog-link`, { catalog_id: 'kaya:L1' }, token);
    expect(res.status).toBe(409);
  });

  it('unlinks, leaving the adopted wall text in place', async () => {
    await call('PUT', `/api/routes/${routeId}/catalog-link`, { catalog_id: 'kaya:L1' }, token);
    const res = await call('DELETE', `/api/routes/${routeId}/catalog-link`, undefined, token);
    expect(res.status).toBe(200);
    expect(res.data.route.source).toBe('');
    expect(res.data.route.wall).toBe('B3 - West Wall Right');

    expect((await call('DELETE', `/api/routes/${routeId}/catalog-link`, undefined, token)).status).toBe(404);
  });

  it('refuses a climb from a gym the route does not belong to', async () => {
    await env.DB.prepare("UPDATE gym_catalog SET source_gym_id='999' WHERE external_id='L2'").run();
    const res = await call('PUT', `/api/routes/${routeId}/catalog-link`, { catalog_id: 'kaya:L2' }, token);
    expect(res.status).toBe(409);
  });

  it('will not let another user link your route', async () => {
    const stranger = await registerUser('link-snoop');
    const res = await call('PUT', `/api/routes/${routeId}/catalog-link`, { catalog_id: 'kaya:L1' }, stranger);
    expect(res.status).toBe(404);
  });
});
