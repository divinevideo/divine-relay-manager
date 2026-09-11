// Real-D1 (Miniflare SQLite) validation for the age-review handler fixes:
//   optimistic concurrency: a compare-and-swap on a version column so two
//         racing writers can't clobber each other / double-fire enforcement.
//   enforcement failures are surfaced (success:false / HTTP 207), not
//         masked as success, while the state transition still persists.
import { Miniflare } from 'miniflare';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { ensureSchema } from '../src/db';
import { handleUpdateAgeReviewCase, handleAgeReviewReplyWebhook } from '../src/age-review';
import { createSubjectWithBinding } from '../src/protected-minors';

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
  await DB.prepare('DELETE FROM enforcement_legs').run();
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

  // Issue #123: the leg outcome must outlive the response. Previously the only
  // record of a failed leg was the 207 body and a toast, so recovery depended on
  // a moderator noticing it.
  it('records a failed Keycast leg durably, with the intent to converge on', async () => {
    await insertCase('c6', 'under_moderator_review');
    await patch('c6', { state: 'restricted_pending_user_response' });

    const row = await DB.prepare(
      "SELECT pubkey, intent, state, attempts FROM enforcement_legs WHERE pubkey = 'pk_c6' AND leg = 'keycast_status'",
    ).first<{ pubkey: string; intent: string; state: string; attempts: number }>();
    expect(row).toBeTruthy();
    expect(row!.pubkey).toBe('pk_c6');
    expect(row!.intent).toBe('suspended');
    expect(row!.state).toBe('failed');
    expect(row!.attempts).toBe(0);
  });

  // The favourable direction has to clear the record too, or a cleared account
  // keeps a pending suspension queued against it.
  it('a later action in the other direction supersedes the recorded intent', async () => {
    await insertCase('c7', 'under_moderator_review');
    await patch('c7', { state: 'restricted_pending_user_response' });
    await patch('c7', { state: 'cleared' });

    const row = await DB.prepare(
      "SELECT intent, state FROM enforcement_legs WHERE pubkey = 'pk_c7' AND leg = 'keycast_status'",
    ).first<{ intent: string; state: string }>();
    expect(row!.intent).toBe('active');
    expect(row!.state).toBe('failed'); // still unconfigured here, so still pending -- but pointing at 'active'
  });
});

describe('protected-minor projection on a self-custody deny', () => {
  beforeEach(async () => {
    await reset();
    await DB.prepare('DELETE FROM protected_minor_projection_jobs').run();
  });

  // A denied account keycast does not manage can never satisfy the projection
  // job the denial creates. Settling it inline keeps the cron from carrying a
  // job whose only possible answer is already known.
  it('settles the job rather than leaving it pending', async () => {
    // A real hex pubkey: protected_minor_account_bindings CHECKs the shape.
    const pubkey = 'c'.repeat(64);
    await DB.prepare(
      `INSERT INTO age_review_cases (id, pubkey, state, deadline_at, clock_paused, version)
       VALUES ('c8', ?, 'restricted_pending_user_response', ?, 0, 0)`,
    ).bind(pubkey, new Date(Date.now() + 9 * 864e5).toISOString()).run();
    // Without a protected-minor subject the denial creates no projection job at
    // all, and "no pending jobs" would be true whatever the code does.
    await createSubjectWithBinding(DB, 'c8', pubkey);
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      if (String(input).includes('/api/admin/users/')) {
        return Promise.resolve(new Response(JSON.stringify({ error: 'user not found' }), { status: 404 }));
      }
      return Promise.resolve(new Response('{}', { status: 200 }));
    });

    // Own request rather than the shared `patch` helper: this needs a keycast-
    // configured env, and widening the helper collides with the same widening on
    // the enforcement-leg branch for no benefit to either.
    const req = new Request('https://api.test/api/age-review/cases/c8', {
      method: 'PATCH',
      body: JSON.stringify({ state: 'denied_closed' }),
    });
    await handleUpdateAgeReviewCase(req, 'c8', {
      ...env,
      KEYCAST_URL: 'https://login.test.divine.video',
      KEYCAST_SERVICE_TOKEN: 'test-token',
    }, cors);

    // Positive assertion first: the denial really did create a job to settle.
    const total = await DB.prepare(
      'SELECT COUNT(*) AS c FROM protected_minor_projection_jobs',
    ).first<{ c: number }>();
    expect(total!.c).toBe(1);
    const pending = await DB.prepare(
      "SELECT COUNT(*) AS c FROM protected_minor_projection_jobs WHERE state = 'pending'",
    ).first<{ c: number }>();
    expect(pending!.c).toBe(0);
    // This file has no afterEach; restore here or the spy leaks into whatever
    // test is added after this one.
    vi.restoreAllMocks();
  });
});
