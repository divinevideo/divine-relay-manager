// ABOUTME: Durable record of enforcement legs that failed after a case action,
// ABOUTME: so recovery does not depend on a moderator noticing an HTTP 207.

/**
 * Issue #123. A failed enforcement leg was previously reported only in the
 * case-update response body: no DB write, no cron scan, no re-drive. Recovery
 * relied on a moderator reading a toast that disappears on navigation.
 *
 * Scope is deliberately narrow. Only the Keycast account-status leg is recorded
 * and re-driven, because it is the only leg whose idempotency is verified
 * against the service's own source (`set_user_status` is a single unconditional
 * `UPDATE ... RETURNING` keyed on pubkey + tenant; a repeat PUT of the same
 * status returns 200, and the audit row is gated on the status actually
 * changing). The relay legs and the bulk actions are NOT re-driven: their
 * idempotency is unverified, and `banpubkey` / `delete-all` are one-way.
 */

/** The account state a re-drive should converge on. */
export type EnforcementIntent = 'suspended' | 'banned' | 'active';

export type EnforcementLegState = 'failed' | 'resolved' | 'abandoned';

export interface PendingEnforcementLeg {
  pubkey: string;
  intent: EnforcementIntent;
  attempts: number;
}

/**
 * Give-up threshold. A leg that has failed this many times is not a transient
 * blip; it is alerted once and left for a human rather than re-called forever.
 */
export const MAX_ENFORCEMENT_ATTEMPTS = 10;

/**
 * How many legs one cron tick re-drives. Each is a sequential network round trip
 * inside a scheduled invocation with a wall-clock cap, and this work is the
 * lowest-priority thing the cron does, so it stays well clear of that cap rather
 * than draining the backlog as fast as possible. A backlog drains over ticks.
 */
export const REDRIVE_BATCH_LIMIT = 20;

/**
 * Record a failed Keycast status leg, or supersede an existing record.
 *
 * One row per pubkey, not per action: a later moderation action replaces the
 * intent of an earlier one. Re-driving must converge on the CURRENT desired
 * state, never resurrect a superseded one -- a suspend that failed, followed by
 * a successful clear, must not be retried back into a suspension. The attempt
 * count resets with the new intent, since this is a fresh failure.
 */
export async function recordFailedKeycastLeg(
  db: D1Database,
  pubkey: string,
  intent: EnforcementIntent,
  error: string | undefined,
  caseId: string | null,
): Promise<void> {
  const now = new Date().toISOString();
  await db.prepare(`
    INSERT INTO enforcement_legs (pubkey, leg, intent, state, attempts, last_error, case_id, created_at, updated_at)
    VALUES (?, 'keycast_status', ?, 'failed', 0, ?, ?, ?, ?)
    ON CONFLICT(pubkey, leg) DO UPDATE SET
      intent = excluded.intent,
      state = 'failed',
      attempts = 0,
      last_error = excluded.last_error,
      case_id = excluded.case_id,
      updated_at = excluded.updated_at
  `).bind(pubkey, intent, error ?? null, caseId, now, now).run();
}

/**
 * Clear any outstanding record for a pubkey whose leg has now applied.
 *
 * Called on `ok` AND on a not-applicable outcome: an account with no Keycast
 * record has nothing to converge on, so a pending row for it could never be
 * satisfied. Also called when a later action supersedes an earlier failure in
 * the favourable direction.
 *
 * Clears an `abandoned` row too. Abandonment means the re-drive budget ran out,
 * not that the leg is permanently broken: a moderator who re-runs the action
 * successfully has converged it by hand, and leaving the row asserting a failure
 * that no longer exists would have the next genuine failure read against a lie.
 *
 * `expectedIntent` guards the cron's re-drive against a moderator acting in the
 * window between reading the intent and applying it. The stale call still goes
 * out -- that cannot be closed from this side -- but recording it as convergence
 * would leave the account in the superseded state with nothing to correct it.
 * Declining to resolve leaves the row pending so the next tick applies the
 * current intent. The handler passes no intent: it observed the outcome itself.
 */
export async function resolveKeycastLeg(
  db: D1Database,
  pubkey: string,
  expectedIntent?: EnforcementIntent,
): Promise<void> {
  await db.prepare(`
    UPDATE enforcement_legs SET state = 'resolved', updated_at = ?
    WHERE pubkey = ? AND leg = 'keycast_status' AND state IN ('failed', 'abandoned')
      AND (? IS NULL OR intent = ?)
  `).bind(new Date().toISOString(), pubkey, expectedIntent ?? null, expectedIntent ?? null).run();
}

/** Legs still awaiting convergence, oldest attempt first. */
export async function pendingKeycastLegs(db: D1Database): Promise<PendingEnforcementLeg[]> {
  const rows = await db.prepare(`
    SELECT pubkey, intent, attempts FROM enforcement_legs
    WHERE leg = 'keycast_status' AND state = 'failed'
    ORDER BY updated_at LIMIT ${REDRIVE_BATCH_LIMIT}
  `).all<{ pubkey: string; intent: string; attempts: number }>();
  return rows.results
    .filter((row): row is { pubkey: string; intent: EnforcementIntent; attempts: number } =>
      typeof row.pubkey === 'string'
      && (row.intent === 'suspended' || row.intent === 'banned' || row.intent === 'active'))
    .map((row) => ({ pubkey: row.pubkey, intent: row.intent, attempts: row.attempts ?? 0 }));
}

/**
 * Record another unsuccessful attempt. Returns true when the leg has now
 * exhausted its budget and was abandoned, so the caller alerts exactly once.
 */
export async function markKeycastLegAttempt(
  db: D1Database,
  pubkey: string,
  error: string | undefined,
  expectedIntent?: EnforcementIntent,
): Promise<boolean> {
  const now = new Date().toISOString();
  // Intent-guarded for the same reason the resolve is: a moderator may have
  // superseded the row while the call was in flight, and the new intent must
  // start with a full budget and its own error, not inherit the old one's.
  // `last_error` is bounded -- an upstream can answer with kilobytes of HTML.
  const row = await db.prepare(`
    UPDATE enforcement_legs
    SET attempts = attempts + 1, last_error = ?, updated_at = ?,
        state = CASE WHEN attempts + 1 >= ? THEN 'abandoned' ELSE state END
    WHERE pubkey = ? AND leg = 'keycast_status' AND state = 'failed'
      AND (? IS NULL OR intent = ?)
    RETURNING state
  `).bind(
    error?.slice(0, 200) ?? null, now, MAX_ENFORCEMENT_ATTEMPTS, pubkey,
    expectedIntent ?? null, expectedIntent ?? null,
  ).first<{ state: string }>();
  return row?.state === 'abandoned';
}
