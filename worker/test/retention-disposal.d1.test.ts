import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureSchema } from '../src/db';
import { clearSubject, createSubjectWithBinding, fingerprintProvisioningRequest } from '../src/protected-minors';
import { digestProvisioningFingerprint, runRetentionDisposal } from '../src/retention';

const PUBKEY_A = 'a'.repeat(64);
const PUBKEY_B = 'b'.repeat(64);
const OLD_30 = '2020-01-01T00:00:00Z';
const RECENT = new Date().toISOString();
const KEY = 'synthetic-retention-key-for-tests';
let mf: Miniflare;
let DB: D1Database;

// Wraps a real D1 binding so that any prepared statement whose SQL contains
// `faultOnSubstring` throws when executed, while every other statement and
// `batch` delegate to the real database. This injects a fault at one disposal
// stage without mocking the function under test: the assertions still read real
// D1 state.
function faultyDb(real: D1Database, faultOnSubstring: string): D1Database {
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === 'prepare') {
        return (sql: string) => {
          if (sql.includes(faultOnSubstring)) {
            const thrower = () => { throw new Error(`injected fault: ${faultOnSubstring}`); };
            return { bind() { return this; }, run: thrower, first: thrower, all: thrower } as unknown as D1PreparedStatement;
          }
          return target.prepare(sql);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

beforeAll(async () => {
  mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok"); } };',
    compatibilityDate: '2024-12-01', compatibilityFlags: ['nodejs_compat'], d1Databases: ['DB'] });
  DB = (await mf.getD1Database('DB')) as unknown as D1Database;
  await ensureSchema(DB);
});

afterAll(async () => mf.dispose());

beforeEach(async () => {
  vi.restoreAllMocks();
  await DB.prepare('DELETE FROM retention_alert_state').run();
  await DB.prepare('DELETE FROM retention_legal_holds').run();
  await DB.prepare('DELETE FROM protected_minor_projection_jobs').run();
  await DB.prepare('DELETE FROM protected_minor_provisioning_operations').run();
  await DB.prepare('DELETE FROM protected_minor_provisioning_tombstones').run();
  await DB.prepare('DELETE FROM protected_minor_account_bindings').run();
  await DB.prepare('DELETE FROM protected_minor_subjects').run();
  await DB.prepare('DELETE FROM age_review_cases').run();
});

describe('protected-record retention on real D1', () => {
  it('enforces false-positive classification at the schema boundary', async () => {
    await expect(DB.prepare(`INSERT INTO protected_minor_subjects
      (subject_id, classification_state, classified_at, cleared_at, clear_reason, clear_reason_class)
      VALUES ('bad', 'cleared', ?, ?, 'false_positive', 'unclassified')`)
      .bind(OLD_30, OLD_30).run()).rejects.toThrow(/clear reason classification mismatch/);

    const { subjectId } = await createSubjectWithBinding(DB, 'case-a', PUBKEY_A, OLD_30);
    await clearSubject(DB, PUBKEY_A, undefined, 'false_positive');
    const subject = await DB.prepare(`SELECT clear_reason_class FROM protected_minor_subjects WHERE subject_id = ?`)
      .bind(subjectId).first();
    expect(subject).toEqual({ clear_reason_class: 'false_positive' });
  });

  it('redacts closed case detail at 30 days and deletes the minimized case at one year', async () => {
    await DB.prepare(`INSERT INTO age_review_cases
      (id, pubkey, reporter_pubkey, state, parent_contact_email, resolution_note, claim_link_url,
       account_name, account_nip05, account_vine_username, identity_captured_at, closed_at)
      VALUES ('case-redact', ?, ?, 'cleared', 'parent@example.test', 'private narrative', 'https://claim.test/token',
        'Synthetic Name', 'synthetic@example.test', 'synthetic-user', ?, datetime('now', '-31 days')),
       ('case-delete', ?, NULL, 'cleared', NULL, NULL, NULL, NULL, NULL, NULL, NULL, datetime('now', '-366 days'))`)
      .bind(PUBKEY_A, PUBKEY_B, RECENT, PUBKEY_B).run();

    const result = await runRetentionDisposal({ DB, PROTECTED_MINOR_TOMBSTONE_KEY: KEY });
    // An already-finally-expired row is minimized before deletion in the same
    // idempotent run, so a deletion hold introduced between stages cannot leave
    // its detailed fields behind.
    expect(result.casesRedacted).toBe(2);
    expect(result.casesDeleted).toBe(1);
    const redacted = await DB.prepare(`SELECT parent_contact_email, resolution_note, claim_link_url,
      account_name, account_nip05, account_vine_username, identity_captured_at, reporter_pubkey, redacted_at
      FROM age_review_cases WHERE id = 'case-redact'`).first<Record<string, unknown>>();
    expect(redacted).toMatchObject({ parent_contact_email: null, resolution_note: null, claim_link_url: null,
      account_name: null, account_nip05: null, account_vine_username: null, identity_captured_at: null,
      reporter_pubkey: null });
    expect(redacted?.redacted_at).not.toBeNull();
  });

  it('compacts terminal operations before dependency-safe subject disposal', async () => {
    const { subjectId } = await createSubjectWithBinding(DB, 'case-a', PUBKEY_A, OLD_30);
    await clearSubject(DB, PUBKEY_A, undefined, 'false_positive');
    await DB.prepare(`UPDATE protected_minor_subjects SET cleared_at = ? WHERE subject_id = ?`).bind(OLD_30, subjectId).run();
    await DB.prepare(`UPDATE protected_minor_account_bindings SET unbound_at = ? WHERE subject_id = ?`).bind(OLD_30, subjectId).run();
    await DB.prepare(`UPDATE protected_minor_projection_jobs SET state = 'complete', updated_at = ? WHERE subject_id = ?`)
      .bind(OLD_30, subjectId).run();
    const fingerprint = await fingerprintProvisioningRequest({ kind: 'replacement', username: 'synthetic-user' });
    await DB.prepare(`INSERT INTO protected_minor_provisioning_operations
      (provisioning_operation_id, subject_id, kind, request_fingerprint, state, result_pubkey, created_at, updated_at)
      VALUES ('op-a', ?, 'replacement', ?, 'complete', ?, ?, ?)`)
      .bind(subjectId, fingerprint, PUBKEY_B, OLD_30, OLD_30).run();

    const result = await runRetentionDisposal({ DB, PROTECTED_MINOR_TOMBSTONE_KEY: KEY });
    expect(result).toMatchObject({ projectionsDeleted: 1, operationsCompacted: 1, bindingsDeleted: 1, subjectsDeleted: 1 });
    expect(await DB.prepare(`SELECT subject_id FROM protected_minor_subjects WHERE subject_id = ?`).bind(subjectId).first()).toBeNull();
    const tombstone = await DB.prepare(`SELECT request_digest, result_digest, terminal_outcome
      FROM protected_minor_provisioning_tombstones WHERE provisioning_operation_id = 'op-a'`).first<{
        request_digest: string; result_digest: string; terminal_outcome: string;
      }>();
    expect(tombstone?.request_digest).toBe(await digestProvisioningFingerprint(KEY, fingerprint, subjectId));
    expect(tombstone?.result_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(tombstone?.terminal_outcome).toBe('complete');
    const retry = await runRetentionDisposal({ DB, PROTECTED_MINOR_TOMBSTONE_KEY: KEY });
    expect(retry).toMatchObject({ operationsCompacted: 0, bindingsDeleted: 0, subjectsDeleted: 0 });
  });

  it('retains eligible operation detail when tombstone key material is unavailable', async () => {
    await DB.prepare(`INSERT INTO protected_minor_provisioning_operations
      (provisioning_operation_id, kind, request_fingerprint, state, created_at, updated_at)
      VALUES ('op-no-key', 'onboarding', 'synthetic', 'failed', ?, ?)`)
      .bind(OLD_30, OLD_30).run();
    const result = await runRetentionDisposal({ DB });
    expect(result.operationsCompacted).toBe(0);
    expect(await DB.prepare(`SELECT 1 FROM protected_minor_provisioning_operations
      WHERE provisioning_operation_id = 'op-no-key'`).first()).not.toBeNull();
    expect(await DB.prepare(`SELECT 1 FROM protected_minor_provisioning_tombstones
      WHERE provisioning_operation_id = 'op-no-key'`).first()).toBeNull();
  });

  it('honors the false-positive boundary immediately before and after 30 days', async () => {
    const before = await createSubjectWithBinding(DB, 'case-before', PUBKEY_A, OLD_30);
    const after = await createSubjectWithBinding(DB, 'case-after', PUBKEY_B, OLD_30);
    await clearSubject(DB, PUBKEY_A, undefined, 'false_positive');
    await clearSubject(DB, PUBKEY_B, undefined, 'false_positive');
    for (const [subjectId, days, seconds] of [[before.subjectId, '-30 days', '+1 second'], [after.subjectId, '-30 days', '-1 second']] as const) {
      await DB.prepare(`UPDATE protected_minor_subjects SET cleared_at = datetime('now', ?, ?) WHERE subject_id = ?`)
        .bind(days, seconds, subjectId).run();
      await DB.prepare(`UPDATE protected_minor_account_bindings SET unbound_at = datetime('now', ?, ?) WHERE subject_id = ?`)
        .bind(days, seconds, subjectId).run();
      await DB.prepare(`UPDATE protected_minor_projection_jobs SET state = 'complete', updated_at = datetime('now', ?, ?) WHERE subject_id = ?`)
        .bind(days, seconds, subjectId).run();
    }

    await runRetentionDisposal({ DB, PROTECTED_MINOR_TOMBSTONE_KEY: KEY });
    expect(await DB.prepare('SELECT 1 FROM protected_minor_subjects WHERE subject_id = ?').bind(before.subjectId).first()).not.toBeNull();
    expect(await DB.prepare('SELECT 1 FROM protected_minor_subjects WHERE subject_id = ?').bind(after.subjectId).first()).toBeNull();
  });

  it('keeps active and held records and resumes the original clock after release', async () => {
    const active = await createSubjectWithBinding(DB, 'active-case', PUBKEY_A, OLD_30);
    const held = await createSubjectWithBinding(DB, 'held-case', PUBKEY_B, OLD_30);
    await clearSubject(DB, PUBKEY_B, undefined, 'false_positive');
    await DB.prepare(`UPDATE protected_minor_subjects SET cleared_at = ? WHERE subject_id = ?`).bind(OLD_30, held.subjectId).run();
    await DB.prepare(`UPDATE protected_minor_account_bindings SET unbound_at = ? WHERE subject_id = ?`).bind(OLD_30, held.subjectId).run();
    await DB.prepare(`UPDATE protected_minor_projection_jobs SET state = 'complete', updated_at = ? WHERE subject_id = ?`)
      .bind(OLD_30, held.subjectId).run();
    await DB.prepare(`INSERT INTO retention_legal_holds
      (id, record_type, record_key, disposal_stage, authorized_role, starts_at, review_at)
      VALUES ('hold-a', 'protected_subject', ?, 'deletion', 'privacy/legal', ?, ?),
             ('hold-b', 'account_binding', NULL, 'deletion', 'privacy/legal', ?, ?)`)
      .bind(held.subjectId, OLD_30, RECENT, OLD_30, RECENT).run();

    await runRetentionDisposal({ DB, PROTECTED_MINOR_TOMBSTONE_KEY: KEY });
    expect(await DB.prepare('SELECT subject_id FROM protected_minor_subjects WHERE subject_id = ?').bind(active.subjectId).first()).not.toBeNull();
    expect(await DB.prepare('SELECT subject_id FROM protected_minor_subjects WHERE subject_id = ?').bind(held.subjectId).first()).not.toBeNull();

    await DB.prepare(`UPDATE retention_legal_holds SET released_at = datetime('now')`).run();
    const resumed = await runRetentionDisposal({ DB, PROTECTED_MINOR_TOMBSTONE_KEY: KEY });
    expect(resumed.bindingsDeleted).toBe(1);
    expect(resumed.subjectsDeleted).toBe(1);
  });

  it('alerts on unknown reasons and overdue pending work without exposing identifiers', async () => {
    await DB.prepare(`INSERT INTO protected_minor_subjects
      (subject_id, classification_state, classified_at, cleared_at, clear_reason, clear_reason_class)
      VALUES ('unknown-subject', 'cleared', ?, ?, 'legacy narrative', 'unclassified')`).bind(OLD_30, OLD_30).run();
    await DB.prepare(`INSERT INTO protected_minor_provisioning_operations
      (provisioning_operation_id, kind, request_fingerprint, state, created_at, updated_at)
      VALUES ('pending-op', 'onboarding', 'synthetic', 'pending', ?, ?)`)
      .bind(OLD_30, OLD_30).run();
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await runRetentionDisposal({ DB, PROTECTED_MINOR_TOMBSTONE_KEY: KEY, SLACK_WEBHOOK_URL: 'https://hooks.test' });
    expect(result).toMatchObject({ unknownReasonsAlerted: 1, pendingOperationsOverdue: 1 });
    const payload = JSON.stringify(fetchMock.mock.calls);
    expect(payload).not.toContain('unknown-subject');
    expect(payload).not.toContain('pending-op');
    vi.unstubAllGlobals();
  });

  it('isolates a failing disposal stage so later stages still dispose eligible records', async () => {
    const { subjectId } = await createSubjectWithBinding(DB, 'case-iso', PUBKEY_A, OLD_30);
    await clearSubject(DB, PUBKEY_A, undefined, 'false_positive');
    await DB.prepare(`UPDATE protected_minor_subjects SET cleared_at = ? WHERE subject_id = ?`).bind(OLD_30, subjectId).run();
    await DB.prepare(`UPDATE protected_minor_account_bindings SET unbound_at = ? WHERE subject_id = ?`).bind(OLD_30, subjectId).run();
    await DB.prepare(`UPDATE protected_minor_projection_jobs SET state = 'complete', updated_at = ? WHERE subject_id = ?`)
      .bind(OLD_30, subjectId).run();

    // Fault the case-redaction stage, which runs before binding/subject disposal.
    // The `parent_contact_email = NULL` clause appears only in that stage's UPDATE.
    const faulty = faultyDb(DB, 'parent_contact_email = NULL');
    await runRetentionDisposal({ DB: faulty, PROTECTED_MINOR_TOMBSTONE_KEY: KEY }).catch(() => undefined);

    // The subject and its binding are eligible and unheld; a failure in an
    // earlier stage must not leave them undisposed.
    expect(await DB.prepare('SELECT 1 FROM protected_minor_account_bindings WHERE subject_id = ?').bind(subjectId).first()).toBeNull();
    expect(await DB.prepare('SELECT 1 FROM protected_minor_subjects WHERE subject_id = ?').bind(subjectId).first()).toBeNull();
  });
});
