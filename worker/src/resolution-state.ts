// ABOUTME: Uncapped resolution-state projections over moderation_decisions --
// ABOUTME: every handling row and auto-hide state the queue reads.

import { AUTO_HIDE_ACTIONS, AUTO_HIDE_STATE_ACTIONS } from '../../shared/autohide';
import type { HandlingRow } from '../../shared/handling';

export interface AutoHideStateRow {
  target_type: string;
  target_id: string;
  action: string;
  // Unix seconds, or null for a row with no created_at, as getHandlingRows
  // dates its rows. The sensitive switch compares a report with the time a
  // person confirmed or restored an auto-hide (#324).
  at: number | null;
}

// Rows per D1 query. No read here is capped -- each loops until the table is
// exhausted -- but none asks D1 for the whole table in one response either,
// which is what keeps a growing table from turning into a single oversized
// query. Chunk boundaries are invisible in the result.
const ROW_CHUNK_SIZE = 1000;

// The decision rows the handled-before rule reads (#324): every event and
// pubkey row except auto-hide actions, with automated and `reopened` rows
// included, because handlingByTarget (shared/handling.ts) is the one place that
// decides which of them count. The worker feed and the screen both pass these
// rows to it, so the two cannot disagree on a target.
//
// `at` is unix seconds, or null for a row with no created_at. Uncapped and
// keyset-paged on id. The result grows with decision rows, but carries no
// reason or report text.
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
