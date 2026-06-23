import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // The d1 (Miniflare) and e2e (live local relay) suites are opt-in via
    // `npm run test:d1` and `npm run test:e2e`. Keep the default `npm test` a
    // fast, self-contained node suite so CI and contributors are not gated on
    // Miniflare/workerd or a running local relay.
    exclude: [...configDefaults.exclude, 'test/**/*.d1.test.ts', 'test/**/*.e2e.test.ts'],
  },
});
