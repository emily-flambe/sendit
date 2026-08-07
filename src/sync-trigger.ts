import type { Env } from './env';

// Asks GitHub Actions to sync one gym now. The pull needs a headless browser,
// which the Worker can't run. Both settings are optional: without them the gym
// stays pending until the nightly cron.
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
        'user-agent': 'sendit-worker', // GitHub rejects requests without one
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
