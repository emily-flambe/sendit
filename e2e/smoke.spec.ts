import { test, expect } from '@playwright/test';

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
