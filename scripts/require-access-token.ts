// The relay-manager API hosts accept only the Cloudflare Access service token,
// which the browser sends from these two values. Vite drops the code that
// sends it when they are unset (src/lib/adminApi.ts), so a production build
// without them succeeds, deploys, and then has every API call refused before
// it reaches the worker. They live in the gitignored .env.local, which a fresh
// clone or worktree does not have.
//
// Only production builds are stopped. `npm test` and the PR checklist build in
// development mode to check the code compiles, and CI has no token.
const REQUIRED = ['VITE_CF_ACCESS_CLIENT_ID', 'VITE_CF_ACCESS_CLIENT_SECRET'] as const;

export function requireAccessToken(
  command: 'build' | 'serve',
  mode: string,
  env: Record<string, string | undefined>,
): void {
  if (command !== 'build' || mode !== 'production') return;
  const missing = REQUIRED.filter((name) => !env[name]?.trim());
  if (missing.length === 0) return;
  throw new Error(
    `Production build stopped: ${missing.join(', ')} not set. ` +
    'A page built without them cannot reach the relay-manager API, because Cloudflare Access refuses every call. ' +
    'Copy .env.local into this folder (a fresh clone or worktree does not have it) and build again. ' +
    'To check the code compiles without deploying it, run `npx vite build --mode development`.',
  );
}
