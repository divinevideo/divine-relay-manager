import { defineConfig } from 'vitest/config';

// End-to-end integration against a LIVE local funnelcake (cake relay :7777 +
// funnel management :8080) backed by real ClickHouse. Run manually:
//   npm run test:e2e
// Requires the relays to be running with ADMIN_PUBKEYS set to the test nsec's
// pubkey. Not part of the default suite (needs live services).
export default defineConfig({
  test: {
    include: ['test/**/*.e2e.test.ts'],
    environment: 'node',
    testTimeout: 30000,
    hookTimeout: 30000,
    retry: 0,
  },
});
