// Real-D1 (Miniflare SQLite) validation for the age-review handler fixes:
//   optimistic concurrency: a compare-and-swap on a version column so two
//         racing writers can't clobber each other / double-fire enforcement.
//   enforcement failures are surfaced (success:false / HTTP 207), not
//         masked as success, while the state transition still persists.
import { Miniflare } from 'miniflare';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { ensureSchema } from '../src/db';
import { handleUpdateAgeReviewCase, handleAgeReviewReplyWebhook, handleParentConsent } from '../src/age-review';
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
  await DB.prepare('DELETE FROM age_review_parent_consent_submissions').run();
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

  it('stores one consent submission in R2 and advances the case only after the ticket has the reviewer link', async () => {
    const owner = 'a'.repeat(64);
    await DB.prepare(`INSERT INTO age_review_cases
      (id, pubkey, state, suspected_age_band, zendesk_ticket_id, deadline_at, clock_paused, version)
      VALUES ('consent-case', ?, 'restricted_pending_parental_consent', 'age_13_15', 42, ?, 0, 2)`)
      .bind(owner, new Date(Date.now() + 9 * 864e5).toISOString()).run();
    const calls: string[] = [];
    let commentBody = '';
    const objects = new Map<string, Uint8Array>();
    const bucket = {
      head: async (key: string) => (objects.has(key) ? { size: objects.get(key)!.length } : null),
      createMultipartUpload: async (key: string) => {
        const chunks: Uint8Array[] = [];
        return {
          uploadPart: async (n: number, v: Uint8Array) => { chunks.push(new Uint8Array(v)); return { partNumber: n, etag: `e${n}` }; },
          complete: async () => { objects.set(key, new Uint8Array(chunks.flatMap((c) => [...c]))); return {}; },
          abort: async () => {},
        };
      },
    };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith('/tickets/42')) {
        commentBody = (JSON.parse(String(init?.body)) as { ticket: { comment: { body: string } } }).ticket.comment.body;
        return new Response('{}', { status: 200 });
      }
      if (url.includes('/tickets/42/comments?')) return new Response(JSON.stringify({ comments: commentBody ? [{ body: commentBody }] : [] }), { status: 200 });
      throw new Error(`Unexpected request: ${url}`);
    });
    const form = new FormData();
    form.set('email', 'parent@example.com');
    form.set('video', new File(['clip'], 'clip.mp4', { type: 'video/mp4' }));
    const request = () => new Request('https://api.test/v1/minor-review-cases/consent-case/parent-consent', {
      method: 'POST', body: form,
    });
    try {
      const consentEnv = { ...env, ZENDESK_SUBDOMAIN: 'test', ZENDESK_EMAIL: 'agent@test.com', ZENDESK_API_TOKEN: 'token', CONSENT_VIDEO_BUCKET: bucket as unknown as R2Bucket };
      expect((await handleParentConsent(request(), 'consent-case', owner, consentEnv, cors)).status).toBe(200);
      const caseRow = await DB.prepare('SELECT state, version, clock_paused, parent_contact_email FROM age_review_cases WHERE id = ?')
        .bind('consent-case').first<{ state: string; version: number; clock_paused: number; parent_contact_email: string }>();
      expect(caseRow).toMatchObject({ state: 'submitted_for_review', version: 3, clock_paused: 1, parent_contact_email: 'parent@example.com' });
      const submission = await DB.prepare('SELECT status, lease_until, receipt_id, object_key, size_bytes FROM age_review_parent_consent_submissions WHERE case_id = ?')
        .bind('consent-case').first<{ status: string; lease_until: number; receipt_id: string; object_key: string; size_bytes: number }>();
      expect(submission).toMatchObject({ status: 'commented', lease_until: 0, size_bytes: 4 });
      expect(submission!.receipt_id).toBeTruthy();
      expect(objects.get(submission!.object_key)).toEqual(new TextEncoder().encode('clip'));
      expect(commentBody).toContain(`/api/age-review/consent-video/${submission!.receipt_id}`);
      expect(calls).toHaveLength(3);
      expect((await handleParentConsent(request(), 'consent-case', owner, consentEnv, cors)).status).toBe(200);
      expect(fetchSpy).toHaveBeenCalledTimes(3);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('returns 404 for a different pubkey and never touches storage or Zendesk', async () => {
    const owner = 'a'.repeat(64);
    await DB.prepare(`INSERT INTO age_review_cases
      (id, pubkey, state, suspected_age_band, zendesk_ticket_id, deadline_at, clock_paused, version)
      VALUES ('consent-case-404', ?, 'restricted_pending_parental_consent', 'age_13_15', 42, ?, 0, 2)`)
      .bind(owner, new Date(Date.now() + 9 * 864e5).toISOString()).run();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('must not be called'));
    const form = new FormData();
    form.set('email', 'parent@example.com');
    form.set('video', new File(['clip'], 'clip.mp4', { type: 'video/mp4' }));
    const request = new Request('https://api.test/v1/minor-review-cases/consent-case-404/parent-consent', { method: 'POST', body: form });
    try {
      const res = await handleParentConsent(request, 'consent-case-404', 'b'.repeat(64), { ...env }, cors);
      expect(res.status).toBe(404);
      expect(fetchSpy).not.toHaveBeenCalled();
      const row = await DB.prepare('SELECT 1 FROM age_review_parent_consent_submissions WHERE case_id = ?').bind('consent-case-404').first();
      expect(row).toBeNull();
    } finally { fetchSpy.mockRestore(); }
  });

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

describe('clear resolution on the PATCH', () => {
  beforeEach(async () => {
    await reset();
    for (const table of ['protected_minor_projection_jobs', 'protected_minor_account_bindings', 'protected_minor_subjects']) {
      await DB.prepare(`DELETE FROM ${table}`).run();
    }
  });

  // Hex pubkey: once Task 4 lands, an approval binds it and the bindings table CHECKs the shape.
  async function insertBandCase(id: string, band: string) {
    await DB.prepare(
      `INSERT INTO age_review_cases (id, pubkey, state, suspected_age_band, deadline_at, clock_paused, version)
       VALUES (?, ?, 'under_moderator_review', ?, ?, 0, 0)`,
    ).bind(id, 'a'.repeat(64), band, new Date(Date.now() + 9 * 864e5).toISOString()).run();
  }
  const caseRow = (id: string) => DB.prepare('SELECT state, clear_resolution FROM age_review_cases WHERE id = ?')
    .bind(id).first<{ state: string; clear_resolution: string | null }>();

  it('rejects a Clear with no resolution and leaves the case open', async () => {
    await insertBandCase('r-none', 'age_13_15');
    const res = await patch('r-none', { state: 'cleared' });
    expect(res.status).toBe(400);
    expect(await caseRow('r-none')).toEqual({ state: 'under_moderator_review', clear_resolution: null });
  });

  it('rejects an unknown resolution', async () => {
    await insertBandCase('r-bad', 'age_13_15');
    const res = await patch('r-bad', { state: 'cleared', resolution: 'maybe' });
    expect(res.status).toBe(400);
    expect((await caseRow('r-bad'))!.state).toBe('under_moderator_review');
  });

  it('rejects a resolution sent without a Clear', async () => {
    await insertBandCase('r-orphan', 'age_13_15');
    const res = await patch('r-orphan', { state: 'needs_follow_up', resolution: 'not_minor' });
    expect(res.status).toBe(400);
    expect((await caseRow('r-orphan'))!.state).toBe('under_moderator_review');
  });

  it('rejects approved_minor outside the 13-15 band', async () => {
    await insertBandCase('r-adult', 'age_16_plus_claimed');
    const res = await patch('r-adult', { state: 'cleared', resolution: 'approved_minor' });
    expect(res.status).toBe(400);
    expect((await caseRow('r-adult'))!.state).toBe('under_moderator_review');
  });

  it('uses the post-update band when the same PATCH sets 13-15 and approves', async () => {
    await insertBandCase('r-reband', 'age_16_plus_claimed');
    const res = await patch('r-reband', {
      state: 'cleared', resolution: 'approved_minor', suspected_age_band: 'age_13_15',
    });
    expect(res.status).not.toBe(400);
    expect(await caseRow('r-reband')).toEqual({ state: 'cleared', clear_resolution: 'approved_minor' });
  });

  it('persists not_minor and writes no protected-minor subject', async () => {
    await insertBandCase('r-dismiss', 'age_13_15');
    const res = await patch('r-dismiss', { state: 'cleared', resolution: 'not_minor' });
    expect(res.status).not.toBe(400);
    expect(await caseRow('r-dismiss')).toEqual({ state: 'cleared', clear_resolution: 'not_minor' });
    const subjects = await DB.prepare(
      "SELECT COUNT(*) AS c FROM protected_minor_subjects WHERE source_case_id = 'r-dismiss'",
    ).first<{ c: number }>();
    expect(subjects!.c).toBe(0);
  });

  it('ensureSchema adds clear_resolution idempotently', async () => {
    await ensureSchema(DB);
    await ensureSchema(DB);
    const cols = await DB.prepare('PRAGMA table_info(age_review_cases)').all<{ name: string }>();
    expect(cols.results.map((c) => c.name)).toContain('clear_resolution');
  });
});
