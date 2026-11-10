// Deployed wrangler configs must carry both settings the admin API gate needs,
// and the one the moderator login check behind it needs.
//
// verifyAdminAccess accepts a Cf-Access-Jwt-Assertion only when it verifies
// against ACCESS_TEAM_DOMAIN's certs and API_ACCESS_AUD's audience. Without
// either, every Access login is refused and moderators are locked out. Both
// ship in [vars] with the build, so a config missing one fails here instead of
// after a deploy. The audience tag identifies the Access application; it is
// not a credential, because every token Access issues for the application
// carries it.
//
// MODERATOR_LOGIN_URL fails the other way: unset or naming another Keycast,
// every login check fails, and every action records no human moderator with
// only a worker log line to show for it.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

// Reads a top-level [vars] entry only. The same line under any other table (the
// [[d1_databases]] block right after [vars], say) is that table's field, and the
// worker would never see it.
function varOf(tomlPath: string, name: string): string | undefined {
  const lines = readFileSync(join(HERE, '..', tomlPath), 'utf8').split('\n');
  let table = '';
  for (const raw of lines) {
    const line = raw.trim();
    const header = /^\[{1,2}\s*([A-Za-z0-9_.-]+)\s*\]{1,2}/.exec(line);
    if (header) {
      table = header[1];
      continue;
    }
    if (table !== 'vars') continue;
    const match = new RegExp(`^${name}\\s*=\\s*"([^"]*)"\\s*(?:#.*)?$`).exec(line);
    if (match) return match[1];
  }
  return undefined;
}

describe.each(['wrangler.staging.toml', 'wrangler.prod.toml'])('%s', (tomlPath) => {
  it('sets the Access team domain as a bare hostname', () => {
    expect(varOf(tomlPath, 'ACCESS_TEAM_DOMAIN')).toBe('divinevideo.cloudflareaccess.com');
  });

  it('sets the API Access application audience tag', () => {
    // Access AUD tags are 64 lowercase hex characters.
    expect(varOf(tomlPath, 'API_ACCESS_AUD')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('pins MODERATOR_LOGIN_URL to production Keycast', () => {
    // The frontend's login host, VITE_DIVINE_LOGIN_URL, defaults to this one
    // (src/lib/divineLogin.ts) and is not set in .env.production. Change both
    // together: this test does not read the frontend side.
    expect(varOf(tomlPath, 'MODERATOR_LOGIN_URL')).toBe('https://login.divine.video');
  });
});
