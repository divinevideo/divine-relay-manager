import { Miniflare } from 'miniflare';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureSchema } from '../src/db';
import { handleCreateMinorAccount, type AgeReviewEnv } from '../src/age-review';
import { partialEnv } from '../src/test-helpers/partial-env';
import { backfillProtectedMinorSubjects, clearSubject, closeBinding, convergeProjection, createSubjectWithBinding, fingerprintProvisioningRequest, handleProtectedMinorServiceRoute, pendingProjectionJobs, pendingSubjectClears, resolveByPubkey, startOrResumeReplacement } from '../src/protected-minors';
import { digestProvisioningFingerprint } from '../src/retention';

const PUBKEY_A = 'a'.repeat(64);
const PUBKEY_B = 'b'.repeat(64);
const PUBKEY_C = 'c'.repeat(64);
const ATTEMPT_A = '11111111-1111-4111-8111-111111111111';
let mf: Miniflare;
let DB: D1Database;

beforeAll(async () => {
  mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok"); } };',
    compatibilityDate: '2024-12-01', compatibilityFlags: ['nodejs_compat'], d1Databases: ['DB'] });
  DB = (await mf.getD1Database('DB')) as unknown as D1Database;
  await ensureSchema(DB);
});
afterAll(async () => mf.dispose());
beforeEach(async () => {
  await DB.prepare('DELETE FROM retention_alert_state').run();
  await DB.prepare('DELETE FROM retention_legal_holds').run();
  await DB.prepare('DELETE FROM protected_minor_projection_jobs').run();
  await DB.prepare('DELETE FROM protected_minor_provisioning_operations').run();
  await DB.prepare('DELETE FROM protected_minor_provisioning_tombstones').run();
  await DB.prepare('DELETE FROM protected_minor_account_bindings').run();
  await DB.prepare('DELETE FROM protected_minor_subjects').run();
  await DB.prepare('DELETE FROM age_review_cases').run();
});

/**
 * DB whose next batch first runs `before`: another writer landing between a
 * handler's reads and its write. Later batches pass straight through.
 */
function dbWithWriterBefore(before: () => Promise<unknown>): D1Database {
  let fired = false;
  return new Proxy(DB, {
    get(target, prop) {
      if (prop === 'batch') {
        return async (statements: D1PreparedStatement[]) => {
          if (!fired) { fired = true; await before(); }
          return target.batch(statements);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

describe('protected-minor registry on real D1', () => {
  it('ensureSchema creates all registry tables and remains idempotent', async () => {
    await expect(ensureSchema(DB)).resolves.not.toThrow();
    const rows = await DB.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'protected_minor_%' ORDER BY name`).all<{ name: string }>();
    expect(rows.results.map((row) => row.name)).toEqual([
      'protected_minor_account_bindings', 'protected_minor_projection_jobs',
      'protected_minor_provisioning_operations', 'protected_minor_provisioning_tombstones',
      'protected_minor_subjects',
    ]);
  });

  it('a clear after a completed approval projection re-arms the job instead of dropping it', async () => {
    const pubkey = 'd'.repeat(64);
    const { subjectId } = await createSubjectWithBinding(DB, 'case-approved-then-denied', pubkey);
    const earlier = '2026-01-01T00:00:00.000Z';
    await DB.prepare(`INSERT INTO protected_minor_projection_jobs
      (subject_id, pubkey, reason, state, created_at, updated_at)
      VALUES (?, ?, 'age_review_approved', 'complete', ?, ?)`).bind(subjectId, pubkey, earlier, earlier).run();

    const result = await clearSubject(DB, pubkey, undefined, 'age_review_denied');
    expect(result.success).toBe(true);

    const job = await DB.prepare(`SELECT state, reason FROM protected_minor_projection_jobs WHERE subject_id = ?`)
      .bind(subjectId).first<{ state: string; reason: string }>();
    expect(job).toEqual({ state: 'pending', reason: 'age_review_denied' });
    // Retention's overdue alarm ages pending jobs from created_at, so a re-arm restarts it.
    const rearmed = await DB.prepare(`SELECT created_at FROM protected_minor_projection_jobs WHERE subject_id = ?`)
      .bind(subjectId).first<{ created_at: string }>();
    expect(rearmed!.created_at > earlier).toBe(true);
    const jobs = await pendingProjectionJobs(DB);
    expect(jobs).toContainEqual({
      subjectId, pubkey, reason: 'age_review_denied', classification: 'cleared', superseded: false,
    });
  });

  it('a clear keeps the age of a job that is still pending, so the overdue alarm still fires', async () => {
    const pubkey = 'e'.repeat(64);
    const { subjectId } = await createSubjectWithBinding(DB, 'case-pending-then-denied', pubkey);
    const earlier = '2026-01-01T00:00:00.000Z';
    await DB.prepare(`INSERT INTO protected_minor_projection_jobs
      (subject_id, pubkey, reason, state, created_at, updated_at)
      VALUES (?, ?, 'age_review_approved', 'pending', ?, ?)`).bind(subjectId, pubkey, earlier, earlier).run();

    expect((await clearSubject(DB, pubkey, undefined, 'age_review_denied')).success).toBe(true);

    const job = await DB.prepare(`SELECT state, reason, created_at FROM protected_minor_projection_jobs WHERE subject_id = ?`)
      .bind(subjectId).first<{ state: string; reason: string; created_at: string }>();
    expect(job).toEqual({ state: 'pending', reason: 'age_review_denied', created_at: earlier });
  });

  it('resolves active subjects and clear wins without deleting binding history', async () => {
    const { subjectId } = await createSubjectWithBinding(DB, 'case-a', PUBKEY_A);
    expect(await resolveByPubkey(DB, PUBKEY_A)).toEqual({ subjectRef: subjectId });
    await expect(clearSubject(DB, PUBKEY_A, undefined, 'age_review_denied')).resolves.toEqual({ success: true, projectionPubkey: PUBKEY_A });
    await expect(clearSubject(DB, PUBKEY_A, undefined, 'age_review_denied')).resolves.toEqual({ success: true, projectionPubkey: PUBKEY_A });
    expect(await resolveByPubkey(DB, PUBKEY_A)).toBeNull();
    const binding = await DB.prepare('SELECT subject_id, unbound_at FROM protected_minor_account_bindings').first();
    expect(binding?.subject_id).toBe(subjectId);
    expect(binding?.unbound_at).not.toBeNull();
    const job = await DB.prepare('SELECT state FROM protected_minor_projection_jobs').first<{ state: string }>();
    expect(job?.state).toBe('pending');
  });

  it('closes idempotently and rejects conflicting or stale deliveries', async () => {
    const { subjectId } = await createSubjectWithBinding(DB, 'case-a', PUBKEY_A);
    expect(await closeBinding(DB, subjectId, PUBKEY_A, ATTEMPT_A)).toBe('closed');
    expect(await closeBinding(DB, subjectId, PUBKEY_A, ATTEMPT_A)).toBe('closed');
    expect(await closeBinding(DB, subjectId, PUBKEY_B, ATTEMPT_A)).toBe('idempotency_conflict');
    expect(await closeBinding(DB, subjectId, PUBKEY_A, '22222222-2222-4222-8222-222222222222')).toBe('stale_binding');
  });

  it('clears through binding history and targets the current replacement projection', async () => {
    const { subjectId } = await createSubjectWithBinding(DB, 'case-a', PUBKEY_A);
    await closeBinding(DB, subjectId, PUBKEY_A, ATTEMPT_A);
    await DB.prepare(`INSERT INTO protected_minor_account_bindings (id, subject_id, pubkey, bound_at)
      VALUES (?, ?, ?, ?)`).bind(crypto.randomUUID(), subjectId, PUBKEY_B, new Date().toISOString()).run();

    expect(await clearSubject(DB, PUBKEY_A, undefined, 'age_review_denied')).toEqual({
      success: true, projectionPubkey: PUBKEY_B,
    });
    expect(await resolveByPubkey(DB, PUBKEY_B)).toBeNull();
    const job = await DB.prepare('SELECT pubkey, state FROM protected_minor_projection_jobs').first();
    expect(job).toEqual({ pubkey: PUBKEY_B, state: 'pending' });
  });

  it('derives subject-clear retries from terminal denial rows', async () => {
    const { subjectId } = await createSubjectWithBinding(DB, 'case-a', PUBKEY_A);
    await DB.prepare(`INSERT INTO age_review_cases
      (id, pubkey, state, moderator_pubkey, resolution_note, created_at, updated_at)
      VALUES ('deny-a', ?, 'denied_closed', ?, 'Denied by moderator', ?, ?)`)
      .bind(PUBKEY_A, PUBKEY_B, '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z').run();
    // No clearedBy: the case's moderator_pubkey (PUBKEY_B here) is a legacy,
    // unverified column, so a retry carries no moderator (#178 phase 2).
    expect(await pendingSubjectClears(DB)).toEqual([{
      subjectId, pubkey: PUBKEY_A, reason: 'age_review_denied', denialCaseId: 'deny-a',
    }]);
    await clearSubject(DB, PUBKEY_A, PUBKEY_B, 'age_review_denied', subjectId);
    expect(await pendingSubjectClears(DB)).toEqual([]);
  });

  it('serves the frozen resolve and close response shapes without logging the subject reference', async () => {
    const { subjectId } = await createSubjectWithBinding(DB, 'case-a', PUBKEY_A);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const env = { DB, PROTECTED_MINOR_SERVICE_TOKEN: 'service-token' };
    const resolve = await handleProtectedMinorServiceRoute(new Request('https://api.test/api/internal/protected-minors/resolve', {
      method: 'POST', headers: { Authorization: 'Bearer service-token' }, body: JSON.stringify({ pubkey: PUBKEY_A }),
    }), '/api/internal/protected-minors/resolve', env, {});
    expect(resolve.status).toBe(200);
    expect(await resolve.json()).toEqual({ classification: 'active', subject_ref: subjectId, binding_state: 'active' });
    const close = await handleProtectedMinorServiceRoute(new Request('https://api.test/api/internal/protected-minors/bindings/close', {
      method: 'POST', headers: { Authorization: 'Bearer service-token' },
      body: JSON.stringify({ subject_ref: subjectId, pubkey: PUBKEY_A, deletion_attempt_id: ATTEMPT_A }),
    }), '/api/internal/protected-minors/bindings/close', env, {});
    expect(close.status).toBe(200);
    expect(await close.json()).toEqual({ outcome: 'closed' });
    expect(JSON.stringify([...log.mock.calls, ...error.mock.calls])).not.toContain(subjectId);
    log.mockRestore();
    error.mockRestore();
  });

  it('enforces at most one active binding per subject and pubkey', async () => {
    const { subjectId } = await createSubjectWithBinding(DB, 'case-a', PUBKEY_A);
    await expect(DB.prepare(`INSERT INTO protected_minor_account_bindings (id, subject_id, pubkey, bound_at)
      VALUES (?, ?, ?, ?)`).bind(crypto.randomUUID(), subjectId, PUBKEY_B, new Date().toISOString()).run()).rejects.toThrow();
    const second = await createSubjectWithBinding(DB, 'case-b', PUBKEY_B);
    await expect(DB.prepare(`UPDATE protected_minor_account_bindings SET pubkey = ? WHERE subject_id = ?`)
      .bind(PUBKEY_A, second.subjectId).run()).rejects.toThrow();
  });

  it('backfills onboarding provenance, later denial, duplicates, and is idempotent', async () => {
    await DB.prepare(`INSERT INTO age_review_cases (id, pubkey, state, created_via, created_at, updated_at)
      VALUES ('onboard-a', ?, 'cleared', 'minor_onboarding', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
             ('duplicate-a', ?, 'cleared', 'minor_onboarding', '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z'),
             ('deny-a', ?, 'denied_closed', 'report', '2026-01-03T00:00:00Z', '2026-01-04T00:00:00Z'),
             ('onboard-b', ?, 'cleared', 'minor_onboarding', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
             ('onboard-c', ?, 'cleared', 'minor_onboarding', '2026-01-05T00:00:00Z', '2026-01-05T00:00:00Z'),
             ('deny-c', ?, 'denied_closed', 'report', '2026-01-05T00:00:00Z', '2026-01-05T00:00:00Z')`)
      .bind(PUBKEY_A, PUBKEY_A, PUBKEY_A, PUBKEY_B, PUBKEY_C, PUBKEY_C).run();
    expect(await backfillProtectedMinorSubjects(DB)).toEqual({ created: 3, skippedDuplicates: 1 });
    expect(await backfillProtectedMinorSubjects(DB)).toEqual({ created: 0, skippedDuplicates: 1 });
    expect(await resolveByPubkey(DB, PUBKEY_A)).toBeNull();
    expect(await resolveByPubkey(DB, PUBKEY_B)).not.toBeNull();
    expect(await resolveByPubkey(DB, PUBKEY_C)).toBeNull();
    const copied = await DB.prepare(`SELECT parent_contact_email FROM age_review_cases WHERE id = 'onboard-a'`).first();
    expect(copied).toEqual({ parent_contact_email: null });
  });

  it('backfill does not copy a denial\'s legacy moderator_pubkey into cleared_by', async () => {
    // Before #178 phase 2 that column held whatever the request body claimed.
    await DB.prepare(`INSERT INTO age_review_cases (id, pubkey, state, created_via, moderator_pubkey, created_at, updated_at)
      VALUES ('onboard-a', ?, 'cleared', 'minor_onboarding', NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
             ('deny-a', ?, 'denied_closed', 'report', ?, '2026-01-03T00:00:00Z', '2026-01-04T00:00:00Z')`)
      .bind(PUBKEY_A, PUBKEY_A, 'd'.repeat(64)).run();
    expect(await backfillProtectedMinorSubjects(DB)).toEqual({ created: 1, skippedDuplicates: 0 });
    const subject = await DB.prepare(`SELECT classification_state, cleared_by FROM protected_minor_subjects
      WHERE source_case_id = 'onboard-a'`).first();
    expect(subject).toEqual({ classification_state: 'cleared', cleared_by: null });
  });

  it('replays replacement with the same operation and a clear wins stale retries', async () => {
    const { subjectId } = await createSubjectWithBinding(DB, 'case-a', PUBKEY_A);
    await closeBinding(DB, subjectId, PUBKEY_A, ATTEMPT_A);
    const replacementPubkey = 'c'.repeat(64);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ pubkey: replacementPubkey, claim_url: 'https://claim.test/one',
        expires_at: '2026-09-01T00:00:00Z', account_state: 'unclaimed', replayed: false }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ pubkey: replacementPubkey, claim_url: 'https://claim.test/one',
        expires_at: '2026-09-01T00:00:00Z', account_state: 'unclaimed', replayed: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const input = { subjectRef: subjectId, provisioningOperationId: '33333333-3333-4333-8333-333333333333', username: 'replacement' };
    const env = { DB, KEYCAST_URL: 'https://keycast.test', KEYCAST_SERVICE_TOKEN: 'token' };
    expect((await startOrResumeReplacement(env, input)).outcome).toBe('complete');
    expect((await startOrResumeReplacement(env, input)).outcome).toBe('complete');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await clearSubject(DB, replacementPubkey, undefined, 'age_review_denied');
    const stale = await startOrResumeReplacement(env, input);
    expect(stale).toEqual({ outcome: 'conflict', code: 'classification_cleared' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it('does not provision a replacement until the old binding is closed', async () => {
    const { subjectId } = await createSubjectWithBinding(DB, 'case-a', PUBKEY_A);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const result = await startOrResumeReplacement(
      { DB, KEYCAST_URL: 'https://keycast.test', KEYCAST_SERVICE_TOKEN: 'token' },
      { subjectRef: subjectId, provisioningOperationId: '55555555-5555-4555-8555-555555555555', username: 'replacement' },
    );
    expect(result).toEqual({ outcome: 'conflict', code: 'stale_binding' });
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('rejects compacted exact and conflicting replays without provisioning', async () => {
    const key = 'synthetic-retention-key';
    const operationId = '99999999-9999-4999-8999-999999999999';
    const fingerprint = await fingerprintProvisioningRequest({ kind: 'replacement', username: 'replacement' });
    const subjectRef = '11111111-1111-4111-8111-111111111111';
    await DB.prepare(`INSERT INTO protected_minor_provisioning_tombstones
      (provisioning_operation_id, kind, terminal_outcome, completed_at, request_digest, key_id)
      VALUES (?, 'replacement', 'complete', datetime('now'), ?, 'v1')`)
      .bind(operationId, await digestProvisioningFingerprint(key, fingerprint, subjectRef)).run();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const exact = await startOrResumeReplacement(
      { DB, KEYCAST_URL: 'https://keycast.test', KEYCAST_SERVICE_TOKEN: 'token', PROTECTED_MINOR_TOMBSTONE_KEY: key },
      { subjectRef, provisioningOperationId: operationId, username: 'replacement' },
    );
    expect(exact).toEqual({ outcome: 'compacted', code: 'provisioning_operation_compacted', replayed: true });
    const conflict = await startOrResumeReplacement(
      { DB, KEYCAST_URL: 'https://keycast.test', KEYCAST_SERVICE_TOKEN: 'token', PROTECTED_MINOR_TOMBSTONE_KEY: key },
      { subjectRef, provisioningOperationId: operationId, username: 'different' },
    );
    expect(conflict).toEqual({ outcome: 'conflict', code: 'provisioning_operation_conflict' });
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('rejects malformed replacement success and conflicting observed results', async () => {
    const { subjectId } = await createSubjectWithBinding(DB, 'case-a', PUBKEY_A);
    await closeBinding(DB, subjectId, PUBKEY_A, ATTEMPT_A);
    const operationId = '77777777-7777-4777-8777-777777777777';
    const env = { DB, KEYCAST_URL: 'https://keycast.test', KEYCAST_SERVICE_TOKEN: 'token' };

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ pubkey: PUBKEY_B }), { status: 201 })));
    expect(await startOrResumeReplacement(env, {
      subjectRef: subjectId, provisioningOperationId: operationId, username: 'replacement',
    })).toEqual({ outcome: 'failed', error: 'Provisioning failed' });

    const fingerprintHex = await fingerprintProvisioningRequest({ kind: 'replacement', username: 'replacement' });
    await DB.prepare(`UPDATE protected_minor_provisioning_operations SET result_pubkey = ?, request_fingerprint = ?
      WHERE provisioning_operation_id = ?`).bind(PUBKEY_C, fingerprintHex, operationId).run();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      pubkey: PUBKEY_B, claim_url: 'https://claim.test/replacement', expires_at: '2026-09-01T00:00:00Z',
      account_state: 'unclaimed', replayed: true,
    }), { status: 200 })));
    expect(await startOrResumeReplacement(env, {
      subjectRef: subjectId, provisioningOperationId: operationId, username: 'replacement',
    })).toEqual({ outcome: 'conflict', code: 'provisioning_result_conflict' });
    vi.unstubAllGlobals();
  });

  it('rejects changed onboarding provenance and cross-kind operation reuse', async () => {
    const operationId = '66666666-6666-4666-8666-666666666666';
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      pubkey: PUBKEY_A, claim_url: 'https://claim.test/onboard', expires_at: '2026-09-01T00:00:00Z',
      account_state: 'unclaimed', replayed: false,
    }), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    const request = (ticketId: number) => new Request('https://api.test/api/age-review/create-minor-account', {
      method: 'POST', body: JSON.stringify({
        username: 'new-minor', zendesk_ticket_id: ticketId, provisioning_operation_id: operationId,
      }),
    });
    const env = partialEnv<AgeReviewEnv>({ DB, KEYCAST_URL: 'https://keycast.test', KEYCAST_SERVICE_TOKEN: 'token' });
    expect((await handleCreateMinorAccount(request(101), env, {})).status).toBe(200);
    expect((await handleCreateMinorAccount(request(202), env, {})).status).toBe(409);

    const subject = await DB.prepare('SELECT subject_id FROM protected_minor_subjects').first<{ subject_id: string }>();
    expect(subject).not.toBeNull();
    await closeBinding(DB, subject!.subject_id, PUBKEY_A, ATTEMPT_A);
    const replacement = await startOrResumeReplacement(env, {
      subjectRef: subject!.subject_id, provisioningOperationId: operationId, username: 'new-minor',
    });
    expect(replacement).toEqual({ outcome: 'conflict', code: 'provisioning_operation_conflict' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('records onboarding case, subject, binding, and operation atomically and replays safely', async () => {
    const operationId = '44444444-4444-4444-8444-444444444444';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ pubkey: PUBKEY_A, claim_url: 'https://claim.test/onboard',
        expires_at: '2026-09-01T00:00:00Z', account_state: 'unclaimed', replayed: false }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ pubkey: PUBKEY_A, claim_url: 'https://claim.test/onboard',
        expires_at: '2026-09-01T00:00:00Z', account_state: 'unclaimed', replayed: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const makeRequest = () => new Request('https://api.test/api/age-review/create-minor-account', {
      method: 'POST', body: JSON.stringify({ username: 'new-minor', provisioning_operation_id: operationId }),
    });
    const env = partialEnv<AgeReviewEnv>({ DB, KEYCAST_URL: 'https://keycast.test', KEYCAST_SERVICE_TOKEN: 'token' });
    expect((await handleCreateMinorAccount(makeRequest(), env, {})).status).toBe(200);
    expect((await handleCreateMinorAccount(makeRequest(), env, {})).status).toBe(200);
    const counts = await DB.prepare(`SELECT
      (SELECT count(*) FROM age_review_cases) AS cases,
      (SELECT count(*) FROM protected_minor_subjects) AS subjects,
      (SELECT count(*) FROM protected_minor_account_bindings) AS bindings,
      (SELECT count(*) FROM protected_minor_provisioning_operations) AS operations`).first<{
        cases: number; subjects: number; bindings: number; operations: number;
      }>();
    expect(counts).toEqual({ cases: 1, subjects: 1, bindings: 1, operations: 1 });
    const onboardCase = await DB.prepare('SELECT clear_resolution FROM age_review_cases').first<{ clear_resolution: string | null }>();
    expect(onboardCase!.clear_resolution).toBe('approved_minor');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  // Issue #428. Support creates username X (operation A), then later opens the
  // dialog again and submits X under a fresh operation B. Keycast finds the
  // unclaimed account and answers 200 with the same pubkey and a claim link.
  // That pubkey already has an active binding, so recording a second case,
  // subject and binding would trip the one-active-binding-per-pubkey index and
  // strand support with no link, every retry failing the same way. The
  // handler reuses the existing record instead.
  describe('re-submitting an onboarded username under a new operation', () => {
    afterEach(() => { vi.unstubAllGlobals(); });

    const OP_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const OP_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const reply = (status: number, claimUrl: string, expiresAt: string, pubkey = PUBKEY_A) => new Response(JSON.stringify({
      pubkey, claim_url: claimUrl, expires_at: expiresAt,
      account_state: 'unclaimed', replayed: status === 200,
    }), { status });
    const submit = (operationId: string, ticketId?: number) => new Request('https://api.test/api/age-review/create-minor-account', {
      method: 'POST', body: JSON.stringify({
        username: 'new-minor', provisioning_operation_id: operationId,
        ...(ticketId !== undefined ? { zendesk_ticket_id: ticketId } : {}),
      }),
    });
    const env = (db: D1Database = DB) => partialEnv<AgeReviewEnv>({ DB: db, KEYCAST_URL: 'https://keycast.test', KEYCAST_SERVICE_TOKEN: 'token' });
    const rows = () => DB.prepare(`SELECT
      (SELECT count(*) FROM age_review_cases WHERE pubkey = ?) AS cases,
      (SELECT count(*) FROM protected_minor_subjects) AS subjects,
      (SELECT count(*) FROM protected_minor_account_bindings WHERE pubkey = ? AND unbound_at IS NULL) AS active_bindings`)
      .bind(PUBKEY_A, PUBKEY_A).first<{ cases: number; subjects: number; active_bindings: number }>();
    const caseRow = (id: string) => DB.prepare('SELECT claim_link_expires_at, zendesk_ticket_id FROM age_review_cases WHERE id = ?')
      .bind(id).first<{ claim_link_expires_at: string | null; zendesk_ticket_id: number | null }>();
    const operation = (id: string) => DB.prepare(`SELECT state, subject_id, result_pubkey
      FROM protected_minor_provisioning_operations WHERE provisioning_operation_id = ?`)
      .bind(id).first<{ state: string; subject_id: string | null; result_pubkey: string | null }>();

    /** Onboards X under operation A (keycast 201) and returns the case and subject it recorded. */
    async function onboardUnderA(ticketId?: number) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(reply(201, 'https://claim.test/a', '2026-09-01T00:00:00.000Z')));
      const res = await handleCreateMinorAccount(submit(OP_A, ticketId), env(), {});
      expect(res.status).toBe(200);
      const body = await res.json() as { case_id: string };
      const subject = await DB.prepare('SELECT subject_id FROM protected_minor_subjects WHERE source_case_id = ?')
        .bind(body.case_id).first<{ subject_id: string }>();
      return { caseId: body.case_id, subjectId: subject!.subject_id };
    }

    it('returns the new link against the existing case instead of failing on the binding', async () => {
      const { caseId, subjectId } = await onboardUnderA(101);
      vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(reply(200, 'https://claim.test/b', '2026-10-01T00:00:00.000Z')));

      const res = await handleCreateMinorAccount(submit(OP_B), env(), {});
      const body = await res.json() as Record<string, unknown>;

      expect(res.status).toBe(200);
      expect(body).toMatchObject({
        success: true, claim_url: 'https://claim.test/b', expires_at: '2026-10-01T00:00:00.000Z',
        account_state: 'unclaimed', case_id: caseId, provisioning_operation_id: OP_B,
      });
      expect(await rows()).toEqual({ cases: 1, subjects: 1, active_bindings: 1 });
      expect(await operation(OP_B)).toEqual({ state: 'complete', subject_id: subjectId, result_pubkey: PUBKEY_A });
      // The expiry now belongs to the link support was just handed.
      expect((await caseRow(caseId))!.claim_link_expires_at).toBe('2026-10-01T00:00:00.000Z');
    });

    it('keeps the case ticket when the resubmission names none', async () => {
      const { caseId } = await onboardUnderA(101);
      vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(reply(200, 'https://claim.test/b', '2026-10-01T00:00:00.000Z')));
      expect((await handleCreateMinorAccount(submit(OP_B), env(), {})).status).toBe(200);
      expect((await caseRow(caseId))!.zendesk_ticket_id).toBe(101);
    });

    it('moves the case to the ticket the resubmission names', async () => {
      const { caseId } = await onboardUnderA(101);
      vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(reply(200, 'https://claim.test/b', '2026-10-01T00:00:00.000Z')));
      expect((await handleCreateMinorAccount(submit(OP_B, 202), env(), {})).status).toBe(200);
      expect((await caseRow(caseId))!.zendesk_ticket_id).toBe(202);
    });

    it('answers a replay of the resubmission with a link and no new rows', async () => {
      const { caseId } = await onboardUnderA();
      vi.stubGlobal('fetch', vi.fn()
        .mockResolvedValueOnce(reply(200, 'https://claim.test/b', '2026-10-01T00:00:00.000Z'))
        .mockResolvedValueOnce(reply(200, 'https://claim.test/b2', '2026-10-02T00:00:00.000Z')));
      expect((await handleCreateMinorAccount(submit(OP_B), env(), {})).status).toBe(200);

      const res = await handleCreateMinorAccount(submit(OP_B), env(), {});
      const body = await res.json() as Record<string, unknown>;

      expect(res.status).toBe(200);
      expect(body).toMatchObject({ success: true, claim_url: 'https://claim.test/b2', case_id: caseId,
        replayed: true });
      expect(await rows()).toEqual({ cases: 1, subjects: 1, active_bindings: 1 });
      expect((await caseRow(caseId))!.claim_link_expires_at).toBe('2026-10-02T00:00:00.000Z');
    });

    // A pubkey can be bound by a report-created case too. That case is not
    // this dialog's to edit, so it is left as it was; support still gets the
    // link and the case that already protects the account.
    it('leaves a case this dialog did not create untouched', async () => {
      const reportCase = 'report-case-for-new-minor';
      await DB.prepare(`INSERT INTO age_review_cases (id, pubkey, state, deadline_at, clock_paused, version, claim_link_expires_at, zendesk_ticket_id)
        VALUES (?, ?, 'restricted_pending_user_response', '2020-01-01T00:00:00.000Z', 0, 0, NULL, 303)`).bind(reportCase, PUBKEY_A).run();
      const { subjectId } = await createSubjectWithBinding(DB, reportCase, PUBKEY_A);
      vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(reply(200, 'https://claim.test/b', '2026-10-01T00:00:00.000Z')));

      const res = await handleCreateMinorAccount(submit(OP_B, 202), env(), {});
      const body = await res.json() as Record<string, unknown>;

      expect(res.status).toBe(200);
      expect(body).toMatchObject({ success: true, claim_url: 'https://claim.test/b', case_id: reportCase });
      expect(await caseRow(reportCase)).toEqual({ claim_link_expires_at: null, zendesk_ticket_id: 303 });
      expect(await rows()).toEqual({ cases: 1, subjects: 1, active_bindings: 1 });
      expect(await operation(OP_B)).toEqual({ state: 'complete', subject_id: subjectId, result_pubkey: PUBKEY_A });
    });

    // Two attempts of the same operation: the other one completed it between
    // this attempt's reads and its write. This attempt must not touch the case
    // (the winner already did), and its retry answers from the completed
    // operation with a link.
    it('leaves the case to the attempt that completed the operation first', async () => {
      const { caseId, subjectId } = await onboardUnderA(101);
      const otherAttempt = () => DB.prepare(`UPDATE protected_minor_provisioning_operations
        SET subject_id = ?, state = 'complete', result_pubkey = ?, updated_at = ? WHERE provisioning_operation_id = ?`)
        .bind(subjectId, PUBKEY_A, new Date().toISOString(), OP_B).run();
      vi.stubGlobal('fetch', vi.fn()
        .mockResolvedValueOnce(reply(200, 'https://claim.test/b', '2026-10-01T00:00:00.000Z'))
        .mockResolvedValueOnce(reply(200, 'https://claim.test/b2', '2026-10-02T00:00:00.000Z')));

      const res = await handleCreateMinorAccount(submit(OP_B, 202), env(dbWithWriterBefore(otherAttempt)), {});

      // Prove the other attempt really landed rather than threw into the
      // handler's catch, which answers with the same 500.
      expect(await operation(OP_B)).toEqual({ state: 'complete', subject_id: subjectId, result_pubkey: PUBKEY_A });
      expect(res.status).toBe(500);
      expect((await res.json() as Record<string, unknown>).provisioning_operation_id).toBe(OP_B);
      expect(await caseRow(caseId)).toEqual({ claim_link_expires_at: '2026-09-01T00:00:00.000Z', zendesk_ticket_id: 101 });

      const retry = await handleCreateMinorAccount(submit(OP_B, 202), env(), {});
      expect(retry.status).toBe(200);
      expect(await retry.json()).toMatchObject({ success: true, replayed: true, claim_url: 'https://claim.test/b2', case_id: caseId });
    });

    // The subject stopped protecting this pubkey between this attempt's reads
    // and its write. Completing the operation then would record it against a
    // subject that no longer protects this account. Nothing is written, and
    // the operation stays pending for a retry.
    it.each([
      // clearSubject closes the binding with the classification, so only the
      // binding half has a real path of its own (account deletion). The
      // classification half is forced directly to show it is checked too.
      ['its binding was closed', (subjectId: string) => closeBinding(DB, subjectId, PUBKEY_A, ATTEMPT_A)],
      // A replacement account took the subject over: it still protects
      // someone, just not this pubkey.
      ['its subject was rebound to another account', async (subjectId: string) => {
        await closeBinding(DB, subjectId, PUBKEY_A, ATTEMPT_A);
        await DB.prepare(`INSERT INTO protected_minor_account_bindings (id, subject_id, pubkey, bound_at) VALUES (?, ?, ?, ?)`)
          .bind(crypto.randomUUID(), subjectId, PUBKEY_C, new Date().toISOString()).run();
      }],
      ['its subject was cleared', (subjectId: string) => DB.prepare(
        `UPDATE protected_minor_subjects SET classification_state = 'cleared', cleared_at = ?,
          clear_reason = 'age_review_denied', clear_reason_class = 'valid_prior' WHERE subject_id = ?`)
        .bind(new Date().toISOString(), subjectId).run()],
    ])('completes nothing when %s before the write', async (_label, stopProtecting) => {
      const { caseId, subjectId } = await onboardUnderA(101);
      vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(reply(200, 'https://claim.test/b', '2026-10-01T00:00:00.000Z')));

      const res = await handleCreateMinorAccount(submit(OP_B, 202), env(dbWithWriterBefore(() => stopProtecting(subjectId))), {});

      // The handler swallows a failed batch into this same 500, so first prove
      // the other writer really landed rather than threw.
      expect(await resolveByPubkey(DB, PUBKEY_A)).toBeNull();
      expect(res.status).toBe(500);
      expect((await res.json() as Record<string, unknown>).success).toBe(false);
      expect(await operation(OP_B)).toMatchObject({ state: 'pending', subject_id: null });
      expect(await caseRow(caseId)).toEqual({ claim_link_expires_at: '2026-09-01T00:00:00.000Z', zendesk_ticket_id: 101 });
    });

    // A replacement (startOrResumeReplacement) binds a new pubkey to the same
    // subject, whose source case still describes the old account. That case
    // is not the new account's to rewrite.
    it("leaves the old account's case alone when the subject now carries another pubkey", async () => {
      const { caseId, subjectId } = await onboardUnderA(101);
      await closeBinding(DB, subjectId, PUBKEY_A, ATTEMPT_A);
      await DB.prepare(`INSERT INTO protected_minor_account_bindings (id, subject_id, pubkey, bound_at) VALUES (?, ?, ?, ?)`)
        .bind(crypto.randomUUID(), subjectId, PUBKEY_B, new Date().toISOString()).run();
      vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(reply(200, 'https://claim.test/b', '2026-10-01T00:00:00.000Z', PUBKEY_B)));

      const res = await handleCreateMinorAccount(submit(OP_B, 202), env(), {});

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ success: true, claim_url: 'https://claim.test/b', case_id: caseId });
      expect(await caseRow(caseId)).toEqual({ claim_link_expires_at: '2026-09-01T00:00:00.000Z', zendesk_ticket_id: 101 });
      expect(await operation(OP_B)).toEqual({ state: 'complete', subject_id: subjectId, result_pubkey: PUBKEY_B });
    });

    // Retention redacts a closed onboarding case after its detail period. A
    // refresh must not write detail back into it.
    it('leaves a redacted case redacted', async () => {
      const { caseId } = await onboardUnderA(101);
      await DB.prepare(`UPDATE age_review_cases SET claim_link_expires_at = NULL, redacted_at = ? WHERE id = ?`)
        .bind(new Date().toISOString(), caseId).run();
      vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(reply(200, 'https://claim.test/b', '2026-10-01T00:00:00.000Z')));

      const res = await handleCreateMinorAccount(submit(OP_B, 202), env(), {});

      expect(res.status).toBe(200);
      expect(await caseRow(caseId)).toEqual({ claim_link_expires_at: null, zendesk_ticket_id: 101 });
    });

    // Keycast 409s a new operation for a claimed username, so this should not
    // happen. If it does, there is no new link, so nothing about the case moves.
    it('leaves the case alone when keycast returns no link', async () => {
      const { caseId } = await onboardUnderA(101);
      vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
        pubkey: PUBKEY_A, claim_url: null, expires_at: null, account_state: 'claimed', replayed: true,
      }), { status: 200 })));

      const res = await handleCreateMinorAccount(submit(OP_B, 202), env(), {});

      expect(res.status).toBe(200);
      expect(await caseRow(caseId)).toEqual({ claim_link_expires_at: '2026-09-01T00:00:00.000Z', zendesk_ticket_id: 101 });
    });
  });

  // Issue #428. A replay of a completed operation asks Keycast for the claim
  // link again, and the case's stored expiry must follow the link support was
  // just handed, whether Keycast returned the existing one or a replacement.
  describe('replaying a completed operation', () => {
    afterEach(async () => {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
      await DB.prepare('DROP TRIGGER IF EXISTS test_fail_case_expiry_write').run();
    });

    const OP_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const OP_B = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const reply = (status: number, claimUrl: string, expiresAt: string) => new Response(JSON.stringify({
      pubkey: PUBKEY_A, claim_url: claimUrl, expires_at: expiresAt,
      account_state: 'unclaimed', replayed: status === 200,
    }), { status });
    const claimedReply = () => new Response(JSON.stringify({
      pubkey: PUBKEY_A, claim_url: null, expires_at: null, account_state: 'claimed', replayed: true,
    }), { status: 200 });
    const submit = (operationId: string) => new Request('https://api.test/api/age-review/create-minor-account', {
      method: 'POST', body: JSON.stringify({ username: 'new-minor', provisioning_operation_id: operationId }),
    });
    const env = () => partialEnv<AgeReviewEnv>({ DB, KEYCAST_URL: 'https://keycast.test', KEYCAST_SERVICE_TOKEN: 'token' });
    const expiryOf = async (id: string) => (await DB.prepare('SELECT claim_link_expires_at FROM age_review_cases WHERE id = ?')
      .bind(id).first<{ claim_link_expires_at: string | null }>())!.claim_link_expires_at;

    async function onboardUnderA(): Promise<string> {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(reply(201, 'https://claim.test/a', '2026-09-01T00:00:00.000Z')));
      const res = await handleCreateMinorAccount(submit(OP_A), env(), {});
      expect(res.status).toBe(200);
      return (await res.json() as { case_id: string }).case_id;
    }

    it('moves the onboarding case expiry to the replayed link', async () => {
      const caseId = await onboardUnderA();
      vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(reply(200, 'https://claim.test/a2', '2026-10-01T00:00:00.000Z')));

      const res = await handleCreateMinorAccount(submit(OP_A), env(), {});
      const body = await res.json() as Record<string, unknown>;

      expect(res.status).toBe(200);
      expect(body).toMatchObject({ replayed: true, claim_url: 'https://claim.test/a2', case_id: caseId });
      expect(await expiryOf(caseId)).toBe('2026-10-01T00:00:00.000Z');
    });

    it('leaves the expiry alone when the replay brings no link (claimed account)', async () => {
      const caseId = await onboardUnderA();
      vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(claimedReply()));

      const res = await handleCreateMinorAccount(submit(OP_A), env(), {});

      expect(res.status).toBe(200);
      expect((await res.json() as Record<string, unknown>).account_state).toBe('claimed');
      expect(await expiryOf(caseId)).toBe('2026-09-01T00:00:00.000Z');
    });

    // Operation B completed against a report-created case's subject (the
    // reuse branch). That case is not this dialog's to edit, on replay either.
    it('leaves a case this dialog did not create untouched on replay', async () => {
      const reportCase = 'report-case-for-replay';
      await DB.prepare(`INSERT INTO age_review_cases (id, pubkey, state, deadline_at, clock_paused, version, claim_link_expires_at)
        VALUES (?, ?, 'restricted_pending_user_response', '2020-01-01T00:00:00.000Z', 0, 0, NULL)`).bind(reportCase, PUBKEY_A).run();
      await createSubjectWithBinding(DB, reportCase, PUBKEY_A);
      vi.stubGlobal('fetch', vi.fn()
        .mockResolvedValueOnce(reply(200, 'https://claim.test/b', '2026-10-01T00:00:00.000Z'))
        .mockResolvedValueOnce(reply(200, 'https://claim.test/b2', '2026-10-02T00:00:00.000Z')));
      expect((await handleCreateMinorAccount(submit(OP_B), env(), {})).status).toBe(200);

      const res = await handleCreateMinorAccount(submit(OP_B), env(), {});

      expect(res.status).toBe(200);
      expect((await res.json() as Record<string, unknown>).replayed).toBe(true);
      expect(await expiryOf(reportCase)).toBeNull();
    });

    it('leaves a redacted case redacted on replay', async () => {
      const caseId = await onboardUnderA();
      await DB.prepare(`UPDATE age_review_cases SET claim_link_expires_at = NULL, redacted_at = ? WHERE id = ?`)
        .bind(new Date().toISOString(), caseId).run();
      vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(reply(200, 'https://claim.test/a2', '2026-10-01T00:00:00.000Z')));

      const res = await handleCreateMinorAccount(submit(OP_A), env(), {});

      expect(res.status).toBe(200);
      expect(await expiryOf(caseId)).toBeNull();
    });

    // Operation B completed for a replacement pubkey bound to the subject
    // whose source case is the old account's. Replaying B must not rewrite it.
    it("leaves the old account's case alone on replay when the subject now carries another pubkey", async () => {
      const caseId = await onboardUnderA();
      const subject = await DB.prepare('SELECT subject_id FROM protected_minor_subjects WHERE source_case_id = ?')
        .bind(caseId).first<{ subject_id: string }>();
      await closeBinding(DB, subject!.subject_id, PUBKEY_A, ATTEMPT_A);
      await DB.prepare(`INSERT INTO protected_minor_account_bindings (id, subject_id, pubkey, bound_at) VALUES (?, ?, ?, ?)`)
        .bind(crypto.randomUUID(), subject!.subject_id, PUBKEY_B, new Date().toISOString()).run();
      const replyFor = (claimUrl: string, expiresAt: string) => new Response(JSON.stringify({
        pubkey: PUBKEY_B, claim_url: claimUrl, expires_at: expiresAt, account_state: 'unclaimed', replayed: true,
      }), { status: 200 });
      vi.stubGlobal('fetch', vi.fn()
        .mockResolvedValueOnce(replyFor('https://claim.test/b', '2026-10-01T00:00:00.000Z'))
        .mockResolvedValueOnce(replyFor('https://claim.test/b2', '2026-10-02T00:00:00.000Z')));
      expect((await handleCreateMinorAccount(submit(OP_B), env(), {})).status).toBe(200);

      const res = await handleCreateMinorAccount(submit(OP_B), env(), {});

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ replayed: true, claim_url: 'https://claim.test/b2', case_id: caseId });
      expect(await expiryOf(caseId)).toBe('2026-09-01T00:00:00.000Z');
    });

    // The expiry is bookkeeping; the link is what support needs. A refresh
    // that fails (simulated with a trigger) must not cost them the link.
    it('still returns the link when the expiry refresh fails', async () => {
      const caseId = await onboardUnderA();
      await DB.prepare(`CREATE TRIGGER test_fail_case_expiry_write
        BEFORE UPDATE OF claim_link_expires_at ON age_review_cases
        BEGIN SELECT RAISE(ABORT, 'simulated expiry write failure'); END`).run();
      vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(reply(200, 'https://claim.test/a2', '2026-10-01T00:00:00.000Z')));
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const res = await handleCreateMinorAccount(submit(OP_A), env(), {});
      const body = await res.json() as Record<string, unknown>;

      expect(res.status).toBe(200);
      expect(body).toMatchObject({ success: true, replayed: true, claim_url: 'https://claim.test/a2', case_id: caseId });
      expect(await expiryOf(caseId)).toBe('2026-09-01T00:00:00.000Z');
      expect(errorSpy).toHaveBeenCalled();
    });
  });
});

describe('convergeProjection after a set (#192)', () => {
  const P = 'f1'.repeat(32);
  const OTHER = 'f2'.repeat(32);
  const old = '2026-01-01T00:00:00.000Z';
  const jobOf = (subjectId: string) => DB.prepare(
    'SELECT pubkey, reason, state, created_at FROM protected_minor_projection_jobs WHERE subject_id = ?',
  ).bind(subjectId).first<{ pubkey: string; reason: string; state: string; created_at: string }>();
  async function completeJob(subjectId: string, pubkey: string, reason: string) {
    await DB.prepare(`UPDATE protected_minor_projection_jobs SET pubkey = ?, reason = ?, state = 'complete',
      created_at = ?, updated_at = ? WHERE subject_id = ?`).bind(pubkey, reason, old, old, subjectId).run();
  }

  it('re-arms the most recent cleared subject with its clear reason and a fresh age', async () => {
    const { subjectId: s1 } = await createSubjectWithBinding(DB, 'c1', P, '2026-02-01T00:00:00.000Z');
    await clearSubject(DB, P, undefined, 'age_review_denied', s1);
    await completeJob(s1, P, 'age_review_denied');
    const { subjectId: s2 } = await createSubjectWithBinding(DB, 'c2', P, '2026-03-01T00:00:00.000Z');
    await clearSubject(DB, P, undefined, 'age_review_expired', s2);
    await completeJob(s2, P, 'age_review_expired');

    await convergeProjection(DB, P, 'active');

    const rearmed = await jobOf(s2);
    expect(rearmed).toMatchObject({ pubkey: P, reason: 'age_review_expired', state: 'pending' });
    expect(rearmed!.created_at).not.toBe(old);
    expect((await jobOf(s1))!.state).toBe('complete');
  });

  it('keeps the age of a clear job that is already pending', async () => {
    const { subjectId } = await createSubjectWithBinding(DB, 'c1', P);
    await clearSubject(DB, P, undefined, 'age_review_denied', subjectId);
    await DB.prepare('UPDATE protected_minor_projection_jobs SET created_at = ? WHERE subject_id = ?')
      .bind(old, subjectId).run();

    await convergeProjection(DB, P, 'active');

    expect(await jobOf(subjectId)).toMatchObject({ state: 'pending', created_at: old });
  });

  it('leaves alone a clear still pending for the subject\'s other pubkey', async () => {
    const { subjectId } = await createSubjectWithBinding(DB, 'c1', P);
    await DB.prepare('UPDATE protected_minor_account_bindings SET unbound_at = ? WHERE pubkey = ?').bind(old, P).run();
    await DB.prepare(`INSERT INTO protected_minor_account_bindings (id, subject_id, pubkey, bound_at)
      VALUES ('replacement', ?, ?, ?)`).bind(subjectId, OTHER, '2026-02-01T00:00:00.000Z').run();
    await clearSubject(DB, OTHER, undefined, 'age_review_denied', subjectId); // job pending for OTHER

    await convergeProjection(DB, P, 'active');

    expect(await jobOf(subjectId)).toMatchObject({ pubkey: OTHER, state: 'pending' });
  });

  it('does nothing while the pubkey has a live active subject', async () => {
    const { subjectId: s1 } = await createSubjectWithBinding(DB, 'c1', P, '2026-02-01T00:00:00.000Z');
    await clearSubject(DB, P, undefined, 'age_review_denied', s1);
    await completeJob(s1, P, 'age_review_denied');
    await createSubjectWithBinding(DB, 'c2', P, '2020-01-01T00:00:00.000Z'); // live, though bound "earlier"

    await convergeProjection(DB, P, 'active');

    expect((await jobOf(s1))!.state).toBe('complete');
  });
});
