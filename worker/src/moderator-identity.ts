// ABOUTME: Verifies a moderator's Divine login (a Keycast bearer token) and returns their pubkey.
// ABOUTME: The worker trusts this verified pubkey, never a moderator pubkey named in a request body.

export const MODERATOR_LOGIN_HEADER = 'X-Divine-Login-Token';
export const MODERATOR_LOGIN_REQUIRED = 'moderator_login_required';

export interface ModeratorLoginEnv {
  MODERATOR_LOGIN_URL?: string;
}

const HEX_64 = /^[0-9a-f]{64}$/;
const VERIFY_TIMEOUT_MS = 3000;
const CACHE_TTL_MS = 60 * 1000;

// SHA-256 hex of token -> verified pubkey. Keyed on a hash so the raw token is
// never held as a map key. Only successes are cached, so a moderator who signs
// in again recovers at once, and a revoked login stops working within the TTL.
const cache = new Map<string, { pubkey: string; expiresAt: number }>();

/** Test-only: reset the cache between cases. */
export function __clearModeratorLoginCache(): void {
  cache.clear();
}

/** Test-only: number of cached entries. */
export function __moderatorLoginCacheSize(): number {
  return cache.size;
}

async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

// The reason is a status code or an error name, never a message: an error
// message could echo the token back.
function warnFailed(reason: string | number): void {
  console.warn(`[moderator-identity] login check failed: ${reason}`);
}

/**
 * Verify a moderator's Divine login by asking Keycast for the token's public key.
 * Returns the verified lowercase 64-hex pubkey, or undefined on any failure
 * (no token, no setting, 401, 5xx, timeout, bad body). The whole body sits in
 * the try because a Secrets Store binding can throw on read.
 */
export async function verifyModeratorLogin(
  env: ModeratorLoginEnv,
  token: string | null | undefined,
): Promise<string | undefined> {
  try {
    if (!token) return undefined;
    const baseUrl = env.MODERATOR_LOGIN_URL;
    if (!baseUrl) {
      warnFailed('MODERATOR_LOGIN_URL not set');
      return undefined;
    }

    const key = await hashToken(token);
    const hit = cache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.pubkey;
    if (hit) cache.delete(key);

    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/nostr`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ method: 'get_public_key', params: [] }),
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });

    if (!res.ok) {
      warnFailed(res.status);
      return undefined;
    }

    const data = (await res.json()) as { result?: unknown };
    const pubkey = typeof data.result === 'string' ? data.result : undefined;
    if (!pubkey || !HEX_64.test(pubkey)) {
      warnFailed('malformed result');
      return undefined;
    }

    // Sweep on write so entries for tokens never seen again do not pile up.
    const now = Date.now();
    for (const [k, v] of cache) {
      if (v.expiresAt <= now) cache.delete(k);
    }
    cache.set(key, { pubkey, expiresAt: now + CACHE_TTL_MS });
    return pubkey;
  } catch (err) {
    warnFailed(err instanceof Error ? err.name : 'unknown error');
    return undefined;
  }
}

/**
 * Log when a request body still names a moderator that differs from the
 * verified one, so a stale or spoofing client is visible. The claim is never
 * acted on. A claim that is not 64-hex is logged as "malformed" rather than
 * echoed, since it is arbitrary client input.
 */
export function noteClaimedModerator(route: string, claimed: unknown, verified: string | undefined): void {
  if (typeof claimed !== 'string' || verified === undefined) return;
  const lowered = claimed.toLowerCase();
  if (lowered === verified) return;
  const named = HEX_64.test(lowered) ? lowered : 'malformed';
  console.warn(`[moderator-identity] ${route}: claimed moderator ${named} differs from verified ${verified}`);
}

/** Gate for routes that need an identified moderator: 401 unless a login verified. */
export function requireVerifiedModerator(
  verified: string | undefined,
  corsHeaders: Record<string, string>,
): { pubkey: string } | Response {
  if (verified === undefined) {
    return new Response(
      JSON.stringify({ success: false, error: 'Sign in with Divine to continue', code: MODERATOR_LOGIN_REQUIRED }),
      { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
  return { pubkey: verified };
}
