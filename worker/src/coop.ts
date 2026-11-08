// ABOUTME: Request headers for Coop, the moderator review queue: its ingestion key and, when
// ABOUTME: bound, the dedicated Cloudflare Access pair, which is only ever sent over HTTPS.

import type { SecretStoreSecret } from './nip86';

export interface CoopEnv {
  COOP_URL?: string;
  COOP_API_KEY?: string | SecretStoreSecret;
  // Dedicated to Coop's own Access application. Never the shared
  // CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET pair, and never a fallback to it.
  COOP_ACCESS_CLIENT_ID?: string | SecretStoreSecret;
  COOP_ACCESS_CLIENT_SECRET?: string | SecretStoreSecret;
}

/**
 * Headers for a JSON request to Coop at `coopUrl`. The Access pair is sent
 * only when one is bound, and then both halves are required.
 *
 * Throws when the ingestion key or a bound Access pair resolves empty, or
 * when an Access pair would be sent over plain HTTP.
 */
export async function coopHeaders(
  coopUrl: string,
  apiKey: string | SecretStoreSecret,
  env: CoopEnv,
): Promise<Record<string, string>> {
  const key = typeof apiKey === 'string' ? apiKey : await apiKey.get();
  if (!key) throw new Error('Review credentials unavailable');
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'x-api-key': key };
  if (env.COOP_ACCESS_CLIENT_ID !== undefined || env.COOP_ACCESS_CLIENT_SECRET !== undefined) {
    const [clientId, clientSecret] = await Promise.all(
      [env.COOP_ACCESS_CLIENT_ID, env.COOP_ACCESS_CLIENT_SECRET].map(binding =>
        typeof binding === 'string' ? binding : binding?.get()),
    );
    if (!clientId || !clientSecret) throw new Error('Review access credentials unavailable');
    if (new URL(coopUrl).protocol !== 'https:') throw new Error('Review access requires HTTPS');
    headers['CF-Access-Client-Id'] = clientId;
    headers['CF-Access-Client-Secret'] = clientSecret;
  }
  return headers;
}
