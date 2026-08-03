import { test, expect, type Page } from '@playwright/test';

function uniqueUsername(suffix: string): string {
  return `e2e_${Date.now()}_${Math.random().toString(36).slice(2)}_${suffix}`;
}

async function registerCatalogGym(page: Page, usernameSuffix: string, gymName: string): Promise<void> {
  await page.goto('/');
  await page.fill('input[name=username]', uniqueUsername(usernameSuffix));
  await page.fill('input[name=password]', 'password123');
  await page.click('button[data-mode=register]');
  await page.fill('#gym-form input[name=name]', gymName);
  await page.click('#gym-form button[type=submit]');
  await expect(page).toHaveURL(/#\/routes$/);
  await page.evaluate(async () => {
    const token = localStorage.getItem('sendit_token');
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const { gyms } = await (await fetch('/api/gyms', { headers })).json();
    const res = await fetch(`/api/gyms/${gyms[0].id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ catalog_source: 'kaya', catalog_gym_id: 'e2e-211' }),
    });
    if (!res.ok) throw new Error(`gym catalog link: ${res.status}`);
  });
  await page.reload();
}

// Each run registers a fresh user, so local .wrangler/e2e state can persist
// between runs without entries leaking across tests.
test('register, add a gym, log a flash, and see it everywhere', async ({ page }) => {
  const username = `e2e_${Date.now()}`;

  await page.goto('/');
  await page.fill('input[name=username]', username);
  await page.fill('input[name=password]', 'password123');
  await page.click('button[data-mode=register]');

  // Fresh accounts land on the gyms page.
  await page.fill('#gym-form input[name=name]', 'E2E Gym');
  await page.click('#gym-form button[type=submit]');
  await expect(page).toHaveURL(/#\/routes$/);

  // Log a send on a brand-new route, marked as a flash.
  await page.click('nav a[href="#/"]');
  await page.click('a[href="#/log/new"]');
  await page.fill('input[name=grade]', 'V4');
  await page.check('input[name=flashed]');
  await page.click('#log-form button[type=submit]');

  // The climb log shows the send.
  await expect(page.locator('.log-entry .attempt-result')).toHaveText('SENT');

  // Route detail shows the flash state and the FLASH history badge.
  await page.click('.log-entry');
  await expect(page.locator('.route-hero .state').first()).toHaveText('flashed');
  await expect(page.locator('.history .attempt-result')).toHaveText('FLASH');
  await expect(page.locator('.history .flash-chip.on[aria-pressed="true"]')).toHaveText('flash');
});

test('does not label an unmarked first send as a flash', async ({ page }) => {
  const username = `e2e_${Date.now()}_plain_send`;

  await page.goto('/');
  await page.fill('input[name=username]', username);
  await page.fill('input[name=password]', 'password123');
  await page.click('button[data-mode=register]');

  await page.fill('#gym-form input[name=name]', 'E2E Plain Send Gym');
  await page.click('#gym-form button[type=submit]');
  await page.click('nav a[href="#/"]');
  await page.click('a[href="#/log/new"]');
  await page.fill('input[name=grade]', 'V3');
  await page.click('#log-form button[type=submit]');

  await page.click('.log-entry');
  await expect(page.locator('.route-hero .state').first()).toHaveText('sent');
  await expect(page.locator('.history .attempt-result')).toHaveText('SENT');
  await expect(page.locator('.history .flash-chip')).toHaveCount(0);
  await expect(page.locator('.history')).not.toContainText(/FLASH/i);
});

test('routes map omits pin count indicators', async ({ page }) => {
  const username = `e2e_${Date.now()}_map_counts`;

  await page.goto('/');
  await page.fill('input[name=username]', username);
  await page.fill('input[name=password]', 'password123');
  await page.click('button[data-mode=register]');

  await page.fill('#gym-form input[name=name]', 'E2E Map Count Gym');
  await page.click('#gym-form button[type=submit]');

  await page.evaluate(async () => {
    const token = localStorage.getItem('sendit_token');
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const { gyms } = await (await fetch('/api/gyms', { headers })).json();
    const gymId = gyms[0].id;
    const call = async (method: string, path: string, body: unknown) => {
      const res = await fetch(`/api${path}`, { method, headers, body: JSON.stringify(body) });
      if (!res.ok) throw new Error(`${path}: ${res.status}`);
      return res.json();
    };

    await call('PATCH', `/gyms/${gymId}`, { map_route_url: '/maps/routes.png' });
    await call('POST', `/gyms/${gymId}/routes`, {
      name: 'Pinned route',
      discipline: 'route',
      map_x: 0.25,
      map_y: 0.5,
    });
    await call('POST', `/gyms/${gymId}/routes`, { name: 'Unpinned route', discipline: 'route' });
  });

  await page.reload();
  await expect(page.locator('.map-panel .map-pin')).toHaveCount(1);
  await expect(page.locator('.map-panel [data-move-pins]')).toBeVisible();
  await expect(page.locator('.map-panel .section-head .hint')).toHaveCount(0);
  await expect(page.locator('.map-panel')).not.toContainText(/placed|without a pin/i);
});

test('links a filtered KAYA climb while creating a route', async ({ page }) => {
  let routeCreates = 0;
  let catalogLinks = 0;
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === 'POST' && /\/api\/gyms\/[^/]+\/routes$/.test(path)) routeCreates += 1;
    if (request.method() === 'PUT' && /\/api\/routes\/[^/]+\/catalog-link$/.test(path)) catalogLinks += 1;
  });

  await registerCatalogGym(page, 'kaya_filter', 'E2E KAYA Filter Gym');
  await page.click('.fab');
  await page.selectOption('#route-form select[name=discipline]', 'boulder');
  await page.click('#route-form [data-color=blue]');
  await page.locator('#grade-chips .chip', { hasText: 'V4' }).click();

  await expect(page.locator('#kaya-create-link')).toBeVisible();
  await expect(page.locator('#kaya-create-options [data-pick]')).toHaveCount(1);
  const blueV4 = page.locator('[data-pick="kaya:e2e-blue-v4"]');
  await expect(blueV4).toBeVisible();
  await expect(blueV4).toHaveAttribute('type', 'button');
  await blueV4.click();
  await expect(blueV4).toHaveClass(/active/);
  await expect(blueV4).toHaveAttribute('aria-pressed', 'true');
  await expect(page).toHaveURL(/#\/new$/);
  expect(routeCreates).toBe(0);

  await page.fill('#route-form input[name=grade]', 'V5');
  await expect(page.locator('#kaya-create-options [data-pick]')).toHaveCount(1);
  await expect(page.locator('[data-pick="kaya:e2e-blue-v5"]')).toBeVisible();
  await expect(page.locator('#kaya-create-options [aria-pressed="true"]')).toHaveCount(0);
  await page.locator('#grade-chips .chip', { hasText: 'V4' }).click();
  await expect(blueV4).toHaveAttribute('aria-pressed', 'false');

  await page.click('#route-form [data-color=red]');
  await expect(page.locator('[data-pick="kaya:e2e-red-v4"]')).toBeVisible();
  await expect(page.locator('#kaya-create-options [aria-pressed="true"]')).toHaveCount(0);
  await page.click('#route-form [data-color=blue]');
  await blueV4.click();
  await page.fill('#kaya-create-search', 'no matching wall');
  await expect(page.locator('#kaya-create-options [data-pick]')).toHaveCount(0);
  await page.fill('#kaya-create-search', '');
  await expect(blueV4).toHaveAttribute('aria-pressed', 'true');

  await page.click('#route-form button[type=submit]');

  await expect(page).toHaveURL(/#\/route\/[\w-]+$/);
  expect(routeCreates).toBe(1);
  expect(catalogLinks).toBe(1);
  await expect(page.locator('#kaya-unlink')).toBeVisible();

  const route = await page.evaluate(async () => {
    const routeId = window.location.hash.split('/')[2];
    const token = localStorage.getItem('sendit_token');
    const res = await fetch(`/api/routes/${routeId}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`route detail: ${res.status}`);
    return (await res.json()).route;
  });
  expect(route).toMatchObject({
    source: 'kaya',
    source_external_id: 'e2e-blue-v4',
    wall: 'Blue V4 Wall',
  });

  await page.goto(`/#/new`);
  await page.selectOption('#route-form select[name=discipline]', 'boulder');
  await page.click('#route-form [data-color=blue]');
  await page.locator('#grade-chips .chip', { hasText: 'V4' }).click();
  await expect(page.locator('[data-pick="kaya:e2e-blue-v4"]')).toHaveCount(0);

  await page.goto(`/#/route/${route.id}`);
  await expect(page.locator('#kaya-unlink')).toBeVisible();
  await page.click('#kaya-unlink');
  await expect(page.locator('#kaya-unlink')).toHaveCount(0);
  await expect(page.locator('#kaya-options')).toBeVisible();
  await page.click('.edit-link');
  await page.click('#route-form [data-color=red]');
  await page.locator('#grade-chips .chip', { hasText: 'V5' }).click();
  await page.click('#route-form button[type=submit]');

  await expect(page.locator('#kaya-options [data-pick]')).toHaveCount(1);
  await expect(page.locator('[data-pick="kaya:e2e-red-v5"]')).toBeVisible();
});

test('does not link a KAYA choice invalidated before route creation', async ({ page }) => {
  let routeCreates = 0;
  let catalogLinks = 0;
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === 'POST' && /\/api\/gyms\/[^/]+\/routes$/.test(path)) routeCreates += 1;
    if (request.method() === 'PUT' && /\/api\/routes\/[^/]+\/catalog-link$/.test(path)) catalogLinks += 1;
  });

  await registerCatalogGym(page, 'kaya_invalidated', 'E2E KAYA Invalidation Gym');
  await page.click('.fab');
  await page.selectOption('#route-form select[name=discipline]', 'boulder');
  await page.click('#route-form [data-color=blue]');
  await page.locator('#grade-chips .chip', { hasText: 'V4' }).click();
  await page.click('[data-pick="kaya:e2e-blue-v4"]');
  await page.fill('#route-form input[name=grade]', 'V5');
  await expect(page.locator('[data-pick="kaya:e2e-blue-v5"]')).toBeVisible();
  await expect(page.locator('#kaya-create-options [aria-pressed="true"]')).toHaveCount(0);
  await page.click('#route-form button[type=submit]');

  await expect(page).toHaveURL(/#\/route\/[\w-]+$/);
  expect(routeCreates).toBe(1);
  expect(catalogLinks).toBe(0);
  const source = await page.evaluate(async () => {
    const routeId = window.location.hash.split('/')[2];
    const token = localStorage.getItem('sendit_token');
    const res = await fetch(`/api/routes/${routeId}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`route detail: ${res.status}`);
    return (await res.json()).route.source;
  });
  expect(source).toBe('');
});

test('keeps a created route when its KAYA link conflicts', async ({ page }) => {
  let routeCreates = 0;
  let catalogLinks = 0;
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === 'POST' && /\/api\/gyms\/[^/]+\/routes$/.test(path)) routeCreates += 1;
    if (request.method() === 'PUT' && /\/api\/routes\/[^/]+\/catalog-link$/.test(path)) catalogLinks += 1;
  });

  await registerCatalogGym(page, 'kaya_conflict', 'E2E KAYA Conflict Gym');
  await page.route(/\/api\/routes\/[^/]+\/catalog-link$/, (route) =>
    route.fulfill({ status: 409, json: { error: 'That climb is not available to link' } })
  );

  await page.click('.fab');
  await page.selectOption('#route-form select[name=discipline]', 'boulder');
  await page.click('#route-form [data-color=blue]');
  await page.locator('#grade-chips .chip', { hasText: 'V4' }).click();
  await page.click('[data-pick="kaya:e2e-blue-v4"]');
  await page.click('#route-form button[type=submit]');

  await expect(page).toHaveURL(/#\/route\/[\w-]+$/);
  await expect(page.locator('.toast')).toHaveText('Route created, but the KAYA climb could not be linked.');
  expect(routeCreates).toBe(1);
  expect(catalogLinks).toBe(1);
  await expect(page.locator('#kaya-options [data-pick="kaya:e2e-blue-v4"]')).toBeVisible();
});

test('climb-type toggle only shows for roped climbs on the log form', async ({ page }) => {
  const username = `e2e_${Date.now()}_seg`;

  await page.goto('/');
  await page.fill('input[name=username]', username);
  await page.fill('input[name=password]', 'password123');
  await page.click('button[data-mode=register]');

  await page.fill('#gym-form input[name=name]', 'E2E Seg Gym');
  await page.click('#gym-form button[type=submit]');
  await expect(page).toHaveURL(/#\/routes$/);

  // New-route form: hidden for boulders, shown for roped routes. Asserts
  // real visibility, not just the class — a missing CSS rule once left the
  // toggle visible with .hidden applied.
  await page.click('nav a[href="#/"]');
  await page.click('a[href="#/log/new"]');
  const seg = page.locator('#climb-seg-wrap');
  await page.selectOption('select[name=discipline]', 'boulder');
  await expect(seg).toBeHidden();
  await page.selectOption('select[name=discipline]', 'route');
  await expect(seg).toBeVisible();

  // Log a boulder, then reopen the form: selecting the existing boulder
  // route keeps the toggle hidden.
  await page.selectOption('select[name=discipline]', 'boulder');
  await page.fill('input[name=grade]', 'V2');
  await page.click('#log-form button[type=submit]');
  await expect(page.locator('.log-entry .attempt-result')).toHaveText('SENT');
  await page.click('a[href="#/log/new"]');
  await expect(page.locator('select[name=route]')).not.toHaveValue('__new');
  await expect(seg).toBeHidden();
});

test('log groups entries by day and paginates on day boundaries', async ({ page }) => {
  const username = `e2e_${Date.now()}_pages`;

  await page.goto('/');
  await page.fill('input[name=username]', username);
  await page.fill('input[name=password]', 'password123');
  await page.click('button[data-mode=register]');

  await page.fill('#gym-form input[name=name]', 'E2E Pager Gym');
  await page.click('#gym-form button[type=submit]');
  await expect(page).toHaveURL(/#\/routes$/);

  // Seed via the API: 25 attempts on the newest day and 5 on an older one,
  // so newest-first pagination closes page 1 exactly at the day boundary.
  await page.evaluate(async () => {
    const token = localStorage.getItem('sendit_token');
    const call = async (method: string, path: string, body: unknown) => {
      const res = await fetch(`/api${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`${path}: ${res.status}`);
      return res.json();
    };
    const { gyms } = await (
      await fetch('/api/gyms', { headers: { Authorization: `Bearer ${token}` } })
    ).json();
    const { route } = await call('POST', `/gyms/${gyms[0].id}/routes`, {
      name: 'pager boulder',
      grade: 'V1',
      color: 'blue',
      wall: '',
      discipline: 'boulder',
      notes: '',
    });
    for (let i = 0; i < 25; i++) {
      await call('POST', `/routes/${route.id}/attempts`, { attempted_on: '2026-07-19', result: 'attempt' });
    }
    for (let i = 0; i < 5; i++) {
      await call('POST', `/routes/${route.id}/attempts`, { attempted_on: '2026-07-18', result: 'attempt' });
    }
  });

  await page.click('nav a[href="#/"]');

  // Page 1: only the newest day, with one day heading and all 25 entries.
  await expect(page.locator('.pager-status')).toHaveText('Page 1 of 2');
  await expect(page.locator('.log-day')).toHaveCount(1);
  await expect(page.locator('.log-day')).toContainText('2026-07-19');
  await expect(page.locator('.log-entry')).toHaveCount(25);

  // Page 2: the older day only.
  await page.click('.pager button[data-page=next]');
  await expect(page.locator('.pager-status')).toHaveText('Page 2 of 2');
  await expect(page.locator('.log-day')).toContainText('2026-07-18');
  await expect(page.locator('.log-entry')).toHaveCount(5);

  // Changing a filter snaps back to the first page.
  await page.selectOption('.filter-bar select[data-f=status]', 'attempt');
  await expect(page.locator('.pager-status')).toHaveText('Page 1 of 2');
});
