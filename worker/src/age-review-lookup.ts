import { type AgeReviewCase, TERMINAL_STATES } from '../../shared/age-review';

// Its own module, not age-review.ts, so bulk-moderate.ts can share it:
// age-review.ts imports bulk-moderate.ts (runBulkModeration), and the
// per-chunk check in processBulkJob must ask exactly what the enqueue guard
// asks (#290).

/**
 * Returns the single active (non-terminal) age-review case for a pubkey, or
 * null. ReportWatcher guarantees at most one active case per pubkey, so this is
 * unambiguous. Shared by the by-pubkey lookup endpoint, the relay-RPC and bulk
 * enqueue guard, and the bulk queue consumer. Throws on a failed query; each
 * caller decides whether that fails open or closed.
 */
export async function getActiveAgeReviewCase(
  pubkey: string,
  env: { DB?: D1Database },
): Promise<AgeReviewCase | null> {
  if (!env.DB) return null;
  const row = await env.DB.prepare(`
    SELECT * FROM age_review_cases
    WHERE pubkey = ? AND state NOT IN (${TERMINAL_STATES.map(() => '?').join(',')})
    LIMIT 1
  `).bind(pubkey, ...TERMINAL_STATES).first<AgeReviewCase>();
  return row ?? null;
}
