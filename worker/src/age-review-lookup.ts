import { type AgeReviewCase, TERMINAL_STATES } from '../../shared/age-review';

// Its own module, not age-review.ts, so bulk-moderate.ts can share it:
// age-review.ts imports bulk-moderate.ts (runBulkModeration), and the
// per-chunk check in processBulkJob must ask exactly what the enqueue guard
// asks (#290).

/**
 * Returns the single active (non-terminal) age-review case for a pubkey, or
 * null. ReportWatcher guarantees at most one active case per pubkey, so this is
 * unambiguous. Throws on a failed query; each caller decides whether that fails
 * open or closed.
 *
 * `anyCase` matches the pubkey in any case. A case stores the report's `p` tag
 * as written, which can be uppercase, while every caller asks with lowercase
 * hex. Callers pass it only where missing such a case would lift a hold the
 * case keeps:
 * - ageReviewActiveGuard when it fails closed: relay-RPC unsuspend and unban,
 *   the loosening bulk enqueue (age-gate-all, un-age-restrict-all), a
 *   note's Restore and any SAFE or AGE_RESTRICTED (moderate-media's account
 *   check and lift guard);
 * - the bulk queue consumer's per-chunk check, which only loosening jobs run;
 * - the active-case route (the case hand-off, the Ban warning and the results
 *   panel's pause).
 * The rest match exactly, as before: ageReviewActiveGuard for relay-RPC
 * suspend and the enforcing bulk enqueue (delete-all, delete-kind,
 * age-restrict-all), where matching in any case would keep no hold and only
 * refuse enforcement, and the Greenlight start (handleStartGreenlight).
 * With `anyCase` the query gives up the pubkey index and keeps the state
 * index, on a small table.
 *
 * Until #313 an account can have an open case under each spelling (an exact
 * insert, such as the Greenlight start's, beside an uppercase report case).
 * With `anyCase` the case stored exactly as asked comes first (the ORDER BY's
 * `pubkey = ?` compares bytes), then the oldest, so the answer is the one the
 * exact match gives whenever there is one, and the same on every read.
 *
 * TODO(#313): drop the case-insensitive match once intake stores lowercase and existing rows read zero.
 */
export async function getActiveAgeReviewCase(
  pubkey: string,
  env: { DB?: D1Database },
  opts: { anyCase?: boolean } = {},
): Promise<AgeReviewCase | null> {
  if (!env.DB) return null;
  const notTerminal = `state NOT IN (${TERMINAL_STATES.map(() => '?').join(',')})`;
  const statement = opts.anyCase
    ? env.DB.prepare(`
      SELECT * FROM age_review_cases
      WHERE pubkey = ? COLLATE NOCASE AND ${notTerminal}
      ORDER BY (pubkey = ?) DESC, created_at, id
      LIMIT 1
    `).bind(pubkey, ...TERMINAL_STATES, pubkey)
    : env.DB.prepare(`
      SELECT * FROM age_review_cases
      WHERE pubkey = ? AND ${notTerminal}
      LIMIT 1
    `).bind(pubkey, ...TERMINAL_STATES);
  const row = await statement.first<AgeReviewCase>();
  return row ?? null;
}
