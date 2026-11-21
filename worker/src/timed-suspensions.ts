// ABOUTME: Timed (auto-expiring) suspensions: the per-account record (one row per pubkey), its
// ABOUTME: compare-and-swap writes, the decision-row helper, and the I/O seam a lift runs through.
import { checkSuspensionDuration, DURATION_ERROR, SUSPENSION_ACTIONS, suspensionEndsAt, type TimedSuspensionView } from '../../shared/suspension';
import { ageReviewActiveGuard, type AgeReviewEnv } from './age-review';
import { markHumanReviewed } from './human-decision';
import type { KeycastResult } from './keycast-client';
import type { SuspensionEntry } from './suspended-content';

export type SuspensionRecordStatus = 'active' | 'lifting' | 'keycast_pending' | 'lifted'
  | 'already_lifted' | 'cancelled_unsuspend' | 'cancelled_ban';

export interface SuspensionRecord {
  pubkey: string; ends_at: string | null; status: SuspensionRecordStatus;
  set_by: string | null; set_at: string; changed_by: string | null; changed_at: string | null;
  version: number; attempts: number; last_error: string | null; last_attempt_at: string | null;
  last_alerted_at: string | null; claimed_at: string | null;
}

// Every ends_at comparison elsewhere must use datetime(ends_at): ISO text ('T') sorts after
// datetime('now') (' ') on the same day, so a lexical compare delays expiry to midnight.

export async function getSuspensionRecord(db: D1Database, pubkey: string): Promise<SuspensionRecord | null> {
  return db.prepare('SELECT * FROM timed_suspensions WHERE pubkey = ?').bind(pubkey).first<SuspensionRecord>();
}

// Accounts still suspended: 'lifting' counts (a lift in flight, or a stuck claim, has not
// finished, and the account is still suspended on the relay). The tick selects its own due
// rows and does not use this.
export async function listInForceSuspensions(db: D1Database): Promise<SuspensionRecord[]> {
  const { results } = await db.prepare(
    `SELECT * FROM timed_suspensions WHERE status IN ('active','lifting','cancelled_ban') ORDER BY set_at`,
  ).all<SuspensionRecord>();
  return results;
}

// A new suspension (or re-suspension) starts a clean active record. Refused (false) while a
// lift is in flight: the tick's 'lifting' claim must not be overwritten mid-relay-call, or the
// lift would complete against a suspension the moderator just renewed (F12). One statement, so
// the status check and the write cannot be split by a claim.
export async function replaceSuspensionRecord(
  db: D1Database,
  a: { pubkey: string; endsAt: string | null; moderator: string | null },
): Promise<boolean> {
  const now = new Date().toISOString();
  const res = await db.prepare(`
    INSERT INTO timed_suspensions (pubkey, ends_at, status, set_by, set_at)
    VALUES (?, ?, 'active', ?, ?)
    ON CONFLICT(pubkey) DO UPDATE SET
      ends_at = excluded.ends_at, status = 'active', set_by = excluded.set_by, set_at = excluded.set_at,
      changed_by = NULL, changed_at = NULL, attempts = 0, last_error = NULL, last_attempt_at = NULL,
      last_alerted_at = NULL, claimed_at = NULL, version = timed_suspensions.version + 1
    WHERE timed_suspensions.status <> 'lifting'
  `).bind(a.pubkey, a.endsAt, a.moderator, now).run();
  return res.meta.changes > 0;
}

// True when a live record was ended. Terminal rows (and absent ones) are left alone.
export async function endSuspensionRecord(
  db: D1Database,
  pubkey: string,
  status: 'cancelled_unsuspend' | 'already_lifted',
): Promise<boolean> {
  const res = await db.prepare(`
    UPDATE timed_suspensions SET status = ?, changed_by = NULL, changed_at = ?, version = version + 1
    WHERE pubkey = ? AND status IN ('active','lifting','keycast_pending','cancelled_ban')
  `).bind(status, new Date().toISOString(), pubkey).run();
  return res.meta.changes > 0;
}

export type ChangeEndResult =
  { kind: 'changed'; previousEndsAt: string | null; created: boolean } | { kind: 'ending' } | { kind: 'conflict' };

// Read-then-write under a version guard, so a lift or a second moderator landing in between
// makes this write lose ('conflict') instead of silently overriding it.
export async function changeSuspensionEnd(
  db: D1Database,
  a: { pubkey: string; endsAt: string | null; moderator: string | null },
): Promise<ChangeEndResult> {
  const row = await getSuspensionRecord(db, a.pubkey);
  const now = new Date().toISOString();

  if (row && (row.status === 'lifting' || row.status === 'keycast_pending')) return { kind: 'ending' };

  if (row && (row.status === 'active' || row.status === 'cancelled_ban')) {
    const res = await db.prepare(`
      UPDATE timed_suspensions
      SET ends_at = ?, changed_by = ?, changed_at = ?, status = 'active', attempts = 0, last_error = NULL,
          last_alerted_at = NULL, version = version + 1
      WHERE pubkey = ? AND version = ?
    `).bind(a.endsAt, a.moderator, now, a.pubkey, row.version).run();
    return res.meta.changes > 0
      ? { kind: 'changed', previousEndsAt: row.ends_at, created: false }
      : { kind: 'conflict' };
  }

  if (row) {
    // lifted / already_lifted / cancelled_unsuspend: a new suspension period starts here.
    const res = await db.prepare(`
      UPDATE timed_suspensions
      SET ends_at = ?, status = 'active', set_by = ?, set_at = ?, changed_by = NULL, changed_at = NULL,
          attempts = 0, last_error = NULL, last_attempt_at = NULL, last_alerted_at = NULL, claimed_at = NULL,
          version = version + 1
      WHERE pubkey = ? AND version = ?
    `).bind(a.endsAt, a.moderator, now, a.pubkey, row.version).run();
    return res.meta.changes > 0 ? { kind: 'changed', previousEndsAt: null, created: true } : { kind: 'conflict' };
  }

  const res = await db.prepare(`
    INSERT INTO timed_suspensions (pubkey, ends_at, status, set_by, set_at)
    VALUES (?, ?, 'active', ?, ?)
    ON CONFLICT(pubkey) DO NOTHING
  `).bind(a.pubkey, a.endsAt, a.moderator, now).run();
  return res.meta.changes > 0 ? { kind: 'changed', previousEndsAt: null, created: true } : { kind: 'conflict' };
}

type CasFields = Partial<Pick<SuspensionRecord,
  'status' | 'attempts' | 'last_error' | 'last_attempt_at' | 'last_alerted_at' | 'claimed_at'>>;
const CAS_COLUMNS = ['status', 'attempts', 'last_error', 'last_attempt_at', 'last_alerted_at', 'claimed_at'] as const;

// Compare-and-swap on the version the caller read. False means someone else got there first.
export async function casSuspensionRecord(
  db: D1Database,
  pubkey: string,
  expectedVersion: number,
  set: CasFields,
): Promise<boolean> {
  // undefined means leave the column alone; an explicit null clears it.
  const cols = CAS_COLUMNS.filter(c => set[c] !== undefined);
  const assignments = [...cols.map(c => `${c} = ?`), 'version = version + 1'].join(', ');
  const values = cols.map(c => set[c] as string | number | null);
  const res = await db.prepare(`UPDATE timed_suspensions SET ${assignments} WHERE pubkey = ? AND version = ?`)
    .bind(...values, pubkey, expectedVersion).run();
  return res.meta.changes > 0;
}

// Best effort: a failure here never blocks the suspension change itself. Only a human action
// marks the account human reviewed; the timer's own rows must not. False also covers a failed
// markHumanReviewed: deliberately stricter than handleLogDecision, because that mark is what
// stops auto-hide overriding the decision.
export async function recordSuspensionDecision(
  db: D1Database,
  a: { pubkey: string; action: string; reason: string; moderator: string | null; human: boolean },
): Promise<boolean> {
  try {
    await db.prepare(`
      INSERT INTO moderation_decisions (target_type, target_id, action, reason, moderator_pubkey)
      VALUES ('pubkey', ?, ?, ?, ?)
    `).bind(a.pubkey, a.action, a.reason, a.moderator).run();
    if (a.human && !(await markHumanReviewed(db, 'pubkey', a.pubkey))) return false;
    return true;
  } catch (error) {
    console.error('[recordSuspensionDecision] Failed to record decision:', error);
    return false;
  }
}

// The row must be one still in force (see listInForceSuspensions): any status other than
// cancelled_ban reads as active here.
export function toSuspensionView(r: SuspensionRecord): TimedSuspensionView {
  return {
    pubkey: r.pubkey,
    endsAt: r.ends_at,
    // A lift in flight still leaves the account suspended, so it reads as active.
    status: r.status === 'cancelled_ban' ? 'cancelled_ban' : 'active',
    setBy: r.set_by,
    setAt: r.set_at,
    changedAt: r.changed_at,
  };
}

// ---------------------------------------------------------------------------
// I/O seam. Built in index.ts (liveSuspensionIo), where notifyModerationService
// lives, so this module never imports index.ts; tests pass fakes.
// ---------------------------------------------------------------------------

export type AccountNoticeAction =
  'ACCOUNT_SUSPENDED' | 'ACCOUNT_BANNED' | 'ACCOUNT_RESTORED' | 'ACCOUNT_SUSPENSION_CHANGED';
export type KeycastStatusRead = 'active' | 'suspended' | 'banned' | 'none' | 'unknown';

export interface SuspensionIo {
  readBan(pubkey: string): Promise<boolean | 'unknown'>;
  readSuspension(pubkey: string): Promise<SuspensionEntry | 'unknown'>;
  readKeycastStatus(pubkey: string): Promise<KeycastStatusRead>;
  hasOpenAgeReviewCase(pubkey: string): Promise<boolean>; // throws when it cannot tell
  relayUnsuspend(pubkey: string): Promise<{ success: boolean; error?: string }>;
  keycastActivate(pubkey: string, actor?: string): Promise<KeycastResult>;
  keycastSuspend(pubkey: string, actor?: string): Promise<KeycastResult>;
  notify(pubkey: string, action: AccountNoticeAction, reason: string, endsAt?: string): Promise<void>;
  alert(text: string): Promise<boolean>;
}

export type KeycastLeg = 'ok' | 'not_applicable' | 'failed';

// What follows a relay unsuspend, for both the manual Unsuspend and the timer: the one
// "restored" notice, then Keycast back to active. Never throws. The notice goes first and
// its failure does not stop the Keycast call; the Keycast result is returned because the
// timer retries a failed leg without sending the notice again.
export async function restoreAfterLift(
  io: SuspensionIo,
  pubkey: string,
  a: { reason: string; moderator?: string },
): Promise<KeycastLeg> {
  try {
    await io.notify(pubkey, 'ACCOUNT_RESTORED', a.reason);
  } catch (error) {
    console.error(`[restoreAfterLift] restored notice failed for ${pubkey}:`, error);
  }
  try {
    const res = await io.keycastActivate(pubkey, a.moderator);
    if (res.success) return 'ok';
    if (res.notFound) {
      // Self-custody: no Keycast account, and the relay lift is the whole restore (#269).
      console.log(`[restoreAfterLift] Keycast activate not applicable for ${pubkey}: no keycast account`);
      return 'not_applicable';
    }
    console.error(`[restoreAfterLift] Keycast activate failed for ${pubkey}: ${res.error}`);
    return 'failed';
  } catch (error) {
    console.error(`[restoreAfterLift] Keycast activate threw for ${pubkey}:`, error);
    return 'failed';
  }
}

// ---------------------------------------------------------------------------
// Routes: list timed suspensions, change a suspension's end date.
// ---------------------------------------------------------------------------

const jsonOut = (data: Record<string, unknown>, status: number, cors: Record<string, string>) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...cors } });

export async function handleListSuspensions(
  env: { DB?: D1Database },
  corsHeaders: Record<string, string>,
): Promise<Response> {
  if (!env.DB) return jsonOut({ success: false, error: 'Database not configured' }, 503, corsHeaders);
  try {
    const rows = await listInForceSuspensions(env.DB);
    return jsonOut({ success: true, suspensions: rows.map(toSuspensionView) }, 200, corsHeaders);
  } catch (error) {
    console.error('[handleListSuspensions] read failed:', error);
    return jsonOut({ success: false, error: 'Could not read timed suspensions' }, 503, corsHeaders);
  }
}

const refuse = (cors: Record<string, string>, status: number, code: string, error: string) =>
  jsonOut({ success: false, error, code }, status, cors);

// Change (or add) the end date of an account that is suspended on the relay. The relay is
// the source of truth for "suspended", so it is read fresh and an unreadable list refuses
// (never "not suspended"). Keycast is left alone: only the end date moves.
export async function handleChangeSuspensionEnd(
  request: Request,
  env: AgeReviewEnv,
  corsHeaders: Record<string, string>,
  ctx: ExecutionContext | undefined,
  moderator: string | undefined,
  io: SuspensionIo,
): Promise<Response> {
  let body: { pubkey?: unknown; duration?: unknown };
  try {
    body = await request.json() as typeof body;
  } catch {
    return refuse(corsHeaders, 400, 'invalid_pubkey', 'Request body must be JSON with a pubkey and a duration');
  }
  if (typeof body.pubkey !== 'string' || !/^[0-9a-f]{64}$/.test(body.pubkey)) {
    return refuse(corsHeaders, 400, 'invalid_pubkey', 'pubkey must be 64 lowercase hex characters');
  }
  const pubkey = body.pubkey;
  const checked = checkSuspensionDuration(body.duration);
  if (!checked.ok) return refuse(corsHeaders, 400, 'invalid_duration', DURATION_ERROR);
  const db = env.DB;
  if (!db) return refuse(corsHeaders, 503, 'db_unavailable', 'Database not configured');

  const guarded = await ageReviewActiveGuard(pubkey, env, corsHeaders,
    'This account is under age review. Its suspension is handled from the Age Review flow.',
    { failClosed: true });
  if (guarded) return guarded;

  const [ban, entry, keycast] = await Promise.all([
    io.readBan(pubkey), io.readSuspension(pubkey), io.readKeycastStatus(pubkey),
  ]);
  const banned = refuse(corsHeaders, 409, 'account_banned', 'This account is banned. A ban has no end date to change.');
  // A known ban wins over an unreadable suspension list. Keycast 'unknown' does not block.
  if (ban === true || keycast === 'banned') return banned;
  // 'unknown' is checked before any value is read: an unreadable list is not "not suspended".
  if (ban === 'unknown' || entry === 'unknown') {
    return refuse(corsHeaders, 503, 'status_unavailable', 'Could not read the account status from the relay. Try again.');
  }
  if (!entry.suspended) {
    return refuse(corsHeaders, 409, 'not_suspended', 'This account is not suspended, so there is no end date to change.');
  }

  const endsAt = suspensionEndsAt(checked.duration, new Date());
  const changed = await changeSuspensionEnd(db, { pubkey, endsAt, moderator: moderator ?? null });
  if (changed.kind === 'ending') {
    return refuse(corsHeaders, 409, 'suspension_ending', 'This suspension is ending now. Check again in a few minutes.');
  }
  if (changed.kind === 'conflict') {
    return refuse(corsHeaders, 409, 'conflict', 'The suspension changed while you were editing it. Refresh and try again.');
  }

  const decisionRecorded = await recordSuspensionDecision(db, {
    pubkey, action: SUSPENSION_ACTIONS.change,
    reason: `Ends ${endsAt}; was ${changed.previousEndsAt ?? 'no end date'}`,
    moderator: moderator ?? null, human: true,
  });
  // Best effort, and off the response path: the end date is already saved. An older
  // moderation-service ignores the unknown action, so a failed or ignored send is harmless.
  const sent = io.notify(pubkey, 'ACCOUNT_SUSPENSION_CHANGED', 'Suspension end changed', endsAt)
    .catch(error => console.error(`[handleChangeSuspensionEnd] notice failed for ${pubkey}:`, error));
  if (ctx) ctx.waitUntil(sent); else await sent;
  return jsonOut({ success: true, endsAt, decisionRecorded }, 200, corsHeaders);
}

// ---------------------------------------------------------------------------
// The scheduler tick: lifts timed suspensions whose end has passed. It unsuspends accounts on
// its own, so it fails closed: any read it cannot trust (ban list, Keycast status, suspended
// list, age-review check) leaves the account suspended and records a failed attempt for retry
// and, past LIFT_ALERT_AFTER_ATTEMPTS, an alert. It never unsuspends on a guess.
// ---------------------------------------------------------------------------

export const LIFT_ALERT_AFTER_ATTEMPTS = 3;
export const STALE_CLAIM_MINUTES = 15;
export const TICK_BATCH = 25;
const ALERT_THROTTLE_HOURS = 12;
const ALERT_ERROR_CHARS = 200;
// Slack truncates or refuses very large messages; the rest are summarised as "+N more".
const ALERT_MAX_LINES = 50;
const STORED_ERROR_CHARS = 1000;
const TIMER_REASON = 'Timed suspension ended';
const RECOVERED_REASON = 'Timed suspension ended (recovered; restored message may not have gone out)';

// lifted counts relay lifts that this tick completed, even if the step after them (the
// pre-restore re-check, or Keycast) then failed; that row is also counted in failed. failed can
// also count one row twice when the write reverting a failed relay call itself throws. keycastSettled counts
// Phase 2 rows finished. recovered counts stale 'lifting' claims released in Phase 0.
export interface TickSummary { lifted: number; alreadyLifted: number; cancelledByBan: number;
  waiting: number; failed: number; keycastSettled: number; recovered: number }

// The version and attempts the next write must compare against. Updated after each CAS this
// tick wins, so a throw part-way through records its attempt against the row as it now is.
interface RowCursor { pubkey: string; version: number; attempts: number }

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export async function runTimedSuspensionTick(
  env: { DB: D1Database; ENVIRONMENT?: string },
  io: SuspensionIo,
  now: Date = new Date(),
): Promise<TickSummary> {
  const db = env.DB;
  const nowIso = now.toISOString();
  const summary: TickSummary = {
    lifted: 0, alreadyLifted: 0, cancelledByBan: 0, waiting: 0, failed: 0, keycastSettled: 0, recovered: 0,
  };
  // One-off events alerted once in Phase 3 whatever the attempt count: Phase 0 recoveries, and
  // Phase 1 lifts whose restored message was withheld on an unreadable ban re-read.
  const eventLines = new Map<string, string>();
  // Rows Phase 1 handled. Phase 2 leaves them to the next tick, so a Keycast step that just
  // failed is not retried at once.
  const handledInPhase1 = new Set<string>();

  const cas = async (cur: RowCursor, set: CasFields): Promise<boolean> => {
    const won = await casSuspensionRecord(db, cur.pubkey, cur.version, set);
    if (won) {
      cur.version += 1;
      if (set.attempts !== undefined) cur.attempts = set.attempts;
    }
    return won;
  };

  // A failed attempt: the status is left as it is, so the row is retried next tick.
  const fail = async (cur: RowCursor, error: string): Promise<void> => {
    summary.failed += 1;
    console.error(`[timedSuspensionTick] attempt failed for ${cur.pubkey}: ${error}`);
    try {
      await cas(cur, {
        attempts: cur.attempts + 1, last_error: error.slice(0, STORED_ERROR_CHARS), last_attempt_at: nowIso,
      });
    } catch (casError) {
      console.error(`[timedSuspensionTick] could not record the failed attempt for ${cur.pubkey}:`, errorText(casError));
    }
  };

  // Each row in its own try/catch: a throw is a failed attempt for that row only.
  const eachRow = async (rows: SuspensionRecord[], step: (row: SuspensionRecord, cur: RowCursor) => Promise<void>) => {
    for (const row of rows) {
      const cur: RowCursor = { pubkey: row.pubkey, version: row.version, attempts: row.attempts };
      try {
        await step(row, cur);
      } catch (error) {
        await fail(cur, errorText(error));
      }
    }
  };

  // An open case holds the timer (no attempt, no alert). Anything but a plain yes or no,
  // including a throw, is unknown: fail closed.
  const ageReviewHold = async (cur: RowCursor): Promise<'hold' | 'clear' | 'failed'> => {
    let open: unknown;
    try {
      open = await io.hasOpenAgeReviewCase(cur.pubkey);
    } catch (error) {
      await fail(cur, `age-review check failed: ${errorText(error)}`);
      return 'failed';
    }
    if (open === true) return 'hold';
    if (open === false) return 'clear';
    await fail(cur, 'age-review check gave no answer');
    return 'failed';
  };

  // Re-checked immediately before anything that restores the account (the restored message,
  // Keycast activate). A ban (banpubkey never touches this record) or a moderator's change can
  // land after the tick's first reads, and keycastActivate is the same call unban uses, so a
  // stale read could otherwise undo it. The ban is read first and the record last, so the
  // record read sits closest to the action. Fails closed: anything but "not banned, record
  // unchanged" leaves the row for retry.
  // messageWithheld: Phase 1 calls this after the relay lift and before the one restored
  // message. Phase 2 finishes Keycast later but never sends that message (decision 14), so an
  // unreadable re-read there means the person would never be told: alert, for a hand send.
  // (A ban needs no message; a moderator's change sends its own.)
  const clearToRestore = async (cur: RowCursor, a: { messageWithheld: boolean }): Promise<boolean> => {
    let ban: boolean | 'unknown';
    let why = '';
    try {
      ban = await io.readBan(cur.pubkey);
    } catch (error) {
      ban = 'unknown';
      why = `: ${errorText(error)}`;
    }
    if (ban !== false) {
      if (ban !== true && a.messageWithheld) {
        eventLines.set(cur.pubkey,
          `• ${cur.pubkey}: keycast step, the relay lift landed but the ban list could not be re-read, so the `
          + 'restored message was not sent; send it by hand once the account is confirmed not banned');
      }
      await fail(cur, ban === true
        ? 'banned before the restore'
        : `relay ban list unreadable before the restore${why}`);
      return false;
    }
    const current = await getSuspensionRecord(db, cur.pubkey);
    if (current?.version !== cur.version) {
      // A moderator acted: their change stands, and nothing is written over it.
      console.log(`[timedSuspensionTick] ${cur.pubkey} changed before the restore; skipped`);
      return false;
    }
    return true;
  };

  // Phase 0: release 'lifting' claims a crashed or timed-out tick left behind. A claim whose
  // time cannot be read counts as stale, so a row is never stuck in 'lifting' for good.
  try {
    const { results: stale } = await db.prepare(`
      SELECT * FROM timed_suspensions
      WHERE status = 'lifting' AND (datetime(claimed_at) IS NULL OR datetime(claimed_at) < datetime(?, ?))
      ORDER BY claimed_at LIMIT ?
    `).bind(nowIso, `-${STALE_CLAIM_MINUTES} minutes`, TICK_BATCH).all<SuspensionRecord>();
    await eachRow(stale, async (row, cur) => {
      const entry = await io.readSuspension(row.pubkey);
      if (entry === 'unknown') return fail(cur, 'relay suspended list unreadable (stale claim)');
      if (entry.suspended) {
        // The lift never landed: back to active, and Phase 1 retries it.
        if (await cas(cur, { status: 'active', claimed_at: null })) {
          summary.recovered += 1;
          eventLines.set(row.pubkey,
            `• ${row.pubkey}: relay step, stale lift claim recovered; the lift had not landed, so it was returned to active for retry`);
        }
        return;
      }
      // The relay lift landed but the tick stopped before recording it, so the restored
      // message and the decision row may be missing. Finish only the Keycast step.
      if (await cas(cur, { status: 'keycast_pending', attempts: 0, last_error: null, claimed_at: null })) {
        summary.recovered += 1;
        await recordSuspensionDecision(db, {
          pubkey: row.pubkey, action: SUSPENSION_ACTIONS.autoUnsuspend, reason: RECOVERED_REASON,
          moderator: null, human: false,
        });
        eventLines.set(row.pubkey,
          `• ${row.pubkey}: keycast step, stale lift claim recovered; the relay lift had landed, `
          + 'so the restored message may not have gone out');
      }
    });
  } catch (error) {
    console.error('[timedSuspensionTick] stale-claim recovery failed:', errorText(error));
  }

  // Phase 1: due lifts. datetime(ends_at), never a plain text compare (see the note at the top).
  // Fewest failed attempts first, so rows that keep failing cannot starve newer due rows out of
  // the batch. Waiting on an open age-review case adds no attempt, so a waiting row keeps the
  // attempts it had and its place in that order; such rows are bounded by the number of open
  // age-review cases.
  try {
    const { results: due } = await db.prepare(`
      SELECT * FROM timed_suspensions
      WHERE status = 'active' AND ends_at IS NOT NULL AND datetime(ends_at) <= datetime(?)
      ORDER BY attempts, ends_at LIMIT ?
    `).bind(nowIso, TICK_BATCH).all<SuspensionRecord>();
    await eachRow(due, async (row, cur) => {
      const pubkey = row.pubkey;
      handledInPhase1.add(pubkey);
      // allSettled, so a read that throws never leaves the other running unawaited. A throw
      // reads as unknown, and a known ban from the other source still wins.
      const [banRead, keycastRead] = await Promise.allSettled([io.readBan(pubkey), io.readKeycastStatus(pubkey)]);
      const ban = banRead.status === 'fulfilled' ? banRead.value : 'unknown';
      const keycast = keycastRead.status === 'fulfilled' ? keycastRead.value : 'unknown';
      const why = (read: PromiseSettledResult<unknown>) =>
        (read.status === 'rejected' ? `: ${errorText(read.reason)}` : '');
      // A known ban wins, even over an unreadable answer from the other source.
      if (ban === true || keycast === 'banned') {
        if (await cas(cur, { status: 'cancelled_ban' })) {
          summary.cancelledByBan += 1;
          await recordSuspensionDecision(db, {
            pubkey, action: SUSPENSION_ACTIONS.cancelTimer, reason: 'Account is banned', moderator: null, human: false,
          });
        }
        return;
      }
      if (ban !== false) return fail(cur, `relay ban list unreadable${why(banRead)}`);
      if (keycast !== 'active' && keycast !== 'suspended' && keycast !== 'none') {
        return fail(cur, `Keycast status unreadable${why(keycastRead)}`);
      }

      const hold = await ageReviewHold(cur);
      if (hold === 'hold') { summary.waiting += 1; return; }
      if (hold === 'failed') return;

      const entry = await io.readSuspension(pubkey);
      if (entry === 'unknown') return fail(cur, 'relay suspended list unreadable');
      if (!entry.suspended) {
        // Lifted some other way (age review cleared it, say): done, with no message and no
        // Keycast change (spec decision 12).
        if (await cas(cur, { status: 'already_lifted' })) {
          summary.alreadyLifted += 1;
          await recordSuspensionDecision(db, {
            pubkey, action: SUSPENSION_ACTIONS.cancelTimer, reason: 'Account was no longer suspended',
            moderator: null, human: false,
          });
        }
        return;
      }
      // An age-review suspension is the age-review flow's to lift, never the timer's.
      if (entry.reason === 'age_review') return fail(cur, 'age_review row');

      // Claim. Losing means a moderator changed the record since it was read: they win.
      if (!(await cas(cur, { status: 'lifting', claimed_at: nowIso }))) {
        console.log(`[timedSuspensionTick] ${pubkey} changed before the claim; skipped`);
        return;
      }

      let lift: { success: boolean; error?: string } | undefined;
      try {
        lift = await io.relayUnsuspend(pubkey);
      } catch (error) {
        lift = { success: false, error: errorText(error) };
      }
      if (lift?.success !== true) {
        // A failure report (a timeout, say) does not prove the unsuspend did not land. Read the
        // suspended list back: reverting a lift that did land would leave the next tick to mark
        // it already_lifted, with Keycast still suspended and nobody told. A confirmed "not
        // suspended" continues; a confirmed "still suspended" reverts to active and retries.
        // Unreadable (or a throw) leaves the row 'lifting': Phase 0 settles it by a relay read
        // once the claim is STALE_CLAIM_MINUTES old, and alerts.
        let back: SuspensionEntry | 'unknown';
        try {
          back = await io.readSuspension(pubkey);
        } catch (error) {
          console.error(`[timedSuspensionTick] read-back after a failed unsuspend threw for ${pubkey}:`, errorText(error));
          back = 'unknown';
        }
        if (back !== 'unknown' && back.suspended === false) {
          console.log(`[timedSuspensionTick] unsuspend of ${pubkey} reported failure (${lift?.error ?? 'no error given'}) `
            + 'but the suspended list shows it landed; continuing the lift');
        } else if (back === 'unknown') {
          // fail() keeps the status, so the claim and its claimed_at stand for Phase 0.
          return fail(cur, `relay unsuspend failed: ${lift?.error ?? 'no error given'} (read-back unreadable)`);
        } else {
          summary.failed += 1;
          const error = `relay unsuspend failed: ${lift?.error ?? 'no error given'} (read-back still suspended)`;
          console.error(`[timedSuspensionTick] attempt failed for ${pubkey}: ${error}`);
          await cas(cur, {
            status: 'active', attempts: cur.attempts + 1, last_error: error.slice(0, STORED_ERROR_CHARS),
            last_attempt_at: nowIso, claimed_at: null,
          });
          return;
        }
      }
      // From here a throw leaves the row as it is: 'lifting' (Phase 0 recovers it after
      // STALE_CLAIM_MINUTES and alerts) or 'keycast_pending' (Phase 2 retries Keycast).
      // Never back to 'active': the relay lift has landed.

      // Losing this CAS means a manual Unsuspend ended the record during the relay call and
      // sent its own restored message, so stop with none. The opposite ordering, a manual
      // Unsuspend just after this CAS, sends a second restored message: accepted (F13; spec
      // decision 14 keeps manual Unsuspend unchanged).
      if (!(await cas(cur, { status: 'keycast_pending', attempts: 0, last_error: null, claimed_at: null }))) {
        console.log(`[timedSuspensionTick] ${pubkey} was ended by a moderator during the lift; no message sent`);
        return;
      }
      summary.lifted += 1;
      await recordSuspensionDecision(db, {
        pubkey, action: SUSPENSION_ACTIONS.autoUnsuspend, reason: TIMER_REASON, moderator: null, human: false,
      });
      // A ban or a moderator change since the first reads: no message, no Keycast. The row
      // stays keycast_pending; Phase 2 settles a ban without a call on a later tick.
      if (!(await clearToRestore(cur, { messageWithheld: true }))) return;
      // The one restored message (no end time), then Keycast back to active.
      const leg = await restoreAfterLift(io, pubkey, { reason: TIMER_REASON });
      if (leg === 'failed') return fail(cur, 'Keycast activate failed');
      await cas(cur, { status: 'lifted' });
    });
  } catch (error) {
    console.error('[timedSuspensionTick] due-lift phase failed:', errorText(error));
  }

  // Phase 2: retry the Keycast step of lifts whose relay step landed. Never sends a message
  // (spec decision 14). Oldest attempt first, so one stuck row cannot starve the rest.
  try {
    const { results: pending } = await db.prepare(`
      SELECT * FROM timed_suspensions WHERE status = 'keycast_pending' ORDER BY last_attempt_at LIMIT ?
    `).bind(TICK_BATCH).all<SuspensionRecord>();
    await eachRow(pending.filter(row => !handledInPhase1.has(row.pubkey)), async (row, cur) => {
      const pubkey = row.pubkey;
      const settle = async () => {
        if (await cas(cur, { status: 'lifted', last_error: null })) summary.keycastSettled += 1;
      };
      const ban = await io.readBan(pubkey);
      // Unknown first: anything but a plain yes or no is unreadable.
      if (ban !== true && ban !== false) return fail(cur, 'relay ban list unreadable');
      // Banned since the lift: never re-activate Keycast; the ban owns the account now.
      if (ban) return settle();

      const hold = await ageReviewHold(cur);
      if (hold !== 'clear') return;

      const keycast = await io.readKeycastStatus(pubkey);
      // Unknown first: 'unknown' or any value outside the four known ones.
      if (keycast !== 'active' && keycast !== 'banned' && keycast !== 'none' && keycast !== 'suspended') {
        return fail(cur, `Keycast status unreadable (${String(keycast)})`);
      }
      // Nothing left to restore: already active, banned (the ban owns it), or no Keycast account.
      if (keycast !== 'suspended') return settle();
      if (!(await clearToRestore(cur, { messageWithheld: false }))) return;
      const res = await io.keycastActivate(pubkey);
      if (res.success || res.notFound) return settle();
      return fail(cur, `Keycast activate failed: ${res.error ?? (res.status ? `status ${res.status}` : 'no error given')}`);
    });
  } catch (error) {
    console.error('[timedSuspensionTick] Keycast retry phase failed:', errorText(error));
  }

  // Phase 3: one alert per tick for rows that keep failing (throttled per row) and for any
  // Phase 0 recovery.
  try {
    const { results: stuck } = await db.prepare(`
      SELECT * FROM timed_suspensions
      WHERE status IN ('active','lifting','keycast_pending') AND attempts >= ?
        AND (last_alerted_at IS NULL OR datetime(last_alerted_at) < datetime(?, ?))
      ORDER BY pubkey
    `).bind(LIFT_ALERT_AFTER_ATTEMPTS, nowIso, `-${ALERT_THROTTLE_HOURS} hours`).all<SuspensionRecord>();
    const lines = [...eventLines.values()];
    const linedRows: SuspensionRecord[] = [];
    for (const row of stuck) {
      if (eventLines.has(row.pubkey)) continue;
      const step = row.status === 'keycast_pending' ? 'keycast' : 'relay';
      lines.push(`• ${row.pubkey}: ${step} step, ${row.attempts} attempts, `
        + `last error: ${(row.last_error ?? 'none').slice(0, ALERT_ERROR_CHARS)}`);
      linedRows.push(row);
    }
    if (lines.length > 0) {
      const shown = lines.slice(0, ALERT_MAX_LINES);
      const more = lines.length - shown.length;
      const text = `:rotating_light: [${env.ENVIRONMENT ?? 'unknown'}] ${lines.length} timed suspension(s) not lifting\n`
        + shown.join('\n') + (more > 0 ? `\n+${more} more` : '');
      // Only rows named in the message are marked; the rest are named on a later tick.
      const namedRows = linedRows.slice(0, Math.max(0, ALERT_MAX_LINES - eventLines.size));
      let sent = false;
      try {
        sent = (await io.alert(text)) === true;
      } catch (error) {
        console.error('[timedSuspensionTick] alert threw:', errorText(error));
      }
      if (!sent) {
        // No webhook, or it failed: the log is the trace, so it carries every line, uncapped.
        // Not marked, so the next tick retries the stuck rows.
        console.error(`[timedSuspensionTick] alert not delivered: [${env.ENVIRONMENT ?? 'unknown'}] `
          + `${lines.length} timed suspension(s) not lifting\n${lines.join('\n')}`);
      } else {
        for (const row of namedRows) {
          try {
            await casSuspensionRecord(db, row.pubkey, row.version, { last_alerted_at: nowIso });
          } catch (error) {
            console.error(`[timedSuspensionTick] could not mark ${row.pubkey} alerted:`, errorText(error));
          }
        }
      }
    }
  } catch (error) {
    console.error('[timedSuspensionTick] alert phase failed:', errorText(error));
  }

  return summary;
}
