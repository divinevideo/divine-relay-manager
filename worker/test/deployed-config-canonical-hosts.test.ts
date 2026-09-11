// Deployed wrangler configs must name hosts that answer directly, not legacy
// names that redirect.
//
// This is not hygiene either. Keycast resolves which tenant a request belongs to
// from the Host header, and get-or-creates a tenant it does not recognise
// (keycast api/src/api/tenant.rs). Workers `fetch` follows redirects by default,
// so a configured hostname that 301s lands on a DIFFERENT host than the one we
// configured, and every account there can come back "user not found" -- which is
// byte-identical to a self-custody account and, after #269, reads as "nothing to
// enforce here" rather than as breakage.
//
// That was the state of wrangler.staging.toml: KEYCAST_URL named
// login.staging.dvines.org, which the staging ingress documents as a legacy
// redirect to login.staging.divine.video.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

/** The canonical domains. `dvines.org` names are legacy redirect targets. */
const LEGACY_DOMAIN = /\bdvines\.org\b/;

function varsOf(tomlPath: string): Array<[string, string]> {
  const text = readFileSync(join(HERE, '..', tomlPath), 'utf8');
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => !line.startsWith('#'))
    .map((line) => /^([A-Z0-9_]+)\s*=\s*"([^"]*)"$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => [match[1], match[2]] as [string, string])
    .filter(([, value]) => value.startsWith('http') || value.startsWith('ws'));
}

describe.each(['wrangler.staging.toml', 'wrangler.prod.toml'])('%s', (tomlPath) => {
  it('names no legacy redirecting host as an outbound target', () => {
    const legacy = varsOf(tomlPath).filter(([, value]) => LEGACY_DOMAIN.test(value));
    expect(legacy).toEqual([]);
  });
});
