import type { SexualCase } from '../../shared/sexual-quarantine';
import { ensureSchema } from './db';
import { isLowerHex64 } from './hex';

// A source-specific record is deliberately different from allow_event: releasing
// this hold says nothing about an independent ban or another stream's decision.
export async function recordSexualQuarantineDecision(db: D1Database, c: SexualCase): Promise<void> {
  if (!isLowerHex64(c.eventId) || !Number.isSafeInteger(c.revision) || c.revision < 1
    || !c.actor || c.actor === 'auto' || !c.reason?.trim() || !c.verifiedAt
    || !['restored', 'restored_restricted', 'removed'].includes(c.state)
    || c.goal !== (c.state === 'removed' ? 'remove' : 'restore')) {
    throw new Error('Unverified human quarantine decision');
  }
  await ensureSchema(db);
  // Record the human intent, stable across verification retries. Independent
  // restrictions can change restored <-> restored_restricted at this revision.
  const action = `sexual_quarantine_${c.goal}`;
  // D1 batch is a transaction. A newer revision fences delayed old requests;
  // the watermark prevents another append after a lost success response.
  await db.batch([
    db.prepare(`INSERT INTO sexual_quarantine_reviews
        (event_id, revision, action, reason, moderator_pubkey, report_id, reporter_pubkey)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(event_id) DO UPDATE SET revision = excluded.revision,
        action = excluded.action, reason = excluded.reason, moderator_pubkey = excluded.moderator_pubkey,
        report_id = excluded.report_id, reporter_pubkey = excluded.reporter_pubkey
      WHERE excluded.revision > sexual_quarantine_reviews.revision`)
      .bind(c.eventId, c.revision, action, c.reason, c.actor, c.firstReport.id, c.firstReport.pubkey),
    db.prepare(`INSERT INTO moderation_decisions
        (target_type, target_id, action, reason, moderator_pubkey, report_id, reporter_pubkey)
      SELECT 'event', event_id, action, reason, moderator_pubkey, report_id, reporter_pubkey
      FROM sexual_quarantine_reviews
      WHERE event_id = ? AND revision = ? AND action = ? AND logged_revision < revision`)
      .bind(c.eventId, c.revision, action),
    db.prepare(`INSERT INTO moderation_targets (target_id, target_type, ever_human_reviewed, last_human_action)
      SELECT event_id, 'event', 1, action FROM sexual_quarantine_reviews
      WHERE event_id = ? AND revision = ? AND action = ? AND logged_revision < revision
      ON CONFLICT(target_id) DO UPDATE SET ever_human_reviewed = 1, last_human_action = excluded.last_human_action`)
      .bind(c.eventId, c.revision, action),
    db.prepare(`UPDATE sexual_quarantine_reviews SET logged_revision = revision
      WHERE event_id = ? AND revision = ? AND action = ?`).bind(c.eventId, c.revision, action),
  ]);
  const recorded = await db.prepare('SELECT revision, action, logged_revision FROM sexual_quarantine_reviews WHERE event_id = ?')
    .bind(c.eventId).first<{ revision: number; action: string; logged_revision: number }>();
  if (!recorded || recorded.revision < c.revision || recorded.logged_revision < c.revision
    || (recorded.revision === c.revision && recorded.action !== action)) {
    throw new Error('Quarantine decision record not confirmed');
  }
}
