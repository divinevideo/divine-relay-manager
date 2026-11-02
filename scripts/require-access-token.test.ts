// A production build without the Cloudflare Access service token deploys
// cleanly and then fails every API call: Access answers each one with a
// redirect to its login page, the browser reports "NetworkError", and the
// worker never sees a request. These tests pin that such a build stops, and
// that the builds which only check the code compiles do not.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireAccessToken } from './require-access-token';

const token = {
  VITE_CF_ACCESS_CLIENT_ID: 'id.access',
  VITE_CF_ACCESS_CLIENT_SECRET: 'secret',
};

describe('requireAccessToken', () => {
  it('stops a production build that has neither token value', () => {
    expect(() => requireAccessToken('build', 'production', {}))
      .toThrow(/VITE_CF_ACCESS_CLIENT_ID, VITE_CF_ACCESS_CLIENT_SECRET/);
  });

  it('stops a production build missing either value, or holding a blank one', () => {
    expect(() => requireAccessToken('build', 'production', { ...token, VITE_CF_ACCESS_CLIENT_ID: '' }))
      .toThrow(/VITE_CF_ACCESS_CLIENT_ID/);
    expect(() => requireAccessToken('build', 'production', { VITE_CF_ACCESS_CLIENT_ID: 'id.access', VITE_CF_ACCESS_CLIENT_SECRET: '  ' }))
      .toThrow(/VITE_CF_ACCESS_CLIENT_SECRET/);
  });

  it('says how to fix it, including how to build without deploying', () => {
    expect(() => requireAccessToken('build', 'production', {}))
      .toThrow(/\.env\.local[\s\S]*--mode development/);
  });

  it('lets a production build with both values through', () => {
    expect(() => requireAccessToken('build', 'production', token)).not.toThrow();
  });

  it('lets a check build in development mode through without the token', () => {
    expect(() => requireAccessToken('build', 'development', {})).not.toThrow();
  });

  it('leaves the dev server, vite preview and the test runner alone', () => {
    expect(() => requireAccessToken('serve', 'development', {})).not.toThrow();
    expect(() => requireAccessToken('serve', 'production', {})).not.toThrow();
    expect(() => requireAccessToken('serve', 'test', {})).not.toThrow();
  });

  it('checks only the production mode, which is the one that gets deployed', () => {
    expect(() => requireAccessToken('build', 'staging', {})).not.toThrow();
  });
});

describe('vite.config.ts', () => {
  // The check only helps if the build runs it, with the mode it builds in.
  // Loading the config here would pull in esbuild, which rejects jsdom's
  // TextEncoder, so this reads the source like the other scripts/ checks.
  it('runs the check with the command and mode Vite builds in', () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'vite.config.ts'), 'utf8');
    expect(source).toMatch(/defineConfig\(\(\{ command, mode \}\) => \{\s*requireAccessToken\(command, mode, loadEnv\(mode, /);
  });
});
