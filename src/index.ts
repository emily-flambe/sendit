import { Hono } from 'hono';
import type { Env } from './types';
import authApi from './api/auth';
import gymsApi from './api/gyms';
import routesApi from './api/routes';
import attemptsApi from './api/attempts';

const app = new Hono<{ Bindings: Env }>();

app.get('/api/health', (c) => c.json({ status: 'ok', timestamp: Date.now() }));

app.route('/api/auth', authApi);
app.route('/api/gyms', gymsApi);
app.route('/api/routes', routesApi);
app.route('/api/attempts', attemptsApi);

app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));

export default app;
