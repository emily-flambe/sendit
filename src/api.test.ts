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

describe('route photos', () => {
  let token: string;
  let gymId: string;

  const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

  async function uploadPhoto(routeId: string, authToken: string, contentType = 'image/jpeg', bytes: BodyInit = JPEG_BYTES) {
    const res = await app.request(
      `/api/routes/${routeId}/photos`,
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

  it('uploads, lists, serves, and deletes a photo', async () => {
    const routeId = await createRoute();

    const uploaded = await uploadPhoto(routeId, token);
    expect(uploaded.status).toBe(201);
    const photoId = uploaded.data.photo.id as string;
    expect(uploaded.data.photo.content_type).toBe('image/jpeg');
    expect(uploaded.data.photo.size).toBe(JPEG_BYTES.byteLength);

    const detail = await call('GET', `/api/routes/${routeId}`, undefined, token);
    expect(detail.data.photos).toHaveLength(1);
    expect(detail.data.photos[0].id).toBe(photoId);

    const img = await app.request(
      `/api/photos/${photoId}`,
      { headers: { Authorization: `Bearer ${token}` } },
      env
    );
    expect(img.status).toBe(200);
    expect(img.headers.get('Content-Type')).toBe('image/jpeg');
    expect(new Uint8Array(await img.arrayBuffer())).toEqual(JPEG_BYTES);

    const del = await call('DELETE', `/api/photos/${photoId}`, undefined, token);
    expect(del.status).toBe(200);

    const gone = await app.request(
      `/api/photos/${photoId}`,
      { headers: { Authorization: `Bearer ${token}` } },
      env
    );
    expect(gone.status).toBe(404);
    await gone.arrayBuffer();
    expect(await env.PHOTOS.get(`photos/${routeId}/${photoId}`)).toBeNull();
  });

  it('surfaces photo rollups in the route list', async () => {
    const routeId = await createRoute();
    const first = await uploadPhoto(routeId, token);
    await uploadPhoto(routeId, token);

    const list = await call('GET', `/api/gyms/${gymId}/routes`, undefined, token);
    const row = list.data.routes.find((r: Json) => r.id === routeId);
    expect(row.photo_count).toBe(2);
    expect(row.first_photo_id).toBe(first.data.photo.id);
  });

  it('rejects bad uploads', async () => {
    const routeId = await createRoute();

    const badType = await uploadPhoto(routeId, token, 'application/pdf');
    expect(badType.status).toBe(400);

    const empty = await uploadPhoto(routeId, token, 'image/png', new Uint8Array(0));
    expect(empty.status).toBe(400);

    const huge = await uploadPhoto(routeId, token, 'image/jpeg', new Uint8Array(10 * 1024 * 1024 + 1));
    expect(huge.status).toBe(413);
  });

  it('enforces the per-route photo cap', async () => {
    const routeId = await createRoute();
    for (let i = 0; i < 12; i++) {
      const ok = await uploadPhoto(routeId, token);
      expect(ok.status).toBe(201);
    }
    const overflow = await uploadPhoto(routeId, token);
    expect(overflow.status).toBe(400);
  });

  it("hides one user's photos from another", async () => {
    const snoop = await registerUser('photo-snoop');
    const routeId = await createRoute();
    const uploaded = await uploadPhoto(routeId, token);
    const photoId = uploaded.data.photo.id as string;

    const peek = await call('GET', `/api/photos/${photoId}`, undefined, snoop);
    expect(peek.status).toBe(404);

    const del = await call('DELETE', `/api/photos/${photoId}`, undefined, snoop);
    expect(del.status).toBe(404);

    const push = await uploadPhoto(routeId, snoop);
    expect(push.status).toBe(404);
  });

  it('cleans up R2 objects when the route is deleted', async () => {
    const routeId = await createRoute();
    const uploaded = await uploadPhoto(routeId, token);
    const key = uploaded.data.photo.r2_key as string;
    const stored = await env.PHOTOS.get(key);
    expect(stored).not.toBeNull();
    // R2 body streams must be fully consumed or isolated storage fails to unwind.
    await stored!.arrayBuffer();

    const del = await call('DELETE', `/api/routes/${routeId}`, undefined, token);
    expect(del.status).toBe(200);
    expect(await env.PHOTOS.get(key)).toBeNull();
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
