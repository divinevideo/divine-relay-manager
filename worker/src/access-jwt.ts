// ABOUTME: Verifies a Cloudflare Access JWT (RS256 signature against the team's
// ABOUTME: certs, then issuer, audience, exp, nbf) and returns its claims; caches the keys.

// The Worker checks the token itself rather than trusting that the header is
// present: the header only proves Access saw the request if every way into the
// Worker runs through Access, and service bindings and workers.dev/preview URLs
// do not.
//
// The claims say who Access let through, which is not always a person. The
// relay-manager UI calls the API with a shared Access service token, so on that
// path the claims carry the token's client id (common_name), not a moderator's
// email. Per-moderator identity needs a verified Divine login (issue #178).

import { errorNameOnly } from './error-name';

export type FetchFn = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status?: number; json: () => Promise<unknown> }>;

export interface AccessClaims {
  iss: string;
  aud: string[];
  exp: number;
  sub?: string;
  // Set for a person who logged in through Access.
  email?: string;
  // Set instead of email for a service token: its client id.
  common_name?: string;
}

// Why a token was refused, for logs. Never includes the token or its claims.
// Only malformed, algorithm, unknown-key and signature can come from a crafted
// token: the claim reasons are checked after the signature.
export type AccessJwtRejection =
  | 'not-configured' | 'malformed' | 'algorithm' | 'issuer' | 'audience'
  | 'expired' | 'not-yet-valid' | 'certs-unavailable' | 'unknown-key' | 'signature';

type Jwk = JsonWebKey & { kid?: string };
type AccessKey = { kid: string; key: CryptoKey };

interface CertsEntry {
  keys: AccessKey[];
  fetchedAt: number;
  generation: number;
}

// Cloudflare rotates Access signing keys every six weeks and publishes the new
// key alongside the old, so an hour-old copy is fine. A token whose kid isn't in
// the copy triggers one early refetch, at most once a minute whether or not it
// succeeds, so a stream of forged kids can't turn every request into a certs
// fetch. The slot is claimed before the fetch is awaited, so concurrent forged
// requests don't each refetch. The cost, accepted: right after Cloudflare starts
// signing with a new key, requests that arrive while that refetch is in flight,
// or within a minute of the last fetch, are refused as unknown-key until the
// next refetch. Cloudflare publishes the new key well before it signs with it,
// so the hourly refresh usually has it first.
//
// The other side of the hour, also accepted: a key Cloudflare withdraws stays
// trusted until this copy expires. The consent-video route shares this cache.
//
// Concurrent requests on a cold or expired cache each fetch the certs rather
// than sharing one in-flight promise: Workers can stall a request that awaits
// a promise another request's I/O resolves. That costs a few duplicate fetches
// per isolate per hour. Once a fetch has failed, requests on a cold or expired
// cache refuse without fetching for a short backoff, and then one request at a
// time retries, so a down or hanging certs endpoint costs one fetch per window
// rather than one per request.
const CERTS_TTL_MS = 60 * 60 * 1000;
const UNKNOWN_KID_REFETCH_MS = 60 * 1000;
const CERTS_FAILURE_BACKOFF_MS = 10 * 1000;
// A hung certs endpoint would otherwise hold every moderator request open.
const CERTS_FETCH_TIMEOUT_MS = 5 * 1000;

const certsCache = new Map<string, CertsEntry>();
const unknownKidRefetchAt = new Map<string, number>();
const certsFailedAt = new Map<string, number>();
let fetchGeneration = 0;

// Test-only: module state persists across tests in one worker.
export function __resetAccessCertsCacheForTests(): void {
  certsCache.clear();
  unknownKidRefetchAt.clear();
  certsFailedAt.clear();
  fetchGeneration = 0;
}

const B64URL = /^[A-Za-z0-9_-]+$/;

function b64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

// A failed fetch, or one with no usable key, is not cached: the next request
// after the backoff tries again.
async function fetchCerts(teamDomain: string, fetchFn: FetchFn, now: () => number): Promise<CertsEntry | null> {
  const generation = ++fetchGeneration;
  const fetchedAt = now();
  const fail = (detail: string) => {
    console.warn(`[auth] Access certs fetch failed: ${detail}`);
    certsFailedAt.set(teamDomain, now());
    return null;
  };
  try {
    const res = await fetchFn(`https://${teamDomain}/cdn-cgi/access/certs`, {
      signal: AbortSignal.timeout(CERTS_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return fail(`HTTP ${res.status}`);
    const body = (await res.json()) as { keys?: Jwk[] };
    if (!Array.isArray(body.keys) || body.keys.length === 0) return fail('no keys');
    // An entry we can't use is skipped rather than refusing the document, so
    // one unsupported key published beside the RSA keys can't lock everyone
    // out. A skipped key never enters the cache, so a token it signed is still
    // refused (unknown-key). The log names only the reason, never the entry.
    const keys: AccessKey[] = [];
    for (const jwk of body.keys) {
      if (!jwk || typeof jwk.kid !== 'string' || !jwk.kid || jwk.kty !== 'RSA') {
        console.warn('[auth] Access certs: skipped a key entry: invalid key entry');
        continue;
      }
      try {
        const key = await crypto.subtle.importKey(
          'jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'],
        );
        keys.push({ kid: jwk.kid, key });
      } catch {
        console.warn('[auth] Access certs: skipped a key entry: unimportable key');
      }
    }
    if (keys.length === 0) return fail('no usable keys');
    // A later-started fetch can finish first, including within one clock tick.
    // Publish only imported key sets and never roll a newer one back.
    const cached = certsCache.get(teamDomain);
    if (cached && cached.generation > generation) return cached;
    const entry = { keys, fetchedAt, generation };
    certsCache.set(teamDomain, entry);
    return entry;
  } catch (error) {
    return fail(errorNameOnly(error));
  }
}

async function findKey(
  kid: string, teamDomain: string, fetchFn: FetchFn, now: () => number,
): Promise<AccessKey | 'certs-unavailable' | 'unknown-key'> {
  const nowMs = now();
  let entry = certsCache.get(teamDomain);
  if (!entry || nowMs - entry.fetchedAt >= CERTS_TTL_MS) {
    // Only a failure since this copy expired counts: an earlier one (an
    // unknown-kid refetch blip, or a losing concurrent fetch) says nothing
    // about the endpoint now.
    const failedAt = certsFailedAt.get(teamDomain);
    if (failedAt !== undefined && (!entry || failedAt >= entry.fetchedAt + CERTS_TTL_MS)) {
      if (nowMs - failedAt < CERTS_FAILURE_BACKOFF_MS) return 'certs-unavailable';
      // Claim the retry before awaiting it, so a hanging endpoint costs one
      // fetch per window rather than one per request until the timeout.
      certsFailedAt.set(teamDomain, nowMs);
    }
    entry = (await fetchCerts(teamDomain, fetchFn, now)) ?? undefined;
    if (!entry) return 'certs-unavailable';
  }
  const jwk = entry.keys.find((k) => k.kid === kid);
  if (jwk) return jwk;
  const lastRefetch = Math.max(entry.fetchedAt, unknownKidRefetchAt.get(teamDomain) ?? 0);
  if (nowMs - lastRefetch < UNKNOWN_KID_REFETCH_MS) return 'unknown-key';
  unknownKidRefetchAt.set(teamDomain, nowMs);
  const refreshed = await fetchCerts(teamDomain, fetchFn, now);
  // A failed refetch is an unreachable endpoint, not evidence the kid is bogus.
  if (!refreshed) return 'certs-unavailable';
  return refreshed.keys.find((k) => k.kid === kid) ?? 'unknown-key';
}

// Returns the token's claims when it verifies against `audience`, otherwise null
// (and tells onReject why). Missing configuration refuses: nothing is accepted
// without both settings.
export async function verifyAccessJwt(
  token: string,
  config: { teamDomain?: string; audience?: string; onReject?: (reason: AccessJwtRejection) => void },
  fetchFn: FetchFn = fetch as FetchFn,
  now: () => number = Date.now,
): Promise<AccessClaims | null> {
  const { teamDomain, audience } = config;
  const reject = (reason: AccessJwtRejection) => {
    config.onReject?.(reason);
    return null;
  };
  if (!teamDomain || !audience) return reject('not-configured');
  const parts = token.split('.');
  if (parts.length !== 3 || !parts.every((part) => B64URL.test(part))) return reject('malformed');
  const [headerPart, payloadPart, signaturePart] = parts;
  try {
    const header = JSON.parse(new TextDecoder().decode(b64UrlDecode(headerPart))) as { kid?: unknown; alg?: unknown };
    const payload = JSON.parse(new TextDecoder().decode(b64UrlDecode(payloadPart))) as {
      iss?: unknown; aud?: unknown; exp?: unknown; nbf?: unknown; sub?: unknown; email?: unknown; common_name?: unknown;
    };
    if (header.alg !== 'RS256') return reject('algorithm');
    if (typeof header.kid !== 'string' || !header.kid) return reject('malformed');

    // The signature is checked before any claim, so a refusal for issuer,
    // audience, exp or nbf always describes a token Access signed.
    const jwk = await findKey(header.kid, teamDomain, fetchFn, now);
    if (typeof jwk === 'string') return reject(jwk);
    const valid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5', jwk.key,
      b64UrlDecode(signaturePart) as Uint8Array<ArrayBuffer>,
      new TextEncoder().encode(`${headerPart}.${payloadPart}`),
    );
    if (!valid) return reject('signature');

    if (payload.iss !== `https://${teamDomain}`) return reject('issuer');
    const audiences = (Array.isArray(payload.aud) ? payload.aud : [payload.aud]).filter((a): a is string => typeof a === 'string');
    if (!audiences.includes(audience)) return reject('audience');
    const nowS = Math.floor(now() / 1000);
    if (typeof payload.exp !== 'number' || payload.exp <= nowS) return reject('expired');
    // RFC 7519 permits small clock-skew leeway for an optional NumericDate nbf.
    if (payload.nbf !== undefined && (typeof payload.nbf !== 'number' || !Number.isFinite(payload.nbf)
      || payload.nbf > nowS + 30)) return reject('not-yet-valid');
    return {
      iss: payload.iss,
      aud: audiences,
      exp: payload.exp,
      ...(typeof payload.sub === 'string' ? { sub: payload.sub } : {}),
      ...(typeof payload.email === 'string' ? { email: payload.email } : {}),
      ...(typeof payload.common_name === 'string' ? { common_name: payload.common_name } : {}),
    };
  } catch {
    // Undecodable header, payload or signature.
    return reject('malformed');
  }
}
