// Real-D1 (Miniflare SQLite) validation for the age-review handler fixes:
//   optimistic concurrency: a compare-and-swap on a version column so two
//         racing writers can't clobber each other / double-fire enforcement.
//   enforcement failures are surfaced (success:false / HTTP 207), not
//         masked as success, while the state transition still persists.
import { Miniflare } from 'miniflare';
import type { ModerationStatusResponse } from '../../shared/age-review';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { disposeDueConsentVideos, trackConsentObject } from '../src/consent-video';
import { ensureSchema } from '../src/db';
import { handleUpdateAgeReviewCase, handleAgeReviewReplyWebhook, checkAgeReviewDeadlines, handleGetModerationStatus, handleStartGreenlight } from '../src/age-review';
import { createSubjectWithBinding, approvalRegistryStatements, resolveByPubkey, clearSubject, markProjectionComplete } from '../src/protected-minors';
import { submitSignedConsent, consentPayloadHash } from '../src/test-helpers/signed-consent';

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
  await DB.prepare('DELETE FROM age_review_consent_objects').run();
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

  it.each([
    ['moderator restriction', 'restricted_pending_parental_consent', 'report', 'restricted_minor_review', null],
    ['voluntary application', 'open_reported', 'greenlight_application', 'active', null],
    ['reported voluntary application', 'open_reported', 'report', 'active', '2026-10-01T00:00:00Z'],
    ['moderated family application', 'open_reported', 'greenlight_application', 'restricted_minor_review', null],
    ['moderated attached report', 'open_reported', 'report', 'restricted_minor_review', '2026-10-01T00:00:00Z'],
  ])('stores one consent submission for a %s and advances only after the reviewer link exists', async (label, initialState, createdVia, restriction, requestedAt) => {
    const owner = 'a'.repeat(64);
    await DB.prepare(`INSERT INTO age_review_cases
      (id, pubkey, state, suspected_age_band, zendesk_ticket_id, deadline_at, clock_paused, version, created_via, greenlight_requested_at)
      VALUES ('consent-case', ?, ?, 'age_13_15', 42, ?, 0, 2, ?, ?)`)
      .bind(owner, initialState, new Date(Date.now() + 9 * 864e5).toISOString(), createdVia, requestedAt).run();
    if (createdVia === 'report' && initialState === 'open_reported') {
      await DB.prepare("UPDATE age_review_cases SET greenlight_requested_at = NULL WHERE id = 'consent-case'").run();
      expect((await handleStartGreenlight(owner, env, cors)).status).toBe(200);
    }
    const moderated = label.startsWith('moderated');
    if (moderated) {
      await patch('consent-case', { state: 'under_moderator_review' });
      await patch('consent-case', { state: 'restricted_pending_user_response' });
    }
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
    const original = new Request('https://api.test/v1/minor-review-cases/consent-case/parent-consent', {
      method: 'POST', body: form,
    });
    const request = () => original.clone();
    try {
      const consentEnv = { ...env, ZENDESK_SUBDOMAIN: 'test', ZENDESK_EMAIL: 'agent@test.com', ZENDESK_API_TOKEN: 'token', CONSENT_VIDEO_BUCKET: bucket as unknown as R2Bucket };
      expect((await submitSignedConsent(request(), 'consent-case', owner, consentEnv, cors)).status).toBe(200);
      const status = await (await handleGetModerationStatus(owner, consentEnv, cors)).json() as ModerationStatusResponse;
      expect(status.restriction.status).toBe(restriction);
      const caseRow = await DB.prepare('SELECT state, version, clock_paused, parent_contact_email FROM age_review_cases WHERE id = ?')
        .bind('consent-case').first<{ state: string; version: number; clock_paused: number; parent_contact_email: string }>();
      expect(caseRow).toMatchObject({ state: 'submitted_for_review', version: moderated ? 5 : 3, clock_paused: 1, parent_contact_email: 'parent@example.com' });
      const submission = await DB.prepare('SELECT status, lease_until, receipt_id, object_key, size_bytes FROM age_review_parent_consent_submissions WHERE case_id = ?')
        .bind('consent-case').first<{ status: string; lease_until: number; receipt_id: string; object_key: string; size_bytes: number }>();
      expect(submission).toMatchObject({ status: 'commented', lease_until: 0, size_bytes: 4 });
      expect(submission!.receipt_id).toBeTruthy();
      expect(objects.get(submission!.object_key)).toEqual(new TextEncoder().encode('clip'));
      expect(commentBody).toContain(`/api/age-review/consent-video/${submission!.receipt_id}`);
      expect(calls).toHaveLength(3);
      expect((await submitSignedConsent(request(), 'consent-case', owner, consentEnv, cors)).status).toBe(200);
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
      const res = await submitSignedConsent(request, 'consent-case-404', 'b'.repeat(64), { ...env }, cors);
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

describe('concurrent parent-consent submissions on real D1', () => {
  beforeEach(reset);
  afterEach(() => vi.restoreAllMocks());

  const owner = 'c'.repeat(64);
  const boundary = 'round-boundary';
  const url = 'https://api.test/v1/minor-review-cases/round-case/parent-consent';

  async function seedSentBackRound() {
    await DB.prepare(`INSERT INTO age_review_cases
      (id, pubkey, state, suspected_age_band, zendesk_ticket_id, deadline_at, clock_paused, version)
      VALUES ('round-case', ?, 'restricted_pending_parental_consent', 'age_13_15', 42, ?, 0, 9)`)
      .bind(owner, new Date(Date.now() + 9 * 864e5).toISOString()).run();
    await DB.prepare(`INSERT INTO age_review_parent_consent_submissions
      (case_id, status, ticket_id, lease_until, created_at, receipt_id, object_key, case_version)
      VALUES ('round-case', 'commented', 42, 0, 1, 'old-receipt', 'old-key', 7)`).run();
  }

  function upload(clip: string) {
    const raw = `--${boundary}\r\nContent-Disposition: form-data; name="email"\r\n\r\nparent@example.com\r\n--${boundary}\r\nContent-Disposition: form-data; name="video"; filename="clip.mp4"\r\nContent-Type: video/mp4\r\n\r\n${clip}\r\n--${boundary}--\r\n`;
    return new Request(url, { method: 'POST', headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` }, body: raw });
  }

  // Each request gets its own bucket view over one shared object store, so a
  // test can tell whose clip is whose and hold one request at a chosen step.
  function bucketView(objects: Map<string, string>, keys: string[], beforeComplete: () => Promise<void> = async () => {}) {
    return {
      head: async (key: string) => (objects.has(key) ? { size: objects.get(key)!.length } : null),
      createMultipartUpload: async (key: string) => {
        keys.push(key);
        const chunks: Uint8Array[] = [];
        return {
          uploadPart: async (n: number, v: Uint8Array) => { chunks.push(new Uint8Array(v)); return { partNumber: n, etag: `e${n}` }; },
          complete: async () => {
            await beforeComplete();
            objects.set(key, new TextDecoder().decode(new Uint8Array(chunks.flatMap((c) => [...c]))));
            return {};
          },
          abort: async () => {},
        };
      },
      delete: async (key: string) => { objects.delete(key); },
    } as unknown as R2Bucket;
  }

  function zendesk(onComment: (count: number) => Promise<void> = async () => {}) {
    const comments: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const target = String(input);
      if (target.endsWith('/tickets/42')) {
        comments.push((JSON.parse(String(init?.body)) as { ticket: { comment: { body: string } } }).ticket.comment.body);
        await onComment(comments.length);
        return new Response('{}', { status: 200 });
      }
      if (target.includes('/tickets/42/comments?')) {
        return new Response(JSON.stringify({ comments: comments.map((body) => ({ body })) }), { status: 200 });
      }
      throw new Error(`Unexpected request: ${target}`);
    });
    return comments;
  }

  const zendeskEnv = { ZENDESK_SUBDOMAIN: 'test', ZENDESK_EMAIL: 'agent@test.com', ZENDESK_API_TOKEN: 'token' };

  async function submissionRow() {
    return DB.prepare('SELECT status, receipt_id, object_key, case_version FROM age_review_parent_consent_submissions WHERE case_id = ?')
      .bind('round-case').first<{ status: string; receipt_id: string; object_key: string; case_version: number }>();
  }

  it('a slower request for the same new round cannot replace the round another request recorded', async () => {
    await seedSentBackRound();
    const objects = new Map([['old-key', 'old']]);
    const comments = zendesk();
    const aKeys: string[] = [];
    const bKeys: string[] = [];
    let bReady!: () => void;
    const bAtComplete = new Promise<void>((resolve) => { bReady = resolve; });
    let releaseB!: () => void;
    const bGate = new Promise<void>((resolve) => { releaseB = resolve; });
    const bucketB = bucketView(objects, bKeys, async () => { bReady(); await bGate; });
    const slower = submitSignedConsent(upload('clipB'), 'round-case', owner, { ...env, ...zendeskEnv, CONSENT_VIDEO_BUCKET: bucketB }, cors);
    await bAtComplete;

    const first = await submitSignedConsent(upload('clipA'), 'round-case', owner, { ...env, ...zendeskEnv, CONSENT_VIDEO_BUCKET: bucketView(objects, aKeys) }, cors);
    expect(first.status).toBe(200);
    releaseB();
    expect((await slower).status).toBe(409);

    const row = await submissionRow();
    expect(row).toMatchObject({ status: 'commented', object_key: aKeys[0], case_version: 9 });
    expect([...objects.entries()]).toEqual([[aKeys[0], 'clipA']]);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain(row!.receipt_id);
    expect(await rowOf('round-case')).toMatchObject({ state: 'submitted_for_review', version: 10 });
  });

  it('a request that reads a round another request just reset waits for its lease', async () => {
    await seedSentBackRound();
    const objects = new Map([['old-key', 'old']]);
    const comments = zendesk();
    let aReset!: () => void;
    const aAfterReset = new Promise<void>((resolve) => { aReset = resolve; });
    let releaseA!: () => void;
    const aGate = new Promise<void>((resolve) => { releaseA = resolve; });
    // Hold the first request between its round reset and its row claim.
    const heldDb = {
      prepare: (sql: string) => {
        const statement = DB.prepare(sql);
        if (!sql.includes('INSERT OR IGNORE INTO age_review_parent_consent_submissions')) return statement;
        return {
          bind: (...args: unknown[]) => {
            const bound = statement.bind(...args);
            return { run: async () => { aReset(); await aGate; return bound.run(); } };
          },
        };
      },
    } as unknown as D1Database;
    const aKeys: string[] = [];
    const first = submitSignedConsent(upload('clipA'), 'round-case', owner, { ...env, DB: heldDb, ...zendeskEnv, CONSENT_VIDEO_BUCKET: bucketView(objects, aKeys) }, cors);
    await aAfterReset;

    const second = await submitSignedConsent(upload('clipB'), 'round-case', owner, { ...env, ...zendeskEnv, CONSENT_VIDEO_BUCKET: bucketView(objects, []) }, cors);
    expect(second.status).toBe(409);
    releaseA();
    expect((await first).status).toBe(200);

    expect(await submissionRow()).toMatchObject({ status: 'commented', object_key: aKeys[0], case_version: 9 });
    expect([...objects.entries()]).toEqual([[aKeys[0], 'clipA']]);
    expect(comments).toHaveLength(1);
  });

  it.each(['stored', 'commented', 'submitted'].flatMap(stage => ['email', 'video', 'boundary'].map(change => [stage, change])))('refuses a different signed body on a %s retry (%s) without changing its email or clip', async (stage, change) => {
    await seedOpenCase();
    const objects = new Map<string, string>();
    const comments = zendesk();
    const bucket = bucketView(objects, []);
    const consentEnv = { ...env, ...zendeskEnv, CONSENT_VIDEO_BUCKET: bucket };
    expect((await submitSignedConsent(upload('first'), 'round-case', owner, consentEnv, cors)).status).toBe(200);
    if (stage !== 'submitted') {
      await DB.prepare("UPDATE age_review_cases SET state = 'restricted_pending_parental_consent', version = 2 WHERE id = 'round-case'").run();
      await DB.prepare('UPDATE age_review_parent_consent_submissions SET status = ?, lease_until = 0 WHERE case_id = ?').bind(stage, 'round-case').run();
    }
    const before = await submissionRow();
    const changed = upload(change === 'video' ? 'second' : 'first');
    let raw = await changed.text();
    if (change === 'email') raw = raw.replace('parent@example.com', 'different@example.com');
    if (change === 'boundary') {
      raw = raw.replaceAll(boundary, 'new-boundary');
      changed.headers.set('Content-Type', 'multipart/form-data; boundary=new-boundary');
    }
    const response = await submitSignedConsent(new Request(url, { method: 'POST', headers: changed.headers, body: raw }), 'round-case', owner, consentEnv, cors);
    expect(response.status).toBe(409);
    expect(await submissionRow()).toEqual(before);
    expect([...objects.values()]).toEqual(['first']);
    expect(await DB.prepare("SELECT parent_contact_email FROM age_review_cases WHERE id = 'round-case'").first()).toEqual({ parent_contact_email: 'parent@example.com' });
    expect(comments).toHaveLength(1);
    expect((await submitSignedConsent(upload('first'), 'round-case', owner, consentEnv, cors)).status).toBe(200);
    expect(comments).toHaveLength(1);
  });

  it('retention retries a failed delete of a losing upload without deleting the accepted clip', async () => {
    await seedOpenCase();
    const objects = new Map<string, string>();
    const comments = zendesk();
    let ready!: () => void;
    const atComplete = new Promise<void>((resolve) => { ready = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const losingKeys: string[] = [];
    const losingBucket = bucketView(objects, losingKeys, async () => { ready(); await gate; });
    losingBucket.delete = vi.fn().mockRejectedValue(new Error('temporary storage failure'));
    const losing = submitSignedConsent(upload('loser'), 'round-case', owner, { ...env, ...zendeskEnv, CONSENT_VIDEO_BUCKET: losingBucket }, cors);
    await atComplete;
    const winnerBucket = bucketView(objects, []);
    expect((await submitSignedConsent(upload('winner'), 'round-case', owner, { ...env, ...zendeskEnv, CONSENT_VIDEO_BUCKET: winnerBucket }, cors)).status).toBe(200);
    release();
    expect((await losing).status).toBe(409);
    expect(objects.size).toBe(2);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2 * 864e5);
    await disposeDueConsentVideos(DB, winnerBucket);
    expect([...objects.values()]).toEqual(['winner']);
    expect(comments).toHaveLength(1);
  });

  it.each(['stored', 'commented', 'submitted'])('refuses a legacy %s retry with no saved fingerprint', async (stage) => {
    await seedOpenCase();
    const objects = new Map<string, string>();
    zendesk();
    const consentEnv = { ...env, ...zendeskEnv, CONSENT_VIDEO_BUCKET: bucketView(objects, []) };
    expect((await submitSignedConsent(upload('original'), 'round-case', owner, consentEnv, cors)).status).toBe(200);
    await DB.prepare("UPDATE age_review_parent_consent_submissions SET payload_hash = NULL WHERE case_id = 'round-case'").run();
    if (stage !== 'submitted') {
      await DB.prepare("UPDATE age_review_cases SET state = 'restricted_pending_parental_consent', version = 2 WHERE id = 'round-case'").run();
      await DB.prepare("UPDATE age_review_parent_consent_submissions SET status = ?, lease_until = 0 WHERE case_id = 'round-case'").bind(stage).run();
    }
    expect((await submitSignedConsent(upload('original'), 'round-case', owner, consentEnv, cors)).status).toBe(409);
    expect([...objects.values()]).toEqual(['original']);
  });

  // Change one identity column on the commented row just before the case
  // advances; the advance must submit the case only against a row that
  // still holds this request's clip and fingerprint.
  it.each([
    ['object_key', 'other-key'],
    ['payload_hash', 'f'.repeat(64)],
    ['status', 'stored'],
  ])('does not submit the case when the row\'s %s changes before the advance', async (column, value) => {
    await seedOpenCase();
    const objects = new Map<string, string>();
    zendesk();
    let swapped = false;
    const racingDb = new Proxy(DB, {
      get(target, prop) {
        if (prop === 'prepare') {
          return (sql: string) => {
            const stmt = target.prepare(sql);
            if (swapped || !sql.includes("state = 'submitted_for_review'") || !sql.includes('EXISTS')) return stmt;
            return { bind: (...args: unknown[]) => ({ run: async () => {
              swapped = true;
              await target.prepare(`UPDATE age_review_parent_consent_submissions SET ${column} = ? WHERE case_id = 'round-case'`).bind(value).run();
              return stmt.bind(...args).run();
            } }) };
          };
        }
        const member = Reflect.get(target, prop);
        return typeof member === 'function' ? member.bind(target) : member;
      },
    });
    const res = await submitSignedConsent(upload('clip'), 'round-case', owner, { ...env, DB: racingDb, ...zendeskEnv, CONSENT_VIDEO_BUCKET: bucketView(objects, []) }, cors);
    expect(swapped).toBe(true);
    expect(res.status).toBe(409);
    expect(await rowOf('round-case')).toMatchObject({ state: 'restricted_pending_parental_consent', version: 2 });
  });

  it('leaves an unreferenced upload in storage for its first day', async () => {
    await seedOpenCase();
    const start = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(start);
    await trackConsentObject(DB, 'round-case', 'fresh-key');
    const objects = new Map([['fresh-key', 'fresh']]);
    const bucket = bucketView(objects, []);
    clock.mockReturnValue(start + 23 * 3600 * 1000);
    await disposeDueConsentVideos(DB, bucket);
    expect([...objects.keys()]).toEqual(['fresh-key']);
    clock.mockReturnValue(start + 25 * 3600 * 1000);
    await disposeDueConsentVideos(DB, bucket);
    expect(objects.size).toBe(0);
  });

  it('cannot adopt a stalled upload after retention has claimed its unreferenced key', async () => {
    await seedOpenCase();
    const objects = new Map<string, string>();
    const comments = zendesk();
    const bucket = bucketView(objects, [], async () => {
      const now = Date.now();
      const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 2 * 864e5);
      await disposeDueConsentVideos(DB, bucket);
      clock.mockRestore();
    });
    expect((await submitSignedConsent(upload('stalled'), 'round-case', owner, { ...env, ...zendeskEnv, CONSENT_VIDEO_BUCKET: bucket }, cors)).status).toBe(409);
    expect(objects.size).toBe(0);
    expect(comments).toHaveLength(0);
    expect(await submissionRow()).toBeNull();
  });

  it('keeps failed replacement cleanup retryable and honors legal holds', async () => {
    await seedOpenCase();
    await DB.prepare(`INSERT INTO age_review_parent_consent_submissions (case_id, status, lease_until, created_at, receipt_id, object_key)
      VALUES ('round-case', 'processing', 1, 1, 'old-receipt', 'old-key')`).run();
    const objects = new Map([['old-key', 'old']]);
    zendesk();
    const bucket = bucketView(objects, []);
    const remove = bucket.delete.bind(bucket);
    bucket.delete = vi.fn().mockRejectedValue(new Error('temporary deletion failure'));
    expect((await submitSignedConsent(upload('new'), 'round-case', owner, { ...env, ...zendeskEnv, CONSENT_VIDEO_BUCKET: bucket }, cors)).status).toBe(200);
    expect(objects.size).toBe(2);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2 * 864e5);
    await disposeDueConsentVideos(DB, bucket);
    expect(await DB.prepare("SELECT state FROM age_review_consent_objects WHERE object_key = 'old-key'").first()).toEqual({ state: 'deleting' });
    await DB.prepare(`INSERT INTO retention_legal_holds (id, record_type, record_key, disposal_stage, authorized_role, starts_at, review_at)
      VALUES ('cleanup-hold', 'age_review_case', 'round-case', 'consent_video', 'privacy/legal', '2020-01-01', '2030-01-01')`).run();
    bucket.delete = vi.fn(remove);
    await disposeDueConsentVideos(DB, bucket);
    expect(bucket.delete).not.toHaveBeenCalled();
    await DB.prepare("DELETE FROM retention_legal_holds WHERE id = 'cleanup-hold'").run();
    await disposeDueConsentVideos(DB, bucket);
    expect([...objects.values()]).toEqual(['new']);
    expect(await DB.prepare("SELECT 1 FROM age_review_consent_objects WHERE object_key = 'old-key'").first()).toBeNull();
  });

  async function seedOpenCase() {
    await DB.prepare(`INSERT INTO age_review_cases
      (id, pubkey, state, suspected_age_band, zendesk_ticket_id, deadline_at, clock_paused, version)
      VALUES ('round-case', ?, 'restricted_pending_parental_consent', 'age_13_15', 42, ?, 0, 2)`)
      .bind(owner, new Date(Date.now() + 9 * 864e5).toISOString()).run();
  }

  it('deletes its own clip when another request claims the first submission', async () => {
    await seedOpenCase();
    const objects = new Map<string, string>();
    const comments = zendesk();
    const claimFirst = async () => {
      await DB.prepare(`INSERT INTO age_review_parent_consent_submissions (case_id, lease_until, created_at, receipt_id, object_key)
        VALUES ('round-case', ?, 1, 'other-receipt', 'other-key')`).bind(Math.floor(Date.now() / 1000) + 600).run();
    };
    const res = await submitSignedConsent(upload('clipB'), 'round-case', owner, { ...env, ...zendeskEnv, CONSENT_VIDEO_BUCKET: bucketView(objects, [], claimFirst) }, cors);
    expect(res.status).toBe(409);
    expect(objects.size).toBe(0);
    expect(await submissionRow()).toMatchObject({ receipt_id: 'other-receipt', object_key: 'other-key' });
    expect(comments).toHaveLength(0);
  });

  // The held row is what a concurrent winner leaves between its claim and
  // its mark ('processing', clip already at its key), or a stored row whose
  // object is missing. Either way the loser must not write into that key.
  it.each([
    ['processing', [['held-key', 'clipA']]],
    ['stored', []],
  ] as const)('leaves a %s submission another request holds untouched and keeps none of its own upload', async (status, held) => {
    await seedOpenCase();
    await DB.prepare(`INSERT INTO age_review_parent_consent_submissions (case_id, status, lease_until, created_at, receipt_id, object_key, content_type, size_bytes)
      VALUES ('round-case', ?, ?, 1, 'held-receipt', 'held-key', 'video/mp4', 5)`).bind(status, Math.floor(Date.now() / 1000) + 600).run();
    await DB.prepare("UPDATE age_review_parent_consent_submissions SET payload_hash = ? WHERE case_id = 'round-case'").bind(await consentPayloadHash(upload('clipB'))).run();
    const objects = new Map<string, string>(held.map(([k, v]) => [k, v]));
    const comments = zendesk();
    const keys: string[] = [];
    const res = await submitSignedConsent(upload('clipB'), 'round-case', owner, { ...env, ...zendeskEnv, CONSENT_VIDEO_BUCKET: bucketView(objects, keys) }, cors);
    expect(res.status).toBe(409);
    expect(keys).toHaveLength(1);
    expect([...objects.entries()]).toEqual(held);
    expect(await submissionRow()).toMatchObject({ status, receipt_id: 'held-receipt', object_key: 'held-key' });
    expect(comments).toHaveLength(0);
  });

  it.each([
    ['processing', [['crashed-key', 'clipA']]],
    ['stored', []],
  ] as const)('resumes a crashed %s submission with its own clip and deletes the crashed key', async (status, crashed) => {
    await seedOpenCase();
    await DB.prepare(`INSERT INTO age_review_parent_consent_submissions (case_id, status, lease_until, created_at, receipt_id, object_key, content_type, size_bytes)
      VALUES ('round-case', ?, 1, 1, 'crashed-receipt', 'crashed-key', 'video/mp4', 5)`).bind(status).run();
    await DB.prepare("UPDATE age_review_parent_consent_submissions SET payload_hash = ? WHERE case_id = 'round-case'").bind(await consentPayloadHash(upload('clipB'))).run();
    const objects = new Map<string, string>(crashed.map(([k, v]) => [k, v]));
    const comments = zendesk();
    const keys: string[] = [];
    const res = await submitSignedConsent(upload('clipB'), 'round-case', owner, { ...env, ...zendeskEnv, CONSENT_VIDEO_BUCKET: bucketView(objects, keys) }, cors);
    expect(res.status).toBe(200);
    const row = await submissionRow();
    expect(row).toMatchObject({ status: 'commented', receipt_id: 'crashed-receipt', object_key: keys[0] });
    expect([...objects.entries()]).toEqual([[keys[0], 'clipB']]);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain('crashed-receipt');
    expect(await rowOf('round-case')).toMatchObject({ state: 'submitted_for_review' });
  });

  it('a resume that loses the row to a request that recorded its clip first keeps none of its own upload', async () => {
    await seedOpenCase();
    await DB.prepare(`INSERT INTO age_review_parent_consent_submissions (case_id, status, lease_until, created_at, receipt_id, object_key)
      VALUES ('round-case', 'processing', 1, 1, 'crashed-receipt', 'crashed-key')`).run();
    const objects = new Map([['crashed-key', 'clip0']]);
    // Zendesk is down, so the other request records its clip, releases the
    // lease and answers retry.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 500 }));
    let bReady!: () => void;
    const bAtComplete = new Promise<void>((resolve) => { bReady = resolve; });
    let releaseB!: () => void;
    const bGate = new Promise<void>((resolve) => { releaseB = resolve; });
    const bKeys: string[] = [];
    const slower = submitSignedConsent(upload('clipB'), 'round-case', owner, { ...env, ...zendeskEnv, CONSENT_VIDEO_BUCKET: bucketView(objects, bKeys, async () => { bReady(); await bGate; }) }, cors);
    await bAtComplete;

    const cKeys: string[] = [];
    const other = await submitSignedConsent(upload('clipC'), 'round-case', owner, { ...env, ...zendeskEnv, CONSENT_VIDEO_BUCKET: bucketView(objects, cKeys) }, cors);
    expect(other.status).toBe(503);
    releaseB();
    expect((await slower).status).toBe(409);

    expect(await submissionRow()).toMatchObject({ status: 'stored', receipt_id: 'crashed-receipt', object_key: cKeys[0] });
    expect([...objects.entries()]).toEqual([[cKeys[0], 'clipC']]);
  });

  it('a stalled request whose lease another request took over cannot repoint the submission or free the lease', async () => {
    await seedOpenCase();
    const objects = new Map<string, string>();
    // Hold the second request at its first Zendesk call, after it has
    // recorded its clip and while it still holds the lease.
    let bAtZendesk!: () => void;
    const bLinking = new Promise<void>((resolve) => { bAtZendesk = resolve; });
    let releaseB!: () => void;
    const bGate = new Promise<void>((resolve) => { releaseB = resolve; });
    let gated = false;
    const comments = zendesk();
    const zendeskFetch = vi.mocked(globalThis.fetch).getMockImplementation()!;
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      if (!gated) { gated = true; bAtZendesk(); await bGate; }
      return zendeskFetch(input, init);
    });
    let aAtMark!: () => void;
    const aMarking = new Promise<void>((resolve) => { aAtMark = resolve; });
    let releaseA!: () => void;
    const aGate = new Promise<void>((resolve) => { releaseA = resolve; });
    // Hold the first request after its claim, just before it marks its clip stored.
    const heldDb = {
      prepare: (sql: string) => {
        const statement = DB.prepare(sql);
        if (!sql.includes("SET status = 'stored'")) return statement;
        return {
          bind: (...args: unknown[]) => {
            const bound = statement.bind(...args);
            return { run: async () => { aAtMark(); await aGate; return bound.run(); } };
          },
        };
      },
    } as unknown as D1Database;
    const aKeys: string[] = [];
    const first = submitSignedConsent(upload('clipA'), 'round-case', owner, { ...env, DB: heldDb, ...zendeskEnv, CONSENT_VIDEO_BUCKET: bucketView(objects, aKeys) }, cors);
    await aMarking;
    // The first request's lease runs out while it is stalled.
    await DB.prepare("UPDATE age_review_parent_consent_submissions SET lease_until = 1 WHERE case_id = 'round-case'").run();

    const bKeys: string[] = [];
    const second = submitSignedConsent(upload('clipA'), 'round-case', owner, { ...env, ...zendeskEnv, CONSENT_VIDEO_BUCKET: bucketView(objects, bKeys) }, cors);
    await bLinking;
    releaseA();
    expect((await first).status).toBe(409);
    const held = await DB.prepare("SELECT status, object_key, lease_until FROM age_review_parent_consent_submissions WHERE case_id = 'round-case'")
      .first<{ status: string; object_key: string; lease_until: number }>();
    expect(held).toMatchObject({ status: 'stored', object_key: bKeys[0] });
    expect(held!.lease_until).toBeGreaterThan(Math.floor(Date.now() / 1000));
    releaseB();
    expect((await second).status).toBe(200);

    expect(await submissionRow()).toMatchObject({ status: 'commented', object_key: bKeys[0] });
    expect([...objects.entries()]).toEqual([[bKeys[0], 'clipA']]);
    expect(comments).toHaveLength(1);
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

  // Hex pubkey: an approval binds it and the bindings table CHECKs the shape.
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

  it('ensureSchema surfaces an ALTER failure that is not a duplicate column', async () => {
    const failing = {
      prepare: (sql: string) => sql.includes('ADD COLUMN clear_resolution')
        ? { run: () => Promise.reject(new Error('D1_ERROR: database is locked')) }
        : DB.prepare(sql),
    } as unknown as D1Database;
    await expect(ensureSchema(failing)).rejects.toThrow('database is locked');
  });
});

describe('approving a 13-15 minor', () => {
  const pubkey = '7'.repeat(64);
  // Relay and bulk legs resolve ok against the stubbed fetch, so the keycast set leg
  // is the only one that can decide enforcementComplete / the 200-vs-207 status.
  const keycastEnv = () => ({
    ...env,
    KEYCAST_URL: 'https://keycast.invalid',
    KEYCAST_SERVICE_TOKEN: 'test-token',
    NOSTR_NSEC: 'nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5',
    RELAY_URL: 'wss://relay.invalid',
  } as unknown as Parameters<typeof handleUpdateAgeReviewCase>[2]);
  let keycastPuts: string[];

  beforeEach(async () => {
    await reset();
    for (const table of ['protected_minor_projection_jobs', 'protected_minor_account_bindings', 'protected_minor_subjects']) {
      await DB.prepare(`DELETE FROM ${table}`).run();
    }
    await DB.prepare(
      `INSERT INTO age_review_cases (id, pubkey, state, suspected_age_band, deadline_at, clock_paused, version)
       VALUES ('ap', ?, 'submitted_for_review', 'age_13_15', ?, 0, 0)`,
    ).bind(pubkey, new Date(Date.now() + 9 * 864e5).toISOString()).run();
    keycastPuts = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      if (String(input).includes('/verified-minor') && init?.method === 'PUT') keycastPuts.push(String(input));
      return Promise.resolve(new Response('{}', { status: 200 }));
    });
  });
  afterEach(() => vi.restoreAllMocks());

  function approve(body: Record<string, unknown> = {}) {
    const req = new Request('https://api.test/api/age-review/cases/ap', {
      method: 'PATCH',
      body: JSON.stringify({ state: 'cleared', resolution: 'approved_minor', ...body }),
    });
    return handleUpdateAgeReviewCase(req, 'ap', keycastEnv(), cors);
  }
  const rowCount = async (table: string) => (await DB.prepare(`SELECT COUNT(*) AS c FROM ${table}`)
    .first<{ c: number }>())!.c;
  const pendingJobs = async () => (await DB.prepare(
    "SELECT COUNT(*) AS c FROM protected_minor_projection_jobs WHERE state = 'pending'",
  ).first<{ c: number }>())!.c;

  it('records an active subject sourced from the case and projects verified_minor', async () => {
    const res = await approve();
    const body = await res.json() as {
      enforcementComplete: boolean;
      enforcement: { subjectActivate: string; keycastMinorSet: string };
    };
    expect(res.status).toBe(200);
    expect(body.enforcementComplete).toBe(true);
    expect(body.enforcement.subjectActivate).toBe('ok');
    expect(body.enforcement.keycastMinorSet).toBe('ok');
    expect(await resolveByPubkey(DB, pubkey)).not.toBeNull();
    const subject = await DB.prepare('SELECT source_case_id, classification_state FROM protected_minor_subjects')
      .first<{ source_case_id: string; classification_state: string }>();
    expect(subject).toEqual({ source_case_id: 'ap', classification_state: 'active' });
    expect(keycastPuts).toEqual([
      `https://keycast.invalid/api/admin/users/${pubkey}/verified-minor?reason=age_review_approved`,
    ]);
    expect(await pendingJobs()).toBe(0);
  });

  // The handler's up-front version check rejects a stale client before the batch
  // runs, so the batch's own CAS guard is only reachable under a true race. Drive
  // the statements directly to prove each write is gated on the CAS having landed.
  describe('approvalRegistryStatements guard', () => {
    async function runWith(landedVersion: number) {
      await DB.batch(approvalRegistryStatements(DB, {
        caseId: 'ap', pubkey, landedVersion, now: new Date().toISOString(),
      }));
    }

    it('writes subject, binding and job when the case landed at that version as approved_minor', async () => {
      await DB.prepare("UPDATE age_review_cases SET state = 'cleared', clear_resolution = 'approved_minor', version = 3 WHERE id = 'ap'").run();
      await runWith(3);
      expect(await resolveByPubkey(DB, pubkey)).not.toBeNull();
      expect(await pendingJobs()).toBe(1);
    });

    // Retention's overdue-projection alarm measures from created_at, so re-approving
    // must not make a still-failing projection look new.
    describe('created_at of the existing subject\'s job', () => {
      const old = '2026-01-01T00:00:00.000Z';
      async function existingJob(state: 'pending' | 'complete') {
        const { subjectId } = await createSubjectWithBinding(DB, 'onboarding-case', pubkey);
        await DB.prepare(`INSERT INTO protected_minor_projection_jobs
          (subject_id, pubkey, reason, state, created_at, updated_at)
          VALUES (?, ?, 'age_review_approved', ?, ?, ?)`).bind(subjectId, pubkey, state, old, old).run();
        await DB.prepare("UPDATE age_review_cases SET state = 'cleared', clear_resolution = 'approved_minor', version = 3 WHERE id = 'ap'").run();
        await runWith(3);
        return DB.prepare('SELECT state, created_at FROM protected_minor_projection_jobs WHERE subject_id = ?')
          .bind(subjectId).first<{ state: string; created_at: string }>();
      }

      it('is kept when the job is already pending', async () => {
        expect(await existingJob('pending')).toEqual({ state: 'pending', created_at: old });
      });

      it('is reset when a settled job is re-armed', async () => {
        const job = await existingJob('complete');
        expect(job!.state).toBe('pending');
        expect(job!.created_at).not.toBe(old);
      });
    });

    it('writes nothing when the CAS missed (case not at the landed version)', async () => {
      await DB.prepare("UPDATE age_review_cases SET state = 'cleared', clear_resolution = 'approved_minor', version = 3 WHERE id = 'ap'").run();
      await runWith(4);
      expect(await rowCount('protected_minor_subjects')).toBe(0);
      expect(await rowCount('protected_minor_account_bindings')).toBe(0);
      expect(await rowCount('protected_minor_projection_jobs')).toBe(0);
    });

    it('writes nothing for a case resolved as not_minor', async () => {
      await DB.prepare("UPDATE age_review_cases SET state = 'cleared', clear_resolution = 'not_minor', version = 3 WHERE id = 'ap'").run();
      await runWith(3);
      expect(await rowCount('protected_minor_subjects')).toBe(0);
      expect(await rowCount('protected_minor_account_bindings')).toBe(0);
      expect(await rowCount('protected_minor_projection_jobs')).toBe(0);
    });
  });

  // subjectActivate is observed from the batch, not assumed. A live binding to a
  // CLEARED subject (an invariant break) blocks a new subject and gives the job
  // upsert no active subject to arm: the case is approved but nothing is protected.
  it('reports subjectActivate failed (207) and skips the keycast set when the batch arms no job', async () => {
    const now = new Date().toISOString();
    await DB.prepare(`INSERT INTO protected_minor_subjects
      (subject_id, classification_state, classified_at, cleared_at, clear_reason, clear_reason_class)
      VALUES ('22222222-2222-4222-8222-222222222222', 'cleared', ?, ?, 'age_review_denied', 'valid_prior')`)
      .bind(now, now).run();
    await DB.prepare(`INSERT INTO protected_minor_account_bindings (id, subject_id, pubkey, bound_at)
      VALUES ('broken-binding', '22222222-2222-4222-8222-222222222222', ?, ?)`).bind(pubkey, now).run();

    const res = await approve();
    const body = await res.json() as {
      enforcementComplete: boolean;
      enforcement: { subjectActivate: string; subjectActivateError?: string; keycastMinorSet: string };
    };
    expect(res.status).toBe(207);
    expect(body.enforcementComplete).toBe(false);
    expect(body.enforcement.subjectActivate).toBe('failed');
    expect(body.enforcement.subjectActivateError).toMatch(/no protected-minor projection/i);
    expect(body.enforcement.keycastMinorSet).toBe('not_attempted');
    expect(keycastPuts).toEqual([]);
    expect(await rowCount('protected_minor_projection_jobs')).toBe(0);
  });

  it('reuses an existing active subject instead of creating a second one', async () => {
    await createSubjectWithBinding(DB, 'onboarding-case', pubkey);
    const res = await approve();
    expect(res.status).not.toBe(500);
    const count = await DB.prepare('SELECT COUNT(*) AS c FROM protected_minor_subjects').first<{ c: number }>();
    expect(count!.c).toBe(1);
    expect(keycastPuts).toHaveLength(1);
  });

  it('arms the EXISTING subject\'s job when reusing it (keycast down so it stays pending)', async () => {
    const { subjectId } = await createSubjectWithBinding(DB, 'onboarding-case', pubkey);
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => Promise.resolve(
      String(input).includes('/verified-minor') ? new Response('Not Found', { status: 404 }) : new Response('{}', { status: 200 }),
    ));
    await approve();
    const jobs = await DB.prepare("SELECT subject_id FROM protected_minor_projection_jobs WHERE state = 'pending'")
      .all<{ subject_id: string }>();
    expect(jobs.results).toEqual([{ subject_id: subjectId }]);
  });

  it('refuses approved_minor for a case whose pubkey cannot be bound (400, case untouched)', async () => {
    await DB.prepare("UPDATE age_review_cases SET pubkey = 'not-hex' WHERE id = 'ap'").run();
    const res = await approve();
    expect(res.status).toBe(400);
    const row = await DB.prepare("SELECT state FROM age_review_cases WHERE id = 'ap'").first<{ state: string }>();
    expect(row!.state).toBe('submitted_for_review');
    expect(await rowCount('protected_minor_subjects')).toBe(0);
  });

  it('keeps the job pending when keycast fails (route not yet deployed)', async () => {
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => Promise.resolve(
      String(input).includes('/verified-minor') ? new Response('Not Found', { status: 404 }) : new Response('{}', { status: 200 }),
    ));
    const res = await approve();
    expect(res.status).toBe(207);
    const body = await res.json() as { enforcementComplete: boolean; enforcement: { keycastMinorSet: string } };
    expect(body.enforcementComplete).toBe(false);
    expect(body.enforcement.keycastMinorSet).toBe('failed');
    expect(await pendingJobs()).toBe(1);
    expect(await resolveByPubkey(DB, pubkey)).not.toBeNull(); // the approval itself stands
  });

  it('settles the job for a self-custody account (keycast user not found)', async () => {
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => Promise.resolve(
      String(input).includes('/verified-minor')
        ? new Response('{"error":"user not found"}', { status: 404 })
        : new Response('{}', { status: 200 }),
    ));
    const body = await (await approve()).json() as { enforcement: { keycastMinorSet: string } };
    expect(body.enforcement.keycastMinorSet).toBe('not_applicable');
    expect(await pendingJobs()).toBe(0);
  });

  it('settles but reports a set keycast refuses as account_unclaimed', async () => {
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => Promise.resolve(
      String(input).includes('/verified-minor')
        ? new Response('{"error":"account_unclaimed: account has no login credentials"}', { status: 409 })
        : new Response('{}', { status: 200 }),
    ));
    const res = await approve();
    expect(res.status).toBe(207);
    const body = await res.json() as { enforcement: { keycastMinorSet: string; keycastMinorSetUnclaimed?: boolean } };
    expect(body.enforcement.keycastMinorSet).toBe('failed');
    // Permanent, so the UI must not promise a retry.
    expect(body.enforcement.keycastMinorSetUnclaimed).toBe(true);
    expect(await pendingJobs()).toBe(0);
  });

  it('the cron sets the flag an approval was refused, once the account is claimed (#304)', async () => {
    vi.restoreAllMocks();
    vi.useFakeTimers({ toFake: ['Date'], now: new Date() });
    try {
      let claimed = false;
      const puts: number[] = [];
      vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
        if (!String(input).includes('/verified-minor') || init?.method !== 'PUT') {
          return Promise.resolve(new Response('{}', { status: 200 }));
        }
        const status = claimed ? 200 : 409;
        puts.push(status);
        return Promise.resolve(claimed
          ? new Response('{}', { status })
          : new Response('{"error":"account_unclaimed: account has no login credentials"}', { status }));
      });
      await approve();
      claimed = true;
      vi.setSystemTime(Date.now() + 61 * 60 * 1000);

      await checkAgeReviewDeadlines(keycastEnv());

      expect(puts).toEqual([409, 200]);
      expect(await pendingJobs()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a second Approve on the closed case is refused and writes nothing', async () => {
    await approve();
    const again = await approve();
    expect(again.status).toBe(400);
    const count = await DB.prepare('SELECT COUNT(*) AS c FROM protected_minor_subjects').first<{ c: number }>();
    expect(count!.c).toBe(1);
  });

  it('not_minor makes no keycast set call', async () => {
    const req = new Request('https://api.test/api/age-review/cases/ap', {
      method: 'PATCH', body: JSON.stringify({ state: 'cleared', resolution: 'not_minor' }),
    });
    const body = await (await handleUpdateAgeReviewCase(req, 'ap', keycastEnv(), cors)).json() as {
      enforcement: { keycastMinorSet: string; subjectActivate: string };
    };
    expect(body.enforcement.keycastMinorSet).toBe('not_attempted');
    expect(body.enforcement.subjectActivate).toBe('not_attempted');
    expect(keycastPuts).toHaveLength(0);
  });
});

// keycast must end mirroring D1 whichever order racing projections land in (#192).
// `flagged` models keycast's verified_minor: PUT sets it, DELETE clears it. Each
// test drives the inline leg into the race, then one cron tick must converge it.
describe('inline projection convergence after racing writes', () => {
  const P = 'e3'.repeat(32);
  const raceEnv = () => ({
    ...env,
    KEYCAST_URL: 'https://keycast.invalid',
    KEYCAST_SERVICE_TOKEN: 'test-token',
    NOSTR_NSEC: 'nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5',
    RELAY_URL: 'wss://relay.invalid',
  } as unknown as Parameters<typeof handleUpdateAgeReviewCase>[2]);
  let flagged: boolean;
  let calls: string[];
  const pendingCount = async () => (await DB.prepare(
    "SELECT COUNT(*) AS c FROM protected_minor_projection_jobs WHERE state = 'pending'",
  ).first<{ c: number }>())!.c;

  beforeEach(async () => {
    await reset();
    for (const table of ['protected_minor_projection_jobs', 'protected_minor_account_bindings', 'protected_minor_subjects']) {
      await DB.prepare(`DELETE FROM ${table}`).run();
    }
    flagged = false;
    calls = [];
  });
  afterEach(() => vi.restoreAllMocks());

  function stubKeycast(onCall: (method: string) => Promise<void>) {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (!String(input).includes('/verified-minor')) return new Response('{}', { status: 200 });
      const method = init?.method ?? 'GET';
      calls.push(method);
      await onCall(method); // the racing writer runs while this call is in flight
      flagged = method === 'PUT';
      return new Response('{}', { status: 200 });
    });
  }
  function patchCase(id: string, body: Record<string, unknown>) {
    return handleUpdateAgeReviewCase(new Request(`https://api.test/api/age-review/cases/${id}`, {
      method: 'PATCH', body: JSON.stringify(body),
    }), id, raceEnv(), cors);
  }

  it('X1: a deny clear landing after a racing approval set re-arms the live subject', async () => {
    await createSubjectWithBinding(DB, 'onboarding', P);
    await DB.prepare(`INSERT INTO age_review_cases (id, pubkey, state, deadline_at, clock_paused, version)
      VALUES ('x1-deny', ?, 'restricted_pending_user_response', ?, 0, 0)`)
      .bind(P, new Date(Date.now() + 9 * 864e5).toISOString()).run();
    let s2 = '';
    stubKeycast(async (method) => {
      if (method !== 'DELETE' || s2) return;
      // A newer approval creates S2 and completes its PUT while the deny's DELETE is in flight.
      await DB.prepare(`INSERT INTO age_review_cases (id, pubkey, state, clear_resolution, updated_at)
        VALUES ('x1-approve', ?, 'cleared', 'approved_minor', datetime('now', '+2 seconds'))`).bind(P).run();
      s2 = (await createSubjectWithBinding(DB, 'x1-approve', P)).subjectId;
      const now = new Date().toISOString();
      await DB.prepare(`INSERT INTO protected_minor_projection_jobs
        (subject_id, pubkey, reason, state, created_at, updated_at)
        VALUES (?, ?, 'age_review_approved', 'complete', ?, ?)`).bind(s2, P, now, now).run();
      flagged = true;
    });

    await patchCase('x1-deny', { state: 'denied_closed' });
    expect(calls).toEqual(['DELETE']);
    expect(flagged).toBe(false); // diverged: S2 is active and keycast is unflagged
    expect(await pendingCount()).toBe(1);

    await checkAgeReviewDeadlines(raceEnv());
    expect(calls).toEqual(['DELETE', 'PUT']);
    expect(flagged).toBe(true);
    expect(await pendingCount()).toBe(0);
  });

  it('X3: an approval landing while a deny runs its other legs keeps the subject and the keycast flag', async () => {
    await DB.prepare(`INSERT INTO age_review_cases (id, pubkey, state, deadline_at, clock_paused, version)
      VALUES ('x3-deny', ?, 'restricted_pending_user_response', ?, 0, 0)`)
      .bind(P, new Date(Date.now() + 9 * 864e5).toISOString()).run();
    let s2 = '';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes('/verified-minor')) calls.push(init?.method ?? 'GET');
      if (url.includes('keycast.invalid') && !url.includes('/verified-minor') && !s2) {
        // A newer approval creates S2 and completes its PUT while the deny's keycast ban is in flight.
        await DB.prepare(`INSERT INTO age_review_cases (id, pubkey, state, clear_resolution, updated_at)
          VALUES ('x3-approve', ?, 'cleared', 'approved_minor', datetime('now', '+2 seconds'))`).bind(P).run();
        s2 = (await createSubjectWithBinding(DB, 'x3-approve', P)).subjectId;
        const now = new Date().toISOString();
        await DB.prepare(`INSERT INTO protected_minor_projection_jobs
          (subject_id, pubkey, reason, state, created_at, updated_at)
          VALUES (?, ?, 'age_review_approved', 'complete', ?, ?)`).bind(s2, P, now, now).run();
      }
      return new Response('{}', { status: 200 });
    });

    const res = await patchCase('x3-deny', { state: 'denied_closed' });
    const body = await res.json() as { enforcement: { subjectClear: string; keycastMinorClear: string } };

    expect(s2).not.toBe('');
    expect(calls).toEqual([]); // no keycast DELETE for the approved minor
    expect(body.enforcement.subjectClear).toBe('ok');
    expect(body.enforcement.keycastMinorClear).toBe('not_attempted');
    const subject = await DB.prepare('SELECT classification_state FROM protected_minor_subjects WHERE subject_id = ?')
      .bind(s2).first<{ classification_state: string }>();
    expect(subject!.classification_state).toBe('active');
    const binding = await DB.prepare('SELECT unbound_at FROM protected_minor_account_bindings WHERE subject_id = ?')
      .bind(s2).first<{ unbound_at: string | null }>();
    expect(binding!.unbound_at).toBeNull();
    expect(await pendingCount()).toBe(0);
  });

  it('X2: an approval set landing after a racing denial completed its clear re-arms the clear', async () => {
    await DB.prepare(`INSERT INTO age_review_cases (id, pubkey, state, suspected_age_band, deadline_at, clock_paused, version)
      VALUES ('x2-approve', ?, 'submitted_for_review', 'age_13_15', ?, 0, 0)`)
      .bind(P, new Date(Date.now() + 9 * 864e5).toISOString()).run();
    let denied = false;
    stubKeycast(async (method) => {
      if (method !== 'PUT' || denied) return;
      // A denial clears the subject and its own DELETE completes while this PUT is in flight.
      denied = true;
      await clearSubject(DB, P, undefined, 'age_review_denied');
      flagged = false;
      await markProjectionComplete(DB, P, 'cleared');
    });

    await patchCase('x2-approve', { state: 'cleared', resolution: 'approved_minor' });
    expect(calls).toEqual(['PUT']);
    expect(flagged).toBe(true); // diverged: the subject is cleared and keycast is flagged
    expect(await pendingCount()).toBe(1);

    await checkAgeReviewDeadlines(raceEnv());
    expect(calls).toEqual(['PUT', 'DELETE']);
    expect(flagged).toBe(false);
    expect(await pendingCount()).toBe(0);
  });
});
