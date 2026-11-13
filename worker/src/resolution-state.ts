// ABOUTME: Uncapped resolution-state projection over moderation_decisions --
// ABOUTME: which targets the queue should treat as already handled.

import { AUTO_HIDE_ACTIONS, AUTO_HIDE_STATE_ACTIONS } from '../../shared/autohide';
import { isAutomatedDecision } from '../../shared/automated-decision';
import { REOPENED_ACTION, type HandlingRow } from '../../shared/handling';

export interface ResolvedTargetRow {
  target_type: string;
  target_id: string;
  // Present only when the worker itself wrote every decision that resolves
  // this target, so none of them came from a person. Absent otherwise.
  automated?: true;
}

export interface AutoHideStateRow {
  target_type: string;
  target_id: string;
  action: string;
  // Unix seconds, or null for a row with no created_at, as getHandlingRows
  // dates its rows. The sensitive switch compares a report with the time a
  // person confirmed or restored an auto-hide (#324).
  at: number | null;
}

// Rows per D1 query. Neither read is capped -- both loop until the table is
// exhausted -- but neither asks D1 for the whole table in one response either,
// which is what keeps a growing table from turning into a single oversized
// query. Chunk boundaries are invisible in the result.
const ROW_CHUNK_SIZE = 1000;

// The queue subtracts these targets to hide handled work. /api/decisions caps at
// the newest 1000 ROWS, so a target whose only decision falls outside that window
// drops out of the subtraction and reappears as pending with nothing explaining
// why (#221 disclosed that bound; this removes it).
//
// Projecting to distinct targets is what makes an uncapped read affordable: the
// result grows with targets, not with moderation volume, and carries none of the
// per-decision text the queue never reads.
//
// Auto-hide actions are excluded because they are not resolutions -- auto-hidden
// content is waiting FOR review, and counting it as handled would hide the
// pending-review queue from the moderators who have to work it.
//
// A target the worker alone resolved -- today with an age_review_case_created
// row -- is still returned, because the queue's membership fallback (a pre-#324
// Pages build, or a worker that sends no dates) counts it as handled under
// Hide resolved. Under the dated rule it is not handled (#332). It
// carries `automated: true` so the sensitive-reports switch, which waits for a
// person, can look past it. One human row anywhere in the walk clears the flag,
// whichever chunk it falls in. isAutomatedDecision picks out the worker's own
// rows. A person's decision that this read sees has a hex pubkey or NULL as its
// moderator: POST /api/decisions records only a verified login's pubkey or NULL,
// and bulk moderation always writes a hex pubkey. The worker puts its marker on a
// person's decision only in an auto-hide row, which this read skips.
//
// A `reopened` row (#324) starts the target over: only rows after it count, so a
// target whose rows end in a reopen is left out. Reopen used to delete the
// target's rows, and a Pages build that reads only this list sees the same as it
// did then. Rows are walked in id order, which is the order they were written.
// TODO(#409): remove the reopen handling here once no older Pages build that
// reads the `resolved` field can be live.
export async function getResolvedTargets(
  db: D1Database,
  opts?: { chunkSize?: number }
): Promise<ResolvedTargetRow[]> {
  const chunkSize = opts?.chunkSize ?? ROW_CHUNK_SIZE;
  const placeholders = AUTO_HIDE_ACTIONS.map(() => '?').join(', ');

  const targets: ResolvedTargetFold = new Map();
  let afterId = 0;

  for (;;) {
    const result = await db
      .prepare(
        `SELECT id, target_type, target_id, action, moderator_pubkey
           FROM moderation_decisions
          WHERE action NOT IN (${placeholders})
            AND id > ?
          ORDER BY id
          LIMIT ?`
      )
      .bind(...AUTO_HIDE_ACTIONS, afterId, chunkSize)
      .all();

    const rows = (result.results || []) as unknown as Array<{
      id: number;
      target_type: string;
      target_id: string;
      action: string;
      moderator_pubkey: string | null;
    }>;
    for (const row of rows) foldResolvedRow(targets, row);

    if (rows.length < chunkSize) break;
    afterId = rows[rows.length - 1].id;
  }

  return resolvedTargetsOf(targets);
}

// getResolvedTargets over rows already read, for a caller that holds
// getHandlingRows' result: the same rows in the same id order, limited to event
// and pubkey targets, so it gives the same answer for those targets without a
// second walk of the table.
export function resolvedTargetsFromRows(
  rows: Iterable<{ target_type: string; target_id: string; action: string; moderator_pubkey?: string | null }>
): ResolvedTargetRow[] {
  const targets: ResolvedTargetFold = new Map();
  for (const row of rows) foldResolvedRow(targets, row);
  return resolvedTargetsOf(targets);
}

// Map insertion order is first-seen order, which the result keeps.
type ResolvedTargetFold = Map<string, { target_type: string; target_id: string; human: boolean }>;

// One decision row, in id order, folded into the resolved targets.
function foldResolvedRow(
  targets: ResolvedTargetFold,
  row: { target_type: string; target_id: string; action: string; moderator_pubkey?: string | null }
): void {
  const key = `${row.target_type}:${row.target_id}`;
  if (row.action === REOPENED_ACTION) {
    // By id, so a human row written in the same second after a reopen
    // resolves the target here, where handlingByTarget needs a strictly
    // later time. They differ only within that second, and only an old
    // Pages build reads this list.
    targets.delete(key);
    return;
  }
  const human = !isAutomatedDecision(row);
  const target = targets.get(key);
  if (!target) {
    targets.set(key, { target_type: row.target_type, target_id: row.target_id, human });
  } else if (human) {
    target.human = true;
  }
}

function resolvedTargetsOf(targets: ResolvedTargetFold): ResolvedTargetRow[] {
  return Array.from(targets.values(), ({ target_type, target_id, human }) =>
    human ? { target_type, target_id } : { target_type, target_id, automated: true }
  );
}

// The dated decision rows the handled-before rule reads (#324): every event and
// pubkey row except auto-hide actions, with automated and `reopened` rows
// included, because handlingByTarget (shared/handling.ts) is the one place that
// decides which of them count. The worker feed and the screen both pass these
// rows to it, so the two cannot disagree on a target.
//
// `at` is unix seconds, or null for a row with no created_at. Uncapped and
// keyset-paged on id, as getResolvedTargets is. The result grows with decision
// rows rather than targets, but carries no reason or report text.
export async function getHandlingRows(
  db: D1Database,
  opts?: { chunkSize?: number }
): Promise<HandlingRow[]> {
  const chunkSize = opts?.chunkSize ?? ROW_CHUNK_SIZE;
  const placeholders = AUTO_HIDE_ACTIONS.map(() => '?').join(', ');

  const handling: HandlingRow[] = [];
  let afterId = 0;

  for (;;) {
    const result = await db
      .prepare(
        `SELECT id, target_type, target_id, action, moderator_pubkey,
                CAST(strftime('%s', created_at) AS INTEGER) AS at
           FROM moderation_decisions
          WHERE action NOT IN (${placeholders})
            AND target_type IN ('event', 'pubkey')
            AND id > ?
          ORDER BY id
          LIMIT ?`
      )
      .bind(...AUTO_HIDE_ACTIONS, afterId, chunkSize)
      .all();

    const rows = (result.results || []) as unknown as Array<HandlingRow & { id: number }>;
    for (const row of rows) {
      handling.push({
        target_type: row.target_type,
        target_id: row.target_id,
        action: row.action,
        moderator_pubkey: row.moderator_pubkey ?? null,
        at: row.at ?? null,
      });
    }

    if (rows.length < chunkSize) break;
    afterId = rows[rows.length - 1].id;
  }

  return handling;
}

// Feeds the pending-review queue. Only the STATE actions are read, because
// getLatestAutoHideState -- which stays in TypeScript, and stays the single
// authority on what the auto-hide state machine means -- takes the first state
// action it sees and ignores the rest. Narrowing here is a projection, not a
// second implementation of that rule.
//
// Newest-first, matching the order getLatestAutoHideState expects. Ordering by
// created_at alone is not enough: same-second rows are common (an auto-hide and
// its immediate confirmation), and id breaks that tie in insertion order.
export async function getAutoHideStates(
  db: D1Database,
  opts?: { chunkSize?: number }
): Promise<AutoHideStateRow[]> {
  const chunkSize = opts?.chunkSize ?? ROW_CHUNK_SIZE;
  const placeholders = AUTO_HIDE_STATE_ACTIONS.map(() => '?').join(', ');

  const states: AutoHideStateRow[] = [];
  // Keyset cursor on the same (created_at, id) pair the ordering uses. A plain
  // OFFSET would drift if a row were written between chunks; the pair is unique
  // because id is, so it cannot skip or repeat a row.
  //
  // COALESCE, in the ordering AND the comparison, because created_at is nullable
  // (TEXT DEFAULT CURRENT_TIMESTAMP, no NOT NULL). Every comparison against NULL
  // is NULL, so a bare `created_at < ?` silently drops an undated row from every
  // page after the first -- and losing an auto_hidden row takes its target out
  // of the pending-review queue with nothing to show for it. '' sorts below any
  // timestamp, so undated rows land last and stay reachable.
  let cursor: { createdAt: string; id: number } | null = null;

  for (;;) {
    const result: D1Result = cursor === null
      ? await db
          .prepare(
            `SELECT id, created_at, target_type, target_id, action,
                    CAST(strftime('%s', created_at) AS INTEGER) AS at
               FROM moderation_decisions
              WHERE action IN (${placeholders})
              ORDER BY COALESCE(created_at, '') DESC, id DESC
              LIMIT ?`
          )
          .bind(...AUTO_HIDE_STATE_ACTIONS, chunkSize)
          .all()
      : await db
          .prepare(
            `SELECT id, created_at, target_type, target_id, action,
                    CAST(strftime('%s', created_at) AS INTEGER) AS at
               FROM moderation_decisions
              WHERE action IN (${placeholders})
                AND (COALESCE(created_at, '') < ?
                     OR (COALESCE(created_at, '') = ? AND id < ?))
              ORDER BY COALESCE(created_at, '') DESC, id DESC
              LIMIT ?`
          )
          .bind(...AUTO_HIDE_STATE_ACTIONS, cursor.createdAt, cursor.createdAt, cursor.id, chunkSize)
          .all();

    const rows = (result.results || []) as unknown as Array<
      AutoHideStateRow & { id: number; created_at: string }
    >;
    for (const row of rows) {
      states.push({
        target_type: row.target_type,
        target_id: row.target_id,
        action: row.action,
        at: row.at ?? null,
      });
    }

    if (rows.length < chunkSize) break;
    const last = rows[rows.length - 1];
    cursor = { createdAt: last.created_at ?? '', id: last.id };
  }

  return states;
}
