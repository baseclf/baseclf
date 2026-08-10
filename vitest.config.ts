import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

/**
 * Tests run inside workerd with a real D1 binding, not a Node emulation.
 *
 * This matters more than usual here. The behaviours the design depends on,
 * RETURNING, batch rollback, the hundred-parameter ceiling, do not exist in a
 * generic SQLite driver, and double-quoted string literals behave differently.
 * A test that passes against a fake is worth nothing.
 *
 * Note for anyone updating this file: `@cloudflare/vitest-pool-workers` 0.19
 * replaced `defineWorkersConfig` from the `/config` subpath with the
 * `cloudflareTest` Vite plugin, and deprecated `cloudflare:test` in favour of
 * `cloudflare:workers`. Older guides will not work.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      main: './src/index.ts',
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        d1Databases: ['DB'],
        r2Buckets: ['BUCKET'],
      },
    }),
  ],
});
