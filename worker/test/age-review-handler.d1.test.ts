// Real-D1 (Miniflare SQLite) validation for the age-review handler fixes:
//   optimistic concurrency: a compare-and-swap on a version column so two
//         racing writers can't clobber each other / double-fire enforcement.
//   enforcement failures are surfaced (success:false / HTTP 207), not
//         masked as success, while the state transition still persists.
import { Miniflare } from 'miniflare';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { ensureSchema } from '../src/db';
import { handleUpdateAgeReviewCase, handleAgeReviewReplyWebhook } from '../src/age-review';

let mf: Miniflare;
let DB: D1Database;
let env: Parameters<typeof handleUpdateAgeReviewCase>[2];
const cors: Record<string, string> = {};

beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok"); } };',
    compatibilityDate: '2024-12-01',
    compatibilityFlags: ['nodejs_compat'],
    d1Databases: ['DB'],
  });
  DB = (await mf.getD1Database('DB')) as unknown as D1Database;
  // No KEYCAST_URL / RELAY_URL / MODERATION bindings: enforcement legs fail,
  // which is what we want for the surfacing test.
  env = { DB };
});
afterAll(async () => { await mf?.dispose(); });

async function reset() {
  await ensureSchema(DB);
  await DB.prepare('DELETE FROM age_review_cases').run();
  await DB.prepare(
    "INSERT OR REPLACE INTO age_review_config (key, value) VALUES ('auto_delete_on_deny', 'false')",
  ).run();
}

async function insertCase(id: string, state: string) {
  await DB.prepare(
    `INSERT INTO age_review_cases (id, pubkey, state, deadline_at, clock_paused, version)
     VALUES (?, ?, ?, ?, 0, 0)`,
  ).bind(id, `pk_${id}`, state, new Date(Date.now() + 9 * 864e5).toISOString()).run();
}

function patch(id: string, patchBody: Record<string, unknown>) {
  const req = new Request(`https://api.test/api/age-review/cases/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(patchBody),
  });
  return handleUpdateAgeReviewCase(req, id, env, cors);
}

async function rowOf(id: string) {
  const row = await DB.prepare('SELECT state, version FROM age_review_cases WHERE id = ?')
    .bind(id).first<{ state: string; version: number }>();
  if (!row) throw new Error(`row not found: ${id}`);
  return row;
}

describe('age-review handler on real D1', () => {
  beforeEach(reset);

  it('a stale expected_version is rejected with 409 and the state is unchanged', async () => {
    await insertCase('c7-stale', 'open_reported');
    const res = await patch('c7-stale', { state: 'under_moderator_review', expected_version: 999 });
    expect(res.status).toBe(409);
    const body = await res.json() as { code: string };
    expect(body.code).toBe('version_conflict');
    const row = await rowOf('c7-stale');
    expect(row.state).toBe('open_reported'); // unchanged
    expect(row.version).toBe(0);
  });

  it('the parent-reply webhook bumps version, so a stale moderator write 409s', async () => {
    // restricted case linked to a Zendesk ticket; a moderator has it open at version 0.
    await DB.prepare(
      `INSERT INTO age_review_cases (id, pubkey, state, zendesk_ticket_id, deadline_at, clock_paused, version)
       VALUES (?, ?, 'restricted_pending_user_response', ?, ?, 0, 0)`,
    ).bind('wh-case', 'pk_wh', 99001, new Date(Date.now() + 9 * 864e5).toISOString()).run();

    // Parent replies -> webhook advances the case AND bumps version.
    const webhookReq = new Request('https://api.test/api/age-review/reply-webhook', {
      method: 'POST',
      body: JSON.stringify({ ticket_id: 99001 }),
    });
    const webhookRes = await handleAgeReviewReplyWebhook(webhookReq, env, cors);
    expect(webhookRes.status).toBe(200);
    const after = await rowOf('wh-case');
    expect(after.state).toBe('submitted_for_review');
    expect(after.version).toBe(1); // version bumped by the webhook

    // The moderator who loaded the case before the reply (version 0) must now 409,
    // not silently overwrite the parent-reply transition.
    const stale = await patch('wh-case', { state: 'under_moderator_review', expected_version: 0 });
    expect(stale.status).toBe(409);
    const body = await stale.json() as { code: string; current_version: number };
    expect(body.code).toBe('version_conflict');
    expect(body.current_version).toBe(1);
    expect((await rowOf('wh-case')).state).toBe('submitted_for_review'); // unchanged by the stale write
  });

  it('a matching version succeeds and increments version', async () => {
    await insertCase('c7-ok', 'open_reported');
    const res = await patch('c7-ok', { state: 'under_moderator_review', expected_version: 0 });
    expect(res.status).toBe(200);
    const row = await rowOf('c7-ok');
    expect(row.state).toBe('under_moderator_review');
    expect(row.version).toBe(1);
  });

  it('a non-number expected_version is a 400, not a 409 version_conflict', async () => {
    await insertCase('ev-type', 'open_reported');
    const res = await patch('ev-type', { state: 'under_moderator_review', expected_version: '0' });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/expected_version must be a number/);
    // bad input must not transition the case
    expect((await rowOf('ev-type')).state).toBe('open_reported');
  });

  it('re-using a now-stale version (CAS) is rejected', async () => {
    await insertCase('c7-cas', 'open_reported');
    const first = await patch('c7-cas', { state: 'under_moderator_review', expected_version: 0 });
    expect(first.status).toBe(200);
    // version is now 1; a second writer still holding version 0 must lose.
    const second = await patch('c7-cas', { state: 'needs_follow_up', expected_version: 0 });
    expect(second.status).toBe(409);
    expect((await rowOf('c7-cas')).state).toBe('under_moderator_review');
  });

  it('server-read CAS path (no client expected_version) applies and bumps version', async () => {
    // When the client omits expected_version, the handler still compares-and-swaps
    // on the version it read (WHERE version = <read>). The lost-update REJECTION
    // for that same WHERE clause is proven deterministically by the
    // "re-using a now-stale version" test above; a true read-read-write-write
    // interleave can't be reproduced here because Miniflare D1 serializes ops.
    await insertCase('c7-serverread', 'open_reported');
    const res = await patch('c7-serverread', { state: 'under_moderator_review' });
    expect(res.status).toBe(200);
    expect((await rowOf('c7-serverread')).version).toBe(1);
  });

  it('a failed enforcement leg is surfaced (success:false / 207) but the transition persists', async () => {
    await insertCase('c5', 'under_moderator_review');
    const res = await patch('c5', { state: 'restricted_pending_user_response' });
    // No relay/keycast configured -> both legs fail; the API must NOT claim success.
    expect(res.status).toBe(207);
    const body = await res.json() as {
      success: boolean; enforcementComplete: boolean;
      enforcement: { relay: string; bulk: string; keycast: string }; case: { state: string };
    };
    expect(body.success).toBe(false);
    expect(body.enforcementComplete).toBe(false);
    expect(body.enforcement.relay).toBe('failed'); // relay suspend attempted, no relay configured
    expect(body.enforcement.bulk).toBe('failed');
    // ...but the DB state transition still applied (best-effort, retryable).
    expect(body.case.state).toBe('restricted_pending_user_response');
    expect((await rowOf('c5')).state).toBe('restricted_pending_user_response');
  });
});
