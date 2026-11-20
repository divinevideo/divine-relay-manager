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
