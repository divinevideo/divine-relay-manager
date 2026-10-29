// ABOUTME: Verifies a Cloudflare Access JWT (RS256 signature against the team's
// ABOUTME: certs, issuer, audience, expiry) and returns its claims; caches the certs.

// The Worker checks the token itself rather than trusting that the header is
// present: the header only proves Access saw the request if every way into the
// Worker runs through Access, and service bindings and workers.dev/preview URLs
// do not.
//
// The claims say who Access let through, which is not always a person. The
// relay-manager UI calls the API with a shared Access service token, so on that
// path the claims carry the token's client id (common_name), not a moderator's
// email. Per-moderator identity needs a verified Divine login (issue #178).

export type FetchFn = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

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
export type AccessJwtRejection =
  | 'not-configured' | 'malformed' | 'algorithm' | 'issuer' | 'audience'
  | 'expired' | 'certs-unavailable' | 'unknown-key' | 'signature';

type Jwk = JsonWebKey & { kid?: string };

interface CertsEntry {
  keys: Jwk[];
  fetchedAt: number;
}

// Cloudflare rotates Access signing keys every six weeks and publishes the new
// key alongside the old, so an hour-old copy is fine. A token whose kid isn't in
// the copy triggers one early refetch, at most once a minute whether or not it
// succeeds, so a stream of forged kids can't turn every request into a certs
// fetch. The slot is claimed before the fetch is awaited, so concurrent forged
// requests don't each refetch.
//
// Concurrent requests on a cold or expired cache each fetch the certs rather
// than sharing one in-flight promise: Workers can stall a request that awaits
// a promise another request's I/O resolves. That costs a few duplicate fetches
// per isolate per hour.
const CERTS_TTL_MS = 60 * 60 * 1000;
const UNKNOWN_KID_REFETCH_MS = 60 * 1000;
// A hung certs endpoint would otherwise hold every moderator request open.
const CERTS_FETCH_TIMEOUT_MS = 5 * 1000;

const certsCache = new Map<string, CertsEntry>();
const unknownKidRefetchAt = new Map<string, number>();

// Test-only: module state persists across tests in one worker.
export function __resetAccessCertsCacheForTests(): void {
  certsCache.clear();
  unknownKidRefetchAt.clear();
}

const B64URL = /^[A-Za-z0-9_-]+$/;

function b64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

// A failed fetch, or one that lists no keys, is not cached: the next request
// tries again.
async function fetchCerts(teamDomain: string, fetchFn: FetchFn, nowMs: number): Promise<CertsEntry | null> {
  try {
    const res = await fetchFn(`https://${teamDomain}/cdn-cgi/access/certs`, {
      signal: AbortSignal.timeout(CERTS_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { keys?: Jwk[] };
    if (!Array.isArray(body.keys) || body.keys.length === 0) return null;
    const entry = { keys: body.keys, fetchedAt: nowMs };
    certsCache.set(teamDomain, entry);
    return entry;
  } catch {
    return null;
  }
}

async function findKey(
  kid: string, teamDomain: string, fetchFn: FetchFn, nowMs: number,
): Promise<Jwk | 'certs-unavailable' | 'unknown-key'> {
  let entry = certsCache.get(teamDomain);
  if (!entry || nowMs - entry.fetchedAt >= CERTS_TTL_MS) {
    entry = (await fetchCerts(teamDomain, fetchFn, nowMs)) ?? undefined;
    if (!entry) return 'certs-unavailable';
  }
  const jwk = entry.keys.find((k) => k.kid === kid);
  if (jwk) return jwk;
  const lastRefetch = Math.max(entry.fetchedAt, unknownKidRefetchAt.get(teamDomain) ?? 0);
  if (nowMs - lastRefetch < UNKNOWN_KID_REFETCH_MS) return 'unknown-key';
  unknownKidRefetchAt.set(teamDomain, nowMs);
  const refreshed = await fetchCerts(teamDomain, fetchFn, nowMs);
  return refreshed?.keys.find((k) => k.kid === kid) ?? 'unknown-key';
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
      iss?: unknown; aud?: unknown; exp?: unknown; sub?: unknown; email?: unknown; common_name?: unknown;
    };
    if (header.alg !== 'RS256') return reject('algorithm');
    if (typeof header.kid !== 'string' || !header.kid) return reject('malformed');
    if (payload.iss !== `https://${teamDomain}`) return reject('issuer');
    const audiences = (Array.isArray(payload.aud) ? payload.aud : [payload.aud]).filter((a): a is string => typeof a === 'string');
    if (!audiences.includes(audience)) return reject('audience');
    const nowMs = now();
    if (typeof payload.exp !== 'number' || payload.exp <= Math.floor(nowMs / 1000)) return reject('expired');

    const jwk = await findKey(header.kid, teamDomain, fetchFn, nowMs);
    if (typeof jwk === 'string') return reject(jwk);
    const key = await crypto.subtle.importKey(
      'jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'],
    );
    const valid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5', key,
      b64UrlDecode(signaturePart) as Uint8Array<ArrayBuffer>,
      new TextEncoder().encode(`${headerPart}.${payloadPart}`),
    );
    if (!valid) return reject('signature');
    return {
      iss: payload.iss,
      aud: audiences,
      exp: payload.exp,
      ...(typeof payload.sub === 'string' ? { sub: payload.sub } : {}),
      ...(typeof payload.email === 'string' ? { email: payload.email } : {}),
      ...(typeof payload.common_name === 'string' ? { common_name: payload.common_name } : {}),
    };
  } catch {
    // Undecodable header or payload, or a published key WebCrypto won't import.
    return reject('malformed');
  }
}
