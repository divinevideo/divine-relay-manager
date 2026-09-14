// ABOUTME: Uncapped resolution-state projection over moderation_decisions --
// ABOUTME: which targets the queue should treat as already handled.

import { AUTO_HIDE_ACTIONS, AUTO_HIDE_STATE_ACTIONS } from '../../shared/autohide';

export interface ResolvedTargetRow {
  target_type: string;
  target_id: string;
}

export interface AutoHideStateRow {
  target_type: string;
  target_id: string;
  action: string;
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
export async function getResolvedTargets(
  db: D1Database,
  opts?: { chunkSize?: number }
): Promise<ResolvedTargetRow[]> {
  const chunkSize = opts?.chunkSize ?? ROW_CHUNK_SIZE;
  const placeholders = AUTO_HIDE_ACTIONS.map(() => '?').join(', ');

  const seen = new Set<string>();
  const targets: ResolvedTargetRow[] = [];
  let afterId = 0;

  for (;;) {
    const result = await db
      .prepare(
        `SELECT id, target_type, target_id
           FROM moderation_decisions
          WHERE action NOT IN (${placeholders})
            AND id > ?
          ORDER BY id
          LIMIT ?`
      )
      .bind(...AUTO_HIDE_ACTIONS, afterId, chunkSize)
      .all();

    const rows = (result.results || []) as unknown as Array<ResolvedTargetRow & { id: number }>;
    for (const row of rows) {
      const key = `${row.target_type}:${row.target_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push({ target_type: row.target_type, target_id: row.target_id });
    }

    if (rows.length < chunkSize) break;
    afterId = rows[rows.length - 1].id;
  }

  return targets;
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
  let cursor: { createdAt: string; id: number } | null = null;

  for (;;) {
    const result: D1Result = cursor === null
      ? await db
          .prepare(
            `SELECT id, created_at, target_type, target_id, action
               FROM moderation_decisions
              WHERE action IN (${placeholders})
              ORDER BY created_at DESC, id DESC
              LIMIT ?`
          )
          .bind(...AUTO_HIDE_STATE_ACTIONS, chunkSize)
          .all()
      : await db
          .prepare(
            `SELECT id, created_at, target_type, target_id, action
               FROM moderation_decisions
              WHERE action IN (${placeholders})
                AND (created_at < ? OR (created_at = ? AND id < ?))
              ORDER BY created_at DESC, id DESC
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
      });
    }

    if (rows.length < chunkSize) break;
    const last = rows[rows.length - 1];
    cursor = { createdAt: last.created_at, id: last.id };
  }

  return states;
}
