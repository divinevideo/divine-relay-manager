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

export type KeycastReason = 'age_review' | 'age_review_denied' | 'age_review_expired';

const HEX_64 = /^[0-9a-f]{64}$/;

async function resolveToken(binding: string | SecretStoreSecret | undefined): Promise<string | null> {
  if (!binding) return null;
  const value = typeof binding === 'string' ? binding : await binding.get();
  return value ?? null;
}

async function callKeycast(
  pubkey: string,
  body: { status: string; reason?: KeycastReason },
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

  try {
    const res = await fetch(`${env.KEYCAST_URL}/api/admin/users/${pubkey}/status`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify(body),
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

export async function suspendUser(pubkey: string, reason: KeycastReason, env: KeycastEnv): Promise<KeycastResult> {
  return callKeycast(pubkey, { status: 'suspended', reason }, env);
}

export async function unsuspendUser(pubkey: string, env: KeycastEnv): Promise<KeycastResult> {
  return callKeycast(pubkey, { status: 'active' }, env);
}

export async function banUser(pubkey: string, reason: KeycastReason, env: KeycastEnv): Promise<KeycastResult> {
  return callKeycast(pubkey, { status: 'banned', reason }, env);
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
      pubkey: data.pubkey as string,
      status: data.status as string,
      suspended_reason: data.suspended_reason as string | undefined,
      suspended_at: data.suspended_at as string | undefined,
      verified_minor: data.verified_minor as boolean | undefined,
      verified_minor_at: data.verified_minor_at as string | undefined,
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
    if (displayName) body.display_name = displayName;

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
      pubkey: data.pubkey as string,
      claim_url: data.claim_url as string,
      expires_at: data.expires_at as string,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[keycast] create-minor-account failed: ${msg}`);
    return { success: false, error: msg };
  }
}
