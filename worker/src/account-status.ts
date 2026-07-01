// ABOUTME: Moderator-facing account-status endpoint. Surfaces keycast's durable
// ABOUTME: verified_minor flag (approved protected minor 13-15) for the age-review view.

import { getUserStatus, type KeycastEnv } from './keycast-client';

const HEX_64 = /^[0-9a-f]{64}$/;

function json(
  data: unknown,
  status: number,
  headers: Record<string, string>,
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json' },
  });
}

/**
 * `GET /api/account-status/:pubkey` — the account's keycast status for moderators.
 *
 * Returns the durable `verified_minor` flag (+ `verified_minor_at`) so the
 * age-review view can show whether an account is an approved protected minor.
 * An invalid pubkey is a 400; a keycast failure/misconfiguration degrades to
 * `200 { success: false }` so the moderator UI reads "status unavailable"
 * without blocking the case view.
 */
export async function handleAccountStatus(
  pubkey: string,
  env: KeycastEnv,
  corsHeaders: Record<string, string>,
): Promise<Response> {
  if (!HEX_64.test(pubkey)) {
    return json(
      { success: false, error: 'invalid pubkey: must be 64 hex chars' },
      400,
      corsHeaders,
    );
  }

  const result = await getUserStatus(pubkey, env);
  if (!result.success) {
    return json({ success: false, error: result.error ?? 'unavailable' }, 200, corsHeaders);
  }

  return json(
    {
      success: true,
      pubkey: result.pubkey,
      status: result.status,
      suspended_reason: result.suspended_reason,
      suspended_at: result.suspended_at,
      verified_minor: result.verified_minor ?? false,
      verified_minor_at: result.verified_minor_at,
    },
    200,
    corsHeaders,
  );
}
