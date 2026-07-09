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
