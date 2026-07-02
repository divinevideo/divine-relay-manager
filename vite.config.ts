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
    setupFiles: './src/test/setup.ts',
    // Extend (don't replace) Vitest's defaults — a user `exclude` overrides
    // them, and the defaults' `**/node_modules/**` is what keeps a stale git
    // worktree under `.worktrees/*/node_modules` (a full repo checkout) from
    // being globbed and running ~20k third-party package tests. We additionally
    // exclude the worktrees' own source and the separately-tested `worker/`.
    exclude: [...configDefaults.exclude, '**/.worktrees/**', 'worker/**'],
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
