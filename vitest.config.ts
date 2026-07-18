import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    // test/ holds Node-runtime migration tests (node:sqlite), run via
    // `node --test` in the test:migrations script, not the workers pool.
    exclude: ['**/node_modules/**', 'e2e/**', 'test/**'],
    setupFiles: ['./src/db/test-setup.ts'],
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          bindings: { JWT_SECRET: 'test-secret' },
        },
      },
    },
  },
});
