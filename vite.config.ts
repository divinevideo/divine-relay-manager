import fs from "node:fs";
import path from "node:path";

import react from "@vitejs/plugin-react-swc";
import { configDefaults, defineConfig } from "vitest/config";

// https://vitejs.dev/config/
export default defineConfig(() => {
  // Enable HTTPS if local mkcert certs exist (dev only)
  const certPath = path.resolve(__dirname, ".certs/localhost+2.pem");
  const keyPath = path.resolve(__dirname, ".certs/localhost+2-key.pem");
  const hasLocalCerts = fs.existsSync(certPath) && fs.existsSync(keyPath);

  return {
  server: {
    host: "::",
    port: 8080,
    ...(hasLocalCerts && {
      https: {
        cert: fs.readFileSync(certPath),
        key: fs.readFileSync(keyPath),
      },
    }),
  },
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    testTimeout: 15000,
    setupFiles: './src/test/setup.ts',
    // CI runners are UTC and set no TZ, which makes every UTC-anchoring guard
    // unfalsifiable there: drop `timeZone: 'UTC'` from TruncatedHistoryBanner
    // or the 'Z' suffix from parseOldestCovered and the suite stays green,
    // because local time and UTC agree. Pin a west-of-UTC zone so the
    // straddle-midnight fixtures exercise the day-shift direction those guards
    // exist to prevent (#221).
    env: { TZ: 'America/Los_Angeles' },
    // Extend (don't replace) Vitest's defaults — a user `exclude` overrides
    // them, and the defaults' `**/node_modules/**` is what keeps a stale git
    // worktree under `.worktrees/*/node_modules` (a full repo checkout) from
    // being globbed and running ~20k third-party package tests. We additionally
    // exclude the worktrees' own source and the separately-tested `worker/`.
    // `.claude/worktrees/` is where Claude Code sessions place their worktrees:
    // without the exclude, a main-clone test run collects a worktree's test
    // files but resolves their `@/` imports against the main clone's src/,
    // failing on any symbol that exists only on the worktree's branch.
    exclude: [
      ...configDefaults.exclude,
      '**/.worktrees/**',
      '**/.claude/worktrees/**',
      'worker/**',
    ],
    onConsoleLog(log) {
      return !log.includes("React Router Future Flag Warning");
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
}});
