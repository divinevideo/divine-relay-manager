// Deployed wrangler configs must name hosts that answer directly, not legacy
// names that redirect.
//
// login.staging.dvines.org 301s (path-preserving) to login.staging.divine.video,
// the canonical staging keycast host. Workers `fetch` follows redirects by
// default, so a configured hostname that 301s is not the host of the request
// that lands. A cross-origin 301 can also drop Authorization or change method.
// Either way the URL in wrangler is no longer the request that ran.
//
// That was the state of wrangler.staging.toml: KEYCAST_URL named
// login.staging.dvines.org. Point it at the canonical host. Do not claim the
// redirect invents an empty Keycast tenant: the Location host is the same host
// this config now names, so a Host-derived tenant after the hop is the canonical
// one.
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
