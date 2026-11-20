// ABOUTME: Timed (auto-expiring) suspensions, store section: the per-account record, its
// ABOUTME: compare-and-swap writes, and the decision-row helper. One row per pubkey.
import type { TimedSuspensionView } from '../../shared/suspension';
import { markHumanReviewed } from './human-decision';

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
