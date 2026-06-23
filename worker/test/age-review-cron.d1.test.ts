// Real-D1 (Miniflare SQLite) validation for the age-review cron fixes:
//   C8 -- deadline comparison must use datetime(deadline_at), not a lexical
//         TEXT compare of an ISO-8601 (`...T...Z`) value against datetime('now').
//   C6 -- the auto-close cron must only act on cases that were actually
//         RESTRICTED and are still awaiting a response.
// The existing vitest.config.ts runs on node with a MOCKED DB, so it never
// exercised SQLite and could not have caught the C8 bug. This suite runs the
// real checkAgeReviewDeadlines against a real Miniflare-backed D1.
import { Miniflare } from 'miniflare';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { ensureSchema } from '../src/db';
import { checkAgeReviewDeadlines } from '../src/age-review';

let mf: Miniflare;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let DB: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cronEnv: any;

beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok"); } };',
    compatibilityDate: '2024-12-01',
    compatibilityFlags: ['nodejs_compat'],
    d1Databases: ['DB'],
  });
  DB = await mf.getD1Database('DB');
  // Minimal env: no Keycast/Slack/Zendesk/moderation bindings. The cron's
  // downstream calls (banUser, Slack, Zendesk, bulk-delete) then no-op / early
  // out / are swallowed; the DB state transition we assert happens first.
  cronEnv = { DB };
});

afterAll(async () => {
  await mf?.dispose();
});

async function reset() {
  await ensureSchema(DB);
  await DB.prepare('DELETE FROM age_review_cases').run();
  await DB.prepare('DELETE FROM age_review_config').run();
  // Skip the auto-delete bulk-moderate path (which would open a relay WebSocket)
  // so the test stays hermetic; we validate the state machine, not delete.
  await DB.prepare(
    "INSERT OR REPLACE INTO age_review_config (key, value) VALUES ('auto_delete_on_deny', 'false')",
  ).run();
}

async function insertCase(id: string, state: string, deadlineIso: string) {
  await DB.prepare(
    `INSERT INTO age_review_cases (id, pubkey, state, deadline_at, clock_paused)
     VALUES (?, ?, ?, ?, 0)`,
  ).bind(id, `pk_${id}`, state, deadlineIso).run();
}

async function stateOf(id: string): Promise<string | undefined> {
  const row = await DB.prepare('SELECT state FROM age_review_cases WHERE id = ?')
    .bind(id).first();
  return row?.state;
}

describe('age-review cron on real D1 (C6 + C8)', () => {
  beforeEach(reset);

  it('C8 mechanism: lexical TEXT compare misfires where datetime() is correct', async () => {
    // 08:00 is clearly before 12:00 on the same day, but the ISO string sorts
    // AFTER the space-form because 'T'(0x54) > ' '(0x20).
    const r = await DB.prepare(
      `SELECT ('2026-06-22T08:00:00.000Z' < '2026-06-22 12:00:00')           AS lexical,
              (datetime('2026-06-22T08:00:00.000Z') < '2026-06-22 12:00:00') AS fixed`,
    ).first();
    expect(r.lexical).toBe(0); // the bug: appears NOT-yet-expired
    expect(r.fixed).toBe(1);   // the fix: correct temporal comparison
  });

  it('C8: a restricted case that expired earlier TODAY (same UTC day) is auto-closed', async () => {
    const deadline = new Date(Date.now() - 60_000).toISOString(); // 1 min ago
    await insertCase('c8-today', 'restricted_pending_user_response', deadline);
    await checkAgeReviewDeadlines(cronEnv);
    expect(await stateOf('c8-today')).toBe('denied_closed');
  });

  it('C6: a never-restricted (open_reported) expired case is NOT auto-closed/banned', async () => {
    await insertCase('c6-open', 'open_reported', '2020-01-01T00:00:00.000Z');
    await checkAgeReviewDeadlines(cronEnv);
    expect(await stateOf('c6-open')).toBe('open_reported');
  });

  it('C6: a never-restricted (under_moderator_review) expired case is NOT auto-closed', async () => {
    await insertCase('c6-umr', 'under_moderator_review', '2020-01-01T00:00:00.000Z');
    await checkAgeReviewDeadlines(cronEnv);
    expect(await stateOf('c6-umr')).toBe('under_moderator_review');
  });

  it('C6: an already-responded (submitted_for_review) expired case is NOT auto-closed', async () => {
    await insertCase('c6-sub', 'submitted_for_review', '2020-01-01T00:00:00.000Z');
    await checkAgeReviewDeadlines(cronEnv);
    expect(await stateOf('c6-sub')).toBe('submitted_for_review');
  });

  it('C6: a restricted + pending expired case IS auto-closed', async () => {
    await insertCase('c6-restricted', 'restricted_pending_parental_consent', '2020-01-01T00:00:00.000Z');
    await checkAgeReviewDeadlines(cronEnv);
    expect(await stateOf('c6-restricted')).toBe('denied_closed');
  });

  it('a paused restricted case is NOT auto-closed even if expired', async () => {
    await insertCase('c6-paused', 'restricted_pending_user_response', '2020-01-01T00:00:00.000Z');
    await DB.prepare('UPDATE age_review_cases SET clock_paused = 1 WHERE id = ?').bind('c6-paused').run();
    await checkAgeReviewDeadlines(cronEnv);
    expect(await stateOf('c6-paused')).toBe('restricted_pending_user_response');
  });
});
