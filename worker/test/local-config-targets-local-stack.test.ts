// wrangler.local.toml must not point local dev at deployed infrastructure.
//
// This is not hygiene. handleModerateMedia proxies to MODERATION_ADMIN_URL and
// publishToRelay signs and publishes to RELAY_URL, so a local worker configured
// with production URLs writes production moderation decisions and broadcasts
// signed events to the production relay. Running the admin UI locally and
// clicking a button is enough to do it.
//
// That was the state of this file: MODERATION_SERVICE_URL, MODERATION_ADMIN_URL
// and RELAY_URL all named production. The moderation ones were survivable only
// because whoever ran the stack passed `--var` overrides on the command line,
// which is a habit rather than a safeguard, and RELAY_URL was not overridden at
// all.
//
// The check is deliberately inverted: instead of listing the variables that must
// be local, it finds every variable whose value looks like a URL and requires
// each one to be either local or explicitly excused below. A new outbound URL
// added later fails this test until someone decides which it is, rather than
// silently inheriting a production default.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const LOCAL_TOML = join(HERE, '..', 'wrangler.local.toml');

/**
 * Variables whose value is a URL but which are NOT an outbound call target, or
 * which have no local equivalent. Each needs a reason, because the whole point
 * is that adding to this list is a decision rather than a default.
 */
const NOT_AN_OUTBOUND_TARGET: Record<string, string> = {
  // A CORS allowlist. These are origins we accept requests FROM, not hosts we
  // call, so production values are correct even locally.
  ALLOWED_ORIGINS: 'CORS allowlist, inbound not outbound',
  // A host allowlist for NIP-98 verification. Same reasoning.
  NIP98_PUBLIC_HOST_ALLOWLIST: 'NIP-98 host allowlist, inbound not outbound',
  // AI detection analysis. There is no local realness service to run, and the
  // call reads a verdict rather than writing enforcement, so pointing it at the
  // deployed service is the least-bad option. Revisit if realness ever gains a
  // local target or starts mutating state.
  REALNESS_API_URL: 'no local equivalent; read-only analysis, writes nothing',
};

const LOCAL_HOST_RE = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|.*\.localhost)$/;

/** Every `KEY = "value"` in the [vars] table, in file order. */
function localVars(): Array<{ key: string; value: string; line: number }> {
  const lines = readFileSync(LOCAL_TOML, 'utf8').split('\n');
  const out: Array<{ key: string; value: string; line: number }> = [];
  let inVars = false;
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (line.startsWith('[')) {
      inVars = line === '[vars]';
      return;
    }
    if (!inVars || line.startsWith('#') || !line.includes('=')) return;
    const m = line.match(/^([A-Za-z0-9_]+)\s*=\s*"(.*)"\s*$/);
    if (m) out.push({ key: m[1], value: m[2], line: i + 1 });
  });
  return out;
}

function looksLikeUrl(value: string): boolean {
  return /^(https?|wss?):\/\//.test(value);
}

describe('wrangler.local.toml', () => {
  it('has vars to check', () => {
    // Guard the guard. If the parser stops matching -- a reformat, a move to
    // wrangler.jsonc -- every loop below becomes empty and this file passes
    // while checking nothing, which is the failure mode it exists to prevent.
    expect(localVars().length).toBeGreaterThan(5);
  });

  it('points every outbound URL at the local stack', () => {
    const offenders = localVars()
      .filter((v) => looksLikeUrl(v.value))
      .filter((v) => !(v.key in NOT_AN_OUTBOUND_TARGET))
      .filter((v) => !LOCAL_HOST_RE.test(new URL(v.value).hostname))
      .map((v) => `  wrangler.local.toml:${v.line}  ${v.key} = ${v.value}`);

    expect(
      offenders,
      `Local dev would call deployed infrastructure:\n${offenders.join('\n')}\n\n` +
        `Point these at the local stack, or add the name to NOT_AN_OUTBOUND_TARGET ` +
        `with a reason if it is genuinely not something this worker calls.`,
    ).toEqual([]);
  });

  it('keeps every excused variable documented and still present', () => {
    // An excuse that outlives the variable it excuses is how this list rots into
    // a blanket exemption. If the variable is gone, the entry should go too.
    const names = new Set(localVars().map((v) => v.key));
    for (const [key, reason] of Object.entries(NOT_AN_OUTBOUND_TARGET)) {
      expect(reason.length, `${key} needs a real reason`).toBeGreaterThan(10);
      expect(names.has(key), `${key} is excused but no longer exists in [vars]`).toBe(true);
    }
  });
});
