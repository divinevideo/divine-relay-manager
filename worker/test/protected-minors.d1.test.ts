import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureSchema } from '../src/db';
import { handleCreateMinorAccount } from '../src/age-review';
import { backfillProtectedMinorSubjects, clearSubject, closeBinding, createSubjectWithBinding, fingerprintProvisioningRequest, handleProtectedMinorServiceRoute, pendingSubjectClears, resolveByPubkey, startOrResumeReplacement } from '../src/protected-minors';

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
  await DB.prepare('DELETE FROM protected_minor_projection_jobs').run();
  await DB.prepare('DELETE FROM protected_minor_provisioning_operations').run();
  await DB.prepare('DELETE FROM protected_minor_account_bindings').run();
  await DB.prepare('DELETE FROM protected_minor_subjects').run();
  await DB.prepare('DELETE FROM age_review_cases').run();
});

describe('protected-minor registry on real D1', () => {
  it('ensureSchema creates all registry tables and remains idempotent', async () => {
    await expect(ensureSchema(DB)).resolves.not.toThrow();
    const rows = await DB.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'protected_minor_%' ORDER BY name`).all<{ name: string }>();
    expect(rows.results.map((row) => row.name)).toEqual([
      'protected_minor_account_bindings', 'protected_minor_projection_jobs',
      'protected_minor_provisioning_operations', 'protected_minor_subjects',
    ]);
  });

  it('resolves active subjects and clear wins without deleting binding history', async () => {
    const { subjectId } = await createSubjectWithBinding(DB, 'case-a', PUBKEY_A);
    expect(await resolveByPubkey(DB, PUBKEY_A)).toEqual({ subjectRef: subjectId });
    await expect(clearSubject(DB, PUBKEY_A, undefined, 'age_review_denied')).resolves.toEqual({ success: true, projectionPubkey: PUBKEY_A });
    await expect(clearSubject(DB, PUBKEY_A, undefined, 'age_review_denied')).resolves.toEqual({ success: true, projectionPubkey: PUBKEY_A });
    expect(await resolveByPubkey(DB, PUBKEY_A)).toBeNull();
    const binding = await DB.prepare('SELECT subject_id, unbound_at FROM protected_minor_account_bindings').first();
    expect(binding).toEqual({ subject_id: subjectId, unbound_at: null });
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
    expect(await pendingSubjectClears(DB)).toEqual([{
      subjectId, pubkey: PUBKEY_A, clearedBy: PUBKEY_B, reason: 'age_review_denied',
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
    const env = { DB, KEYCAST_URL: 'https://keycast.test', KEYCAST_SERVICE_TOKEN: 'token' };
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
    const env = { DB, KEYCAST_URL: 'https://keycast.test', KEYCAST_SERVICE_TOKEN: 'token' };
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
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });
});
