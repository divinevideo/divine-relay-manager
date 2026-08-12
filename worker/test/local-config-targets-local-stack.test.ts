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
// be local, it finds every variable whose value contains a URL and requires each
// one to be either local or explicitly excused below. A new outbound URL added
// later fails this test until someone decides which it is, rather than silently
// inheriting a production default.
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
  // There is no realness service to run locally, so this stays pointed at the
  // deployed one. Stated honestly rather than comfortably: handleRealnessViaHTTP
  // forwards a caller-supplied POST body to ${REALNESS_API_URL}/analyze with CF
  // Access credentials attached, so exercising the local admin UI creates real
  // analysis jobs on the deployed service. That is accepted risk, not an
  // absence of risk. Revisit if realness gains a local target.
  REALNESS_API_URL: 'no local equivalent; accepted risk, POST /analyze does reach the deployed service',
};

/**
 * Variables that MUST be present. The guard can only judge what it can see, and
 * several of these have a hardcoded production fallback in the worker when unset
 * (deriveFunnelcakeApiUrl defaults to wss://relay.divine.video, for one). So an
 * absent variable is the same hazard as a wrong one, and invisible without this.
 */
const MUST_BE_SET = [
  'RELAY_URL',
  'FUNNELCAKE_API_URL',
  'MODERATION_SERVICE_URL',
  'MODERATION_ADMIN_URL',
];

const LOCAL_HOST_RE = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|[A-Za-z0-9-]+\.localhost)$/;

// Any quoted string in a value, in any of TOML's spellings. Extracting the
// QUOTED parts rather than taking the rest of the line is what makes a trailing
// comment harmless (`X = "url" # note`) without being fooled by a '#' inside a
// string, and it reaches inside arrays.
const QUOTED_RE = /"""([\s\S]*?)"""|'''([\s\S]*?)'''|"((?:[^"\\]|\\.)*)"|'([^']*)'/g;

type Entry = { key: string; value: string; line: number; table: string };

/**
 * Every string value under any vars table, in file order.
 *
 * Matches `[vars]` and also `[env.<name>.vars]`, because a wrangler environment
 * carries its own vars block and one pointed at production is exactly as
 * dangerous as the top-level table being wrong.
 */
function localVars(): Entry[] {
  const lines = readFileSync(LOCAL_TOML, 'utf8').split(/\r?\n/);
  const out: Entry[] = [];
  let table = '';
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (line.startsWith('#')) return;
    const tableMatch = line.match(/^\[{1,2}\s*([A-Za-z0-9_.-]+)\s*\]{1,2}/);
    if (tableMatch) {
      table = tableMatch[1];
      return;
    }
    if (!(table === 'vars' || table.endsWith('.vars'))) return;
    const m = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
    if (!m) return;
    const [, key, rest] = m;
    for (const q of rest.matchAll(QUOTED_RE)) {
      const value = q[1] ?? q[2] ?? q[3] ?? q[4] ?? '';
      out.push({ key, value, line: i + 1, table });
    }
  });
  return out;
}

// Every URL ANYWHERE in a value, not just one at the start. A value can carry
// several -- ALLOWED_ORIGINS in this very file is comma-joined -- and checking
// only the first lets `http://127.0.0.1:8789/,https://moderation-api.divine.video`
// through, because URL() reads the leading host and treats the rest as a path.
const URL_RE = /(https?|wss?):\/\/[^\s,"']+/g;

function urlsIn(value: string): string[] {
  return [...value.matchAll(URL_RE)].map((m) => m[0]);
}

/** Hostname, or null when something that looks like a URL will not parse. */
function hostnameOf(value: string): string | null {
  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
}

describe('wrangler.local.toml', () => {
  it('parses the vars it is meant to check', () => {
    // Guard the guard. If the parser stops matching -- a reformat, a move to
    // wrangler.jsonc -- every loop below becomes empty and this file passes
    // while checking nothing, which is the failure mode it exists to prevent.
    const vars = localVars();
    expect(vars.length).toBeGreaterThan(5);
    // And it must be reading real URLs, not just counting lines.
    expect(vars.flatMap((v) => urlsIn(v.value)).length).toBeGreaterThan(2);
  });

  it('sets every variable that would otherwise fall back to a deployed default', () => {
    const present = new Set(localVars().map((v) => v.key));
    const missing = MUST_BE_SET.filter((k) => !present.has(k));
    expect(
      missing,
      `Absent from [vars], and the worker falls back to a deployed URL when these ` +
        `are unset, which this test cannot otherwise see: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('points every outbound URL at the local stack', () => {
    const offenders = localVars()
      .filter((v) => !Object.hasOwn(NOT_AN_OUTBOUND_TARGET, v.key))
      .flatMap((v) => urlsIn(v.value).map((url) => ({ ...v, url })))
      .filter((v) => {
        const host = hostnameOf(v.url);
        // Unparseable is suspicious, not safe: report it rather than skip it.
        return host === null || !LOCAL_HOST_RE.test(host);
      })
      .map((v) => `  wrangler.local.toml:${v.line}  [${v.table}] ${v.key} -> ${v.url}`);

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
      expect(names.has(key), `${key} is excused but no longer exists in vars`).toBe(true);
    }
  });
});
