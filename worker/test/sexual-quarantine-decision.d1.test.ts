// Synthetic cases exercise atomic SQLite projection, not mocked SQL strings.
import { Miniflare } from 'miniflare';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { ensureSchema } from '../src/db';
import { recordSexualQuarantineDecision } from '../src/sexual-quarantine-decision';
import { getResolvedTargets } from '../src/resolution-state';
import type { SexualCase } from '../../shared/sexual-quarantine';

let mf: Miniflare;
let db: D1Database;
const eventId = 'a'.repeat(64);
const item = (revision: number, state: SexualCase['state'] = 'restored'): SexualCase => ({
  eventId, revision, state, goal: state === 'removed' ? 'remove' : 'restore',
  actor: 'unattributed', reason: 'Synthetic human review', decisionAt: 2000,
  reporters: 2, threshold: 2, attempts: 1, retryAt: 0,
  createdAt: 1000, updatedAt: 2000, deadlineAt: 901000, verifiedAt: 2000,
  firstReport: { id: 'b'.repeat(64), pubkey: 'c'.repeat(64), reason: 'nudity' },
});
beforeAll(async () => {
  mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok"); } };',
    compatibilityDate: '2024-12-01', d1Databases: ['DB'] });
  db = await mf.getD1Database('DB') as unknown as D1Database;
  await ensureSchema(db);
});
afterAll(async () => { await mf?.dispose(); });

describe('sexual quarantine human decision projection', () => {
  it('records review in both reports and target protection, idempotently', async () => {
    await recordSexualQuarantineDecision(db, item(3));
    await recordSexualQuarantineDecision(db, item(3));
    const logs = await db.prepare('SELECT * FROM moderation_decisions WHERE target_id = ?').bind(eventId).all();
    expect(logs.results).toHaveLength(1);
    expect(logs.results[0]).toMatchObject({ action: 'sexual_quarantine_restore', moderator_pubkey: 'unattributed',
      report_id: 'b'.repeat(64), reporter_pubkey: 'c'.repeat(64), reason: 'Synthetic human review' });
    expect(await db.prepare('SELECT * FROM moderation_targets WHERE target_id = ?').bind(eventId).first())
      .toMatchObject({ ever_human_reviewed: 1, last_human_action: 'sexual_quarantine_restore' });
    expect(await getResolvedTargets(db)).toContainEqual({ target_type: 'event', target_id: eventId });
  });
  it('does not let an old delayed restore overwrite a newer remove', async () => {
    await recordSexualQuarantineDecision(db, item(5, 'removed'));
    await recordSexualQuarantineDecision(db, item(3));
    expect(await db.prepare('SELECT * FROM moderation_targets WHERE target_id = ?').bind(eventId).first())
      .toMatchObject({ last_human_action: 'sexual_quarantine_remove' });
    const logs = await db.prepare('SELECT action FROM moderation_decisions WHERE target_id = ? ORDER BY id').bind(eventId).all();
    expect(logs.results.map(row => row.action)).toEqual(['sexual_quarantine_restore', 'sexual_quarantine_remove']);
  });
  it('records remaining restrictions honestly and never as global allow_event', async () => {
    await recordSexualQuarantineDecision(db, item(7, 'restored_restricted'));
    // Lost success response followed by a new independent restriction remains
    // the same human decision, and must not strand projection retries.
    await recordSexualQuarantineDecision(db, item(7, 'restored'));
    const target = await db.prepare('SELECT * FROM moderation_targets WHERE target_id = ?').bind(eventId).first();
    expect(target?.last_human_action).toBe('sexual_quarantine_restore');
  });
  it('rejects unverified, pending, automatic and conflicting same-revision records', async () => {
    for (const invalid of [{ ...item(8), actor: undefined }, { ...item(8), state: 'pending' as const },
      { ...item(8), verifiedAt: undefined }, { ...item(8), actor: 'auto' }, item(7, 'removed')]) {
      await expect(recordSexualQuarantineDecision(db, invalid)).rejects.toThrow();
    }
  });
});
