import type { Env } from './env';

// Asks GitHub Actions to run the catalog sync for one gym now, so a gym added in
// the app gets its climbs in a couple of minutes instead of at the next nightly
// cron. The pull needs a headless browser, which the Worker can't run, so the
// job has to happen there.
//
// Both settings are optional: without them the add still succeeds and the gym
// stays pending until the cron runs.
export type SyncRequest = { started: boolean; reason: string };

export async function requestCatalogSync(env: Env, slug: string): Promise<SyncRequest> {
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) {
    return { started: false, reason: 'not configured' };
  }
  try {
    const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/dispatches`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.GITHUB_TOKEN}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
        // GitHub rejects requests without one.
        'user-agent': 'sendit-worker',
      },
      body: JSON.stringify({ event_type: 'kaya-sync', client_payload: { gym: slug } }),
    });
    if (!res.ok) {
      return { started: false, reason: `github responded ${res.status}` };
    }
    return { started: true, reason: '' };
  } catch (err) {
    return { started: false, reason: err instanceof Error ? err.message : 'dispatch failed' };
  }
}
