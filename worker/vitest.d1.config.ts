import { defineConfig } from 'vitest/config';

// Separate from vitest.config.ts (which mocks the DB) so the existing suite is
// untouched. These tests drive a real Miniflare D1 (real SQLite) directly, which
// is the only faithful way to validate SQL/datetime semantics like the
// age-review deadline comparison and the cron state-set guard.
// (We use Miniflare directly rather than @cloudflare/vitest-pool-workers because
// that pool runner is not yet compatible with Vitest 4.)
// Opt-in: excluded from the default suite; run with `npm run test:d1`.
export default defineConfig({
  test: {
    include: ['test/**/*.d1.test.ts'],
    environment: 'node',
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
