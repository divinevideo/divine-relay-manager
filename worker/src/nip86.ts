// ABOUTME: NIP-86 Relay Management RPC utilities
// ABOUTME: Handles NIP-98 auth signing and relay RPC calls

import { finalizeEvent, nip19, getPublicKey } from 'nostr-tools';

/**
 * Secrets Store secret object (for account-level secrets)
 */
export interface SecretStoreSecret {
  get(): Promise<string>;
}

/**
 * Minimal env interface for NIP-86 operations
 */
export interface Nip86Env {
  NOSTR_NSEC: string | SecretStoreSecret;
  RELAY_URL: string;
  MANAGEMENT_PATH?: string;
  MANAGEMENT_URL?: string;
}

/**
 * Result from a NIP-86 RPC call
 */
export interface Nip86RpcResult {
  success: boolean;
  result?: unknown;
  error?: string;
}

/**
 * Get the secret key from env (handles both string and Secrets Store)
 */
export async function getSecretKey(env: Pick<Nip86Env, 'NOSTR_NSEC'>): Promise<Uint8Array> {
  const nsec = typeof env.NOSTR_NSEC === 'string'
    ? env.NOSTR_NSEC
    : await env.NOSTR_NSEC.get();

  if (!nsec) {
    throw new Error('NOSTR_NSEC secret not configured');
  }

  const decoded = nip19.decode(nsec);
  if (decoded.type !== 'nsec') {
    throw new Error('Invalid NOSTR_NSEC format - must be nsec1...');
  }

  return decoded.data as Uint8Array;
}

/**
 * Get the public key from the configured secret
 */
export async function getAdminPubkey(env: Pick<Nip86Env, 'NOSTR_NSEC'>): Promise<string> {
  const secretKey = await getSecretKey(env);
  return getPublicKey(secretKey);
}

/**
 * Get the NIP-86 management API URL for the configured relay.
 * If MANAGEMENT_URL is set (for local dev with HTTP), use it directly.
 * Otherwise, converts WSS relay URL to HTTPS and appends the management path.
 */
export function getManagementUrl(env: Pick<Nip86Env, 'RELAY_URL' | 'MANAGEMENT_PATH' | 'MANAGEMENT_URL'>): string {
  if (env.MANAGEMENT_URL) {
    return env.MANAGEMENT_URL;
  }
  const baseUrl = env.RELAY_URL.replace(/^wss?:\/\//, 'https://');
  const managementPath = env.MANAGEMENT_PATH || '/management';
  return `${baseUrl}${managementPath}`;
}

/**
 * Call a NIP-86 RPC method on the relay with NIP-98 authentication.
 *
 * @param method - RPC method name (e.g., 'banevent', 'banpubkey')
 * @param params - Method parameters
 * @param env - Environment with NOSTR_NSEC and relay config
 * @returns Result with success flag and optional result/error
 */
export async function callNip86Rpc(
  method: string,
  params: (string | number | undefined)[],
  env: Nip86Env
): Promise<Nip86RpcResult> {
  const secretKey = await getSecretKey(env);
  const httpUrl = getManagementUrl(env);

  // Build RPC payload
  const payload = JSON.stringify({ method, params: params.filter(p => p !== undefined) });

  // Hash the payload for NIP-98
  const payloadHash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
  const payloadHashHex = Array.from(new Uint8Array(payloadHash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  // Build NIP-98 auth event (kind 27235)
  const authEvent = finalizeEvent(
    {
      kind: 27235,
      content: '',
      tags: [
        ['u', httpUrl],
        ['method', 'POST'],
        ['payload', payloadHashHex],
      ],
      created_at: Math.floor(Date.now() / 1000),
    },
    secretKey
  );

  const authHeader = `Nostr ${btoa(JSON.stringify(authEvent))}`;

  // Build headers for the request
  const headers: Record<string, string> = {
    'Content-Type': 'application/nostr+json+rpc',
    'Authorization': authHeader,
  };

  // For local dev with HTTP, add X-Forwarded headers so Funnelcake
  // validates against http:// instead of converting to https://
  const url = new URL(httpUrl);
  if (url.protocol === 'http:') {
    headers['X-Forwarded-Proto'] = 'http';
    headers['X-Forwarded-Host'] = url.host;
  }

  // Call relay RPC
  const response = await fetch(httpUrl, {
    method: 'POST',
    headers,
    body: payload,
  });

  if (!response.ok) {
    return {
      success: false,
      error: `Relay error: ${response.status} ${response.statusText}`,
    };
  }

  const result = await response.json() as { result?: unknown; error?: string };

  if (result.error) {
    return { success: false, error: result.error };
  }

  return { success: true, result: result.result };
}

/**
 * Ban an event on the relay (hides it from queries)
 */
export async function banEvent(
  eventId: string,
  reason: string,
  env: Nip86Env
): Promise<Nip86RpcResult> {
  return callNip86Rpc('banevent', [eventId, reason], env);
}

/**
 * Unban (allow) an event on the relay
 */
export async function allowEvent(
  eventId: string,
  env: Nip86Env
): Promise<Nip86RpcResult> {
  return callNip86Rpc('allowevent', [eventId], env);
}

/**
 * Ban a pubkey on the relay
 */
export async function banPubkey(
  pubkey: string,
  reason: string,
  env: Nip86Env
): Promise<Nip86RpcResult> {
  return callNip86Rpc('banpubkey', [pubkey, reason], env);
}

/**
 * Unban a pubkey on the relay
 */
export async function unbanPubkey(
  pubkey: string,
  env: Nip86Env
): Promise<Nip86RpcResult> {
  return callNip86Rpc('unbanpubkey', [pubkey], env);
}
