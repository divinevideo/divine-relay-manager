// Test-only: submits a parent-consent upload with the SHA-256 digest of its
// exact body, the way the mobile client fills the signed NIP-98 payload tag.
// Not imported by the worker itself.
import { handleParentConsent, type AgeReviewEnv } from '../age-review';

// Pass payloadHash to send that digest instead; an empty string sends none.
export async function submitSignedConsent(
  request: Request, caseId: string, pubkey: string, env: AgeReviewEnv,
  cors: Record<string, string>,
  payloadHash = 'auto',
): Promise<Response> {
  const hash = payloadHash === 'auto'
    ? Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await request.clone().arrayBuffer())), b => b.toString(16).padStart(2, '0')).join('')
    : payloadHash;
  return handleParentConsent(request, caseId, pubkey, env, cors, hash || undefined);
}
