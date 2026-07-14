import type { SecretStoreSecret } from './nip86';

export interface KeycastEnv {
  KEYCAST_URL?: string;
  KEYCAST_SERVICE_TOKEN?: string | SecretStoreSecret;
}

export interface KeycastResult {
  success: boolean;
  status?: number;
  error?: string;
}

export type KeycastReason = 'age_review' | 'age_review_denied' | 'age_review_expired' | 'moderation';

export const HEX_64 = /^[0-9a-f]{64}$/;

async function resolveToken(binding: string | SecretStoreSecret | undefined): Promise<string | null> {
  if (!binding) return null;
  const value = typeof binding === 'string' ? binding : await binding.get();
  return value ?? null;
}

async function callKeycast(
  pubkey: string,
  body: { status: string; reason?: KeycastReason },
  env: KeycastEnv,
  actor?: string,
): Promise<KeycastResult> {
  if (!env.KEYCAST_URL || !env.KEYCAST_SERVICE_TOKEN) {
    return { success: false, error: 'not configured' };
  }

  if (!HEX_64.test(pubkey)) {
    return { success: false, error: 'invalid pubkey: must be 64 hex chars' };
  }

  const token = await resolveToken(env.KEYCAST_SERVICE_TOKEN);
  if (!token) {
    return { success: false, error: 'not configured' };
  }

  // Optional moderator attribution: a valid actor makes keycast write a durable
  // admin_audit_events row for the status change (keycast#295 contract /
  // keycast#279). A malformed actor is dropped (keycast 400s on it, which would
  // fail the whole status change) so keycast falls back to log-only. Mirrors
  // clearVerifiedMinor.
  // TODO(#178): no caller passes an actor on the status legs yet. Attributing a
  // status change needs a verified moderator identity (#178); until it lands the
  // status legs call through actor-less. This lands the relay-manager side of the
  // keycast#295 contract so it and keycast can deploy independently.
  const payload: { status: string; reason?: KeycastReason; actor?: string } = { ...body };
  if (actor) {
    if (HEX_64.test(actor)) {
      payload.actor = actor;
    } else {
      console.warn(`[keycast] dropping malformed actor for ${body.status} on ${pubkey}; audit falls back to log-only`);
    }
  }

  try {
    const res = await fetch(`${env.KEYCAST_URL}/api/admin/users/${pubkey}/status`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(`[keycast] ${body.status} failed for ${pubkey}: ${res.status} ${text}`);
      return { success: false, status: res.status, error: `${res.status}: ${text}` };
    }

    return { success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[keycast] ${body.status} failed for ${pubkey}: ${msg}`);
    return { success: false, error: msg };
  }
}

export async function suspendUser(pubkey: string, reason: KeycastReason, env: KeycastEnv, actor?: string): Promise<KeycastResult> {
  return callKeycast(pubkey, { status: 'suspended', reason }, env, actor);
}

/**
 * Set a Keycast account back to `active`. Lifts BOTH `suspended` and `banned`
 * (Keycast uses a single status transition), so this is the restore path for
 * unsuspend AND unban.
 */
export async function unsuspendUser(pubkey: string, env: KeycastEnv, actor?: string): Promise<KeycastResult> {
  return callKeycast(pubkey, { status: 'active' }, env, actor);
}

export async function banUser(pubkey: string, reason: KeycastReason, env: KeycastEnv, actor?: string): Promise<KeycastResult> {
  return callKeycast(pubkey, { status: 'banned', reason }, env, actor);
}

/**
 * Clear a Keycast account's verified_minor flag (protected-minor revocation,
 * issue #147; endpoint from keycast#265). Composes with the status calls —
 * the status outcome stays the caller's decision, this only lifts the flag.
 * Keycast's clear is an idempotent success no-op on never-minor /
 * already-cleared accounts and only writes a durable admin_audit_events row
 * on a real transition, so callers invoke it unconditionally on revoke/deny
 * without a pre-read. `actor` (moderator hex pubkey) and `reason` feed that
 * audit row; a malformed actor is dropped (keycast 400s on it, which would
 * fail the whole clear) so keycast falls back to log-only. Only the
 * revoke-direction reasons are valid here (age_review_denied / _expired);
 * `cleared` is deliberately not a clear trigger (see age-review.ts).
 */
export async function clearVerifiedMinor(
  pubkey: string,
  actor: string | undefined,
  reason: KeycastReason | undefined,
  env: KeycastEnv,
): Promise<KeycastResult> {
  if (!env.KEYCAST_URL || !env.KEYCAST_SERVICE_TOKEN) {
    return { success: false, error: 'not configured' };
  }

  if (!HEX_64.test(pubkey)) {
    return { success: false, error: 'invalid pubkey: must be 64 hex chars' };
  }

  const token = await resolveToken(env.KEYCAST_SERVICE_TOKEN);
  if (!token) {
    return { success: false, error: 'not configured' };
  }

  const params = new URLSearchParams();
  if (actor) {
    if (HEX_64.test(actor)) {
      params.set('actor', actor);
    } else {
      console.warn(`[keycast] dropping malformed actor for verified_minor clear on ${pubkey}; audit falls back to log-only`);
    }
  }
  if (reason) {
    params.set('reason', reason);
  }
  const qs = params.size > 0 ? `?${params.toString()}` : '';

  try {
    const res = await fetch(`${env.KEYCAST_URL}/api/admin/users/${pubkey}/verified-minor${qs}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${token}`,
      },
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(`[keycast] verified_minor clear failed for ${pubkey}: ${res.status} ${text}`);
      return { success: false, status: res.status, error: `${res.status}: ${text}` };
    }

    return { success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[keycast] verified_minor clear failed for ${pubkey}: ${msg}`);
    return { success: false, error: msg };
  }
}

export interface UserStatusResult {
  success: boolean;
  pubkey?: string;
  status?: string;
  suspended_reason?: string;
  suspended_at?: string;
  verified_minor?: boolean;
  verified_minor_at?: string;
  error?: string;
}

export async function getUserStatus(pubkey: string, env: KeycastEnv): Promise<UserStatusResult> {
  if (!env.KEYCAST_URL || !env.KEYCAST_SERVICE_TOKEN) {
    return { success: false, error: 'not configured' };
  }
  if (!HEX_64.test(pubkey)) {
    return { success: false, error: 'invalid pubkey: must be 64 hex chars' };
  }
  const token = await resolveToken(env.KEYCAST_SERVICE_TOKEN);
  if (!token) {
    return { success: false, error: 'not configured' };
  }
  try {
    const res = await fetch(`${env.KEYCAST_URL}/api/admin/users/${pubkey}/status`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!res.ok) {
      const text = await res.text();
      return { success: false, error: `${res.status}: ${text}` };
    }
    const data = await res.json() as Record<string, unknown>;
    return {
      success: true,
      pubkey: typeof data.pubkey === 'string' ? data.pubkey : undefined,
      status: typeof data.status === 'string' ? data.status : undefined,
      suspended_reason: typeof data.suspended_reason === 'string' ? data.suspended_reason : undefined,
      suspended_at: typeof data.suspended_at === 'string' ? data.suspended_at : undefined,
      verified_minor: data.verified_minor === true,
      verified_minor_at: typeof data.verified_minor_at === 'string' ? data.verified_minor_at : undefined,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: msg };
  }
}

export interface CreateMinorAccountResult {
  success: boolean;
  pubkey?: string;
  claim_url?: string;
  expires_at?: string;
  error?: string;
}

export async function createMinorAccount(
  username: string,
  displayName: string | undefined,
  env: KeycastEnv,
): Promise<CreateMinorAccountResult> {
  if (!env.KEYCAST_URL || !env.KEYCAST_SERVICE_TOKEN) {
    return { success: false, error: 'not configured' };
  }
  const token = await resolveToken(env.KEYCAST_SERVICE_TOKEN);
  if (!token) {
    return { success: false, error: 'not configured' };
  }
  try {
    const body: Record<string, string> = { username };
    if (displayName !== undefined) body.display_name = displayName;

    const res = await fetch(`${env.KEYCAST_URL}/api/admin/create-minor-account`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      console.error(`[keycast] create-minor-account failed: ${res.status} ${text}`);
      return { success: false, error: `${res.status}: ${text}` };
    }
    const data = await res.json() as Record<string, unknown>;
    return {
      success: true,
      pubkey: typeof data.pubkey === 'string' ? data.pubkey : undefined,
      claim_url: typeof data.claim_url === 'string' ? data.claim_url : undefined,
      expires_at: typeof data.expires_at === 'string' ? data.expires_at : undefined,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[keycast] create-minor-account failed: ${msg}`);
    return { success: false, error: msg };
  }
}
