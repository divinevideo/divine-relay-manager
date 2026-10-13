// ABOUTME: Moderator-facing account-status endpoint. Surfaces keycast's durable
// ABOUTME: verified_minor flag and the D1 protected-minor registry for the age-review view.

import { getUserStatus, HEX_64, type KeycastEnv } from './keycast-client';
import { resolveByPubkey } from './protected-minors';

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
 *
 * `protected_minor` is the D1 registry's answer (#192): true when the pubkey has
 * an active protected-minor subject. It is the only signal for an approved minor
 * who holds their own key, since keycast has no account for them. null means
 * unknown (no D1 binding, or the read failed), never "not protected".
 */
export async function handleAccountStatus(
  pubkey: string,
  env: KeycastEnv & { DB?: D1Database },
  corsHeaders: Record<string, string>,
): Promise<Response> {
  if (!HEX_64.test(pubkey)) {
    return json(
      { success: false, error: 'invalid pubkey: must be 64 hex chars' },
      400,
      corsHeaders,
    );
  }

  const [result, protected_minor] = await Promise.all([
    getUserStatus(pubkey, env),
    registryProtection(pubkey, env.DB),
  ]);
  if (!result.success) {
    // not_found (keycast 404) is self-custody — informational, distinct from an
    // unavailable/errored lookup, so the UI can style it non-destructively (#191).
    return json(
      result.notFound
        ? { success: false, not_found: true, protected_minor }
        : { success: false, error: result.error ?? 'unavailable', protected_minor },
      200,
      corsHeaders,
    );
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
      protected_minor,
    },
    200,
    corsHeaders,
  );
}

// Best-effort: a registry failure must not cost the moderator the keycast status.
async function registryProtection(pubkey: string, db: D1Database | undefined): Promise<boolean | null> {
  if (!db) return null;
  try {
    return (await resolveByPubkey(db, pubkey)) !== null;
  } catch (error) {
    console.error('[account-status] Protected-minor registry read failed:', error);
    return null;
  }
}
