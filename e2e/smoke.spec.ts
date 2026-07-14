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
