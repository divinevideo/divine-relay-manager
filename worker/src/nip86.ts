// ABOUTME: NIP-86 Relay Management RPC utilities
// ABOUTME: Handles NIP-98 auth signing and relay RPC calls

import { finalizeEvent, nip19, getPublicKey } from 'nostr-tools';
import { coordinateEventVisibility } from './event-visibility';

const NIP86_RPC_TIMEOUT_MS = 15_000;
// Follow-up read after a banpubkey that errored or timed out. It runs after
// the ban has already used its full bound, so 15s + 5s leaves room inside the
// browser's 30s API bound. Later steps (e.g. the Zendesk sync) can still push
// a request past it; the browser then re-checks the ban list itself.
const BAN_CONFIRM_TIMEOUT_MS = 5_000;

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
  REPORT_WATCHER?: DurableObjectNamespace;
}

/**
 * Result from a NIP-86 RPC call
 */
export interface Nip86RpcResult {
  success: boolean;
  result?: unknown;
  error?: string;
  /** We stopped waiting: the relay had not answered within the bound. */
  timedOut?: true;
}

// AbortSignal.timeout rejects with a DOMException named TimeoutError. Checked by
// name rather than instanceof Error, which DOMException need not satisfy.
function isTimeout(error: unknown): boolean {
  return (error as { name?: unknown } | null)?.name === 'TimeoutError';
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
 * Otherwise, maps wss→https and ws→http, then appends the management path.
 */
export function getManagementUrl(env: Pick<Nip86Env, 'RELAY_URL' | 'MANAGEMENT_PATH' | 'MANAGEMENT_URL'>): string {
  if (env.MANAGEMENT_URL) {
    return env.MANAGEMENT_URL;
  }
  // Map each scheme to its counterpart rather than forcing https. Collapsing both
  // onto https made ws:// unusable: a local relay serving plain HTTP was called
  // over TLS and every management request died on the handshake. This matches
  // deriveFunnelcakeApiUrl, which already derives the two the same way from the
  // same value. Deployed configs set wss:// and are unaffected.
  const baseUrl = env.RELAY_URL
    .replace(/^wss:\/\//, 'https://')
    .replace(/^ws:\/\//, 'http://');
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
  env: Nip86Env,
  timeoutMs: number = NIP86_RPC_TIMEOUT_MS,
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
  let response: Response;
  try {
    response = await fetch(httpUrl, {
      method: 'POST',
      headers,
      body: payload,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Relay request failed',
      ...(isTimeout(error) && { timedOut: true as const }),
    };
  }

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
  env: Nip86Env,
  humanAction: string = 'hide_event',
): Promise<Nip86RpcResult> {
  if (env.REPORT_WATCHER) {
    // ReportWatcher itself must call callNip86Rpc directly while holding its gate.
    return coordinateEventVisibility(env, { eventId, relayAction: 'hide', reason, humanAction });
  }
  return callNip86Rpc('banevent', [eventId, reason], env);
}

/**
 * Unban (allow) an event on the relay
 */
export async function allowEvent(
  eventId: string,
  env: Nip86Env
): Promise<Nip86RpcResult> {
  if (env.REPORT_WATCHER) {
    // ReportWatcher itself must call callNip86Rpc directly while holding its gate.
    return coordinateEventVisibility(env, { eventId, relayAction: 'allow', humanAction: 'allow_event' });
  }
  return callNip86Rpc('allowevent', [eventId], env);
}

/**
 * Result of a pubkey ban. Every failure carries `code: 'ban_unconfirmed'`:
 * a relay error or timeout does not rule out that the ban applied, and the
 * rare failure before any request (e.g. a missing key) is reported the same way.
 */
export interface BanPubkeyResult extends Nip86RpcResult {
  /**
   * The relay errored or did not answer in time, but its ban list shows the
   * pubkey. The ban is in effect; its content removal was not confirmed.
   */
  contentRemovalUnconfirmed?: true;
  /**
   * With contentRemovalUnconfirmed: the relay had not answered when we
   * stopped waiting. Absent means the call failed some other way (a relay or
   * gateway error, a network error, an unreadable response).
   */
  relayTimedOut?: true;
  /** The banpubkey error that the ban-list read overrode. */
  relayError?: string;
  code?: 'ban_unconfirmed';
}

/**
 * Ban a pubkey on the relay.
 *
 * Funnelcake writes the ban before capturing the export snapshot and purging
 * content, which can take far longer than our bound, and it reports a purge
 * error as a failed ban although "the ban itself remains in effect". So when
 * banpubkey errors or times out we read the ban list before failing. Treating
 * a landed ban as failed is not a harmless false alarm: the relay keys a ban
 * by the NIP-98 auth event id, which is new on every call, so a retry is a
 * second enforcement (new banned_at, a new export snapshot taken after the
 * purge, and the purge run again).
 */
export async function banPubkey(
  pubkey: string,
  reason: string,
  env: Nip86Env
): Promise<BanPubkeyResult> {
  let result: Nip86RpcResult;
  try {
    result = await callNip86Rpc('banpubkey', [pubkey, reason], env);
  } catch (error) {
    // callNip86Rpc throws, rather than returns, in two cases, neither of them
    // "still working": the response body could not be read (headers had
    // arrived, and funnelcake sends them only once the ban has run), or it
    // failed before sending anything (e.g. a missing signing key).
    result = { success: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (result.success) return result;

  const relayError = result.error || 'banpubkey failed';
  if (await isPubkeyOnBanList(pubkey, env)) {
    console.error(
      `[banPubkey] ALERT: banpubkey reported "${relayError}" but ${pubkey} is on the ban list; ` +
      'treating the ban as applied. Content removal was not confirmed.',
    );
    return {
      success: true,
      contentRemovalUnconfirmed: true,
      ...(result.timedOut && { relayTimedOut: true as const }),
      relayError,
    };
  }
  return { success: false, code: 'ban_unconfirmed', error: `Ban not confirmed: ${relayError}` };
}

/**
 * Whether the relay's ban list includes the pubkey. Any failure to read it
 * answers false: callers use this only to upgrade a failure to a success, so
 * an unreadable list must leave the failure standing.
 */
async function isPubkeyOnBanList(pubkey: string, env: Nip86Env): Promise<boolean> {
  let list: Nip86RpcResult;
  try {
    list = await callNip86Rpc('listbannedpubkeys', [], env, BAN_CONFIRM_TIMEOUT_MS);
  } catch (error) {
    console.error('[banPubkey] Ban-list read failed:', error);
    return false;
  }
  // An RPC error carries no result, so this also covers a failed read.
  if (!Array.isArray(list.result)) return false;
  // NIP-86 returns { pubkey, reason? } objects; accept bare strings as well.
  return list.result.some(entry =>
    (typeof entry === 'string' ? entry : (entry as { pubkey?: unknown } | null)?.pubkey) === pubkey,
  );
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

/**
 * Suspend a pubkey on the relay (REVERSIBLE). Funnelcake hides the pubkey's
 * existing events at serve time and rejects new writes, without the destructive
 * purge that banpubkey performs. Use for age-review restriction; reverse with
 * unsuspendPubkey on clear. Params mirror banpubkey: [pubkey, reason].
 */
export async function suspendPubkey(
  pubkey: string,
  reason: string,
  env: Nip86Env
): Promise<Nip86RpcResult> {
  return callNip86Rpc('suspendpubkey', [pubkey, reason], env);
}

/**
 * Un-suspend a pubkey on the relay. Existing content becomes visible again once
 * Funnelcake's suspended-pubkeys materialized view refreshes (~5 min); new
 * writes are re-allowed immediately.
 */
export async function unsuspendPubkey(
  pubkey: string,
  env: Nip86Env
): Promise<Nip86RpcResult> {
  return callNip86Rpc('unsuspendpubkey', [pubkey], env);
}
