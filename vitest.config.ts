import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    exclude: ['**/node_modules/**', 'e2e/**'],
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
