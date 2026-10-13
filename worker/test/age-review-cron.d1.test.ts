// Real-D1 (Miniflare SQLite) validation for the age-review cron fixes:
//   deadline comparison must use datetime(deadline_at), not a lexical
//         TEXT compare of an ISO-8601 (`...T...Z`) value against datetime('now').
//   the auto-close cron must only act on cases that were actually
//         RESTRICTED and are still awaiting a response.
// The existing vitest.config.ts runs on node with a MOCKED DB, so it never
// exercised SQLite and could not have caught the bug. This suite runs the
// real checkAgeReviewDeadlines against a real Miniflare-backed D1.
import { Miniflare } from 'miniflare';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { ensureSchema } from '../src/db';
import { checkAgeReviewDeadlines } from '../src/age-review';
import { clearSubject, createSubjectWithBinding, pendingSubjectClears, rearmLiveSubjectProjection } from '../src/protected-minors';

let mf: Miniflare;
let DB: D1Database;
let cronEnv: Parameters<typeof checkAgeReviewDeadlines>[0];

beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok"); } };',
    compatibilityDate: '2024-12-01',
    compatibilityFlags: ['nodejs_compat'],
    d1Databases: ['DB'],
  });
  DB = (await mf.getD1Database('DB')) as unknown as D1Database;
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
    .bind(id).first<{ state: string }>();
  return row?.state;
}

describe('age-review cron on real D1', () => {
  beforeEach(reset);
  afterEach(() => vi.restoreAllMocks());

  it('mechanism: lexical TEXT compare misfires where datetime() is correct', async () => {
    // 08:00 is clearly before 12:00 on the same day, but the ISO string sorts
    // AFTER the space-form because 'T'(0x54) > ' '(0x20).
    const r = await DB.prepare(
      `SELECT ('2026-06-22T08:00:00.000Z' < '2026-06-22 12:00:00')           AS lexical,
              (datetime('2026-06-22T08:00:00.000Z') < '2026-06-22 12:00:00') AS fixed`,
    ).first<{ lexical: number; fixed: number }>();
    expect(r!.lexical).toBe(0); // the bug: appears NOT-yet-expired
    expect(r!.fixed).toBe(1);   // the fix: correct temporal comparison
  });

  it('a restricted case that expired earlier TODAY (same UTC day) is auto-closed', async () => {
    const deadline = new Date(Date.now() - 60_000).toISOString(); // 1 min ago
    await insertCase('c8-today', 'restricted_pending_user_response', deadline);
    await checkAgeReviewDeadlines(cronEnv);
    expect(await stateOf('c8-today')).toBe('denied_closed');
  });

  it('a never-restricted (open_reported) expired case is NOT auto-closed/banned', async () => {
    await insertCase('c6-open', 'open_reported', '2020-01-01T00:00:00.000Z');
    await checkAgeReviewDeadlines(cronEnv);
    expect(await stateOf('c6-open')).toBe('open_reported');
  });

  it('a never-restricted (under_moderator_review) expired case is NOT auto-closed', async () => {
    await insertCase('c6-umr', 'under_moderator_review', '2020-01-01T00:00:00.000Z');
    await checkAgeReviewDeadlines(cronEnv);
    expect(await stateOf('c6-umr')).toBe('under_moderator_review');
  });

  it('an already-responded (submitted_for_review) expired case is NOT auto-closed', async () => {
    await insertCase('c6-sub', 'submitted_for_review', '2020-01-01T00:00:00.000Z');
    await checkAgeReviewDeadlines(cronEnv);
    expect(await stateOf('c6-sub')).toBe('submitted_for_review');
  });

  it('a restricted + pending expired case IS auto-closed', async () => {
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

  it('an expired non-restricted case is surfaced via the awaiting-moderator-action alert', async () => {
    // submitted_for_review is past deadline: the cron must NOT auto-close it (the
    // user responded; a moderator must decide) but must still alert so it does not
    // sit in the blind spot between the approaching window and the auto-close set.
    const bodies: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
      bodies.push(String(init?.body ?? ''));
      return Promise.resolve(new Response('ok', { status: 200 }));
    });
    await insertCase('na-sub', 'submitted_for_review', '2020-01-01T00:00:00.000Z');
    await checkAgeReviewDeadlines({ ...cronEnv, SLACK_WEBHOOK_URL: 'https://hooks.test/x' });

    expect(await stateOf('na-sub')).toBe('submitted_for_review'); // not auto-closed
    const alert = bodies.find((b) => b.includes('awaiting moderator action'));
    expect(alert).toBeTruthy();
    expect(alert).toContain('submitted_for_review');
    expect(alert).not.toContain('pk_na-sub');
    const row = await DB.prepare('SELECT last_alerted_at FROM age_review_cases WHERE id = ?')
      .bind('na-sub').first<{ last_alerted_at: string | null }>();
    expect(row!.last_alerted_at).not.toBeNull(); // 12h throttle stamp written
  });

  it('cron auto-close uses CAS and bumps the version', async () => {
    await insertCase('c7-cron', 'restricted_pending_user_response', '2020-01-01T00:00:00.000Z');
    await checkAgeReviewDeadlines(cronEnv);
    const row = await DB.prepare('SELECT state, version FROM age_review_cases WHERE id = ?')
      .bind('c7-cron').first<{ state: string; version: number }>();
    expect(row!.state).toBe('denied_closed');
    expect(row!.version).toBe(1); // CAS UPDATE applied
  });

  // A denied self-custody case enqueues a protected-minor projection job, but
  // keycast has no account to project onto and answers "user not found" every
  // time. Treated as a failure the job stays pending forever: the cron re-calls
  // keycast on every tick and retention eventually alarms on an overdue job.
  // There is nothing to project, so the job is settled, not retried.
  it('settles a projection job for a subject with no keycast account instead of retrying it forever', async () => {
    const now = new Date().toISOString();
    await DB.prepare(`INSERT OR REPLACE INTO protected_minor_subjects
      (subject_id, classification_state, classified_at, cleared_at, clear_reason, clear_reason_class)
      VALUES ('subj-selfcustody', 'cleared', ?, ?, 'age_review_denied', 'valid_prior')`)
      .bind(now, now).run();
    await DB.prepare(`INSERT OR REPLACE INTO protected_minor_projection_jobs
      (subject_id, pubkey, reason, state, created_at, updated_at)
      VALUES ('subj-selfcustody', ?, 'age_review_denied', 'pending', ?, ?)`)
      .bind('b'.repeat(64), now, now).run();

    let keycastCalls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      if (String(input).includes('/verified-minor')) {
        keycastCalls += 1;
        return Promise.resolve(new Response(JSON.stringify({ error: 'user not found' }), { status: 404 }));
      }
      return Promise.resolve(new Response('ok', { status: 200 }));
    });

    const keycastEnv = {
      ...cronEnv,
      KEYCAST_URL: 'https://login.test.divine.video',
      KEYCAST_SERVICE_TOKEN: 'test-token',
    };
    await checkAgeReviewDeadlines(keycastEnv);
    expect(keycastCalls).toBe(1);

    const row = await DB.prepare(
      "SELECT state FROM protected_minor_projection_jobs WHERE subject_id = 'subj-selfcustody'",
    ).first<{ state: string }>();
    expect(row!.state).toBe('complete');

    // Settled means settled: a second tick must not call keycast again.
    await checkAgeReviewDeadlines(keycastEnv);
    expect(keycastCalls).toBe(1);
  });

  it('projects an active subject with PUT and a cleared one with DELETE', async () => {
    await DB.prepare('DELETE FROM protected_minor_projection_jobs').run();
    await DB.prepare('DELETE FROM protected_minor_subjects').run();
    const now = new Date().toISOString();
    const activeKey = 'e'.repeat(64);
    const clearedKey = 'f'.repeat(64);
    await DB.prepare(`INSERT OR REPLACE INTO protected_minor_subjects
      (subject_id, classification_state, classified_at) VALUES ('subj-active', 'active', ?)`).bind(now).run();
    await DB.prepare(`INSERT OR REPLACE INTO protected_minor_subjects
      (subject_id, classification_state, classified_at, cleared_at, clear_reason, clear_reason_class)
      VALUES ('subj-cleared', 'cleared', ?, ?, 'age_review_denied', 'valid_prior')`).bind(now, now).run();
    for (const [subject, key, reason] of [
      ['subj-active', activeKey, 'age_review_approved'],
      ['subj-cleared', clearedKey, 'age_review_denied'],
    ]) {
      await DB.prepare(`INSERT OR REPLACE INTO protected_minor_projection_jobs
        (subject_id, pubkey, reason, state, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?)`)
        .bind(subject, key, reason, now, now).run();
    }
    const calls: Array<{ url: string; method: string }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      if (String(input).includes('/verified-minor')) {
        calls.push({ url: String(input), method: init?.method ?? 'GET' });
        return Promise.resolve(new Response('{}', { status: 200 }));
      }
      return Promise.resolve(new Response('ok', { status: 200 }));
    });

    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await checkAgeReviewDeadlines({ ...cronEnv, KEYCAST_URL: 'https://keycast.invalid', KEYCAST_SERVICE_TOKEN: 'test-token' });
    // A settled job must not fall through to the failure branch (retry rotation + error log).
    expect(errors.mock.calls.filter((c) => String(c[0]).includes('projection retry failed'))).toEqual([]);

    expect(calls).toContainEqual({
      url: `https://keycast.invalid/api/admin/users/${activeKey}/verified-minor?reason=age_review_approved`,
      method: 'PUT',
    });
    expect(calls).toContainEqual({
      url: `https://keycast.invalid/api/admin/users/${clearedKey}/verified-minor?reason=age_review_denied`,
      method: 'DELETE',
    });
    const pending = await DB.prepare(
      "SELECT COUNT(*) AS c FROM protected_minor_projection_jobs WHERE state = 'pending'",
    ).first<{ c: number }>();
    expect(pending!.c).toBe(0);
  });

  it('settles a set refused as account_unclaimed rather than retrying it forever', async () => {
    await DB.prepare('DELETE FROM protected_minor_projection_jobs').run();
    await DB.prepare('DELETE FROM protected_minor_subjects').run();
    const now = new Date().toISOString();
    await DB.prepare(`INSERT OR REPLACE INTO protected_minor_subjects
      (subject_id, classification_state, classified_at) VALUES ('subj-unclaimed', 'active', ?)`).bind(now).run();
    await DB.prepare(`INSERT OR REPLACE INTO protected_minor_projection_jobs
      (subject_id, pubkey, reason, state, created_at, updated_at)
      VALUES ('subj-unclaimed', ?, 'age_review_approved', 'pending', ?, ?)`).bind('9'.repeat(64), now, now).run();
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) =>
      Promise.resolve(String(input).includes('/verified-minor')
        ? new Response('{"error":"account_unclaimed: account has no login credentials"}', { status: 409 })
        : new Response('ok', { status: 200 })));

    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await checkAgeReviewDeadlines({ ...cronEnv, KEYCAST_URL: 'https://keycast.invalid', KEYCAST_SERVICE_TOKEN: 'test-token' });
    expect(errors.mock.calls.filter((c) => String(c[0]).includes('projection retry failed'))).toEqual([]);

    const row = await DB.prepare("SELECT state FROM protected_minor_projection_jobs WHERE subject_id = 'subj-unclaimed'")
      .first<{ state: string }>();
    expect(row!.state).toBe('complete');
  });

  it('a deny that re-arms a job mid-projection survives the in-flight completion', async () => {
    await DB.prepare('DELETE FROM protected_minor_projection_jobs').run();
    await DB.prepare('DELETE FROM protected_minor_account_bindings').run();
    await DB.prepare('DELETE FROM protected_minor_subjects').run();
    const pubkey = '8'.repeat(64);
    const { subjectId } = await createSubjectWithBinding(DB, 'case-race', pubkey);
    const earlier = '2026-01-01T00:00:00.000Z';
    await DB.prepare(`INSERT INTO protected_minor_projection_jobs
      (subject_id, pubkey, reason, state, created_at, updated_at)
      VALUES (?, ?, 'age_review_approved', 'pending', ?, ?)`).bind(subjectId, pubkey, earlier, earlier).run();
    const methods: string[] = [];
    let denied = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (!String(input).includes('/verified-minor')) return new Response('ok', { status: 200 });
      methods.push(init?.method ?? 'GET');
      if (!denied) {
        denied = true;
        // A concurrent deny lands while the PUT is in flight.
        await clearSubject(DB, pubkey, undefined, 'age_review_denied');
      }
      return new Response('{}', { status: 200 });
    });
    const env = { ...cronEnv, KEYCAST_URL: 'https://keycast.invalid', KEYCAST_SERVICE_TOKEN: 'test-token' };

    await checkAgeReviewDeadlines(env);
    expect(methods).toEqual(['PUT']);
    const job = await DB.prepare('SELECT state, reason FROM protected_minor_projection_jobs WHERE subject_id = ?')
      .bind(subjectId).first<{ state: string; reason: string }>();
    expect(job).toEqual({ state: 'pending', reason: 'age_review_denied' });

    await checkAgeReviewDeadlines(env);
    expect(methods).toEqual(['PUT', 'DELETE']);
    const done = await DB.prepare('SELECT state FROM protected_minor_projection_jobs WHERE subject_id = ?')
      .bind(subjectId).first<{ state: string }>();
    expect(done!.state).toBe('complete');
  });
  describe('latest decision wins between a denial and an approval (#192)', () => {
    const P = 'c'.repeat(64);
    const env = () => ({ ...cronEnv, KEYCAST_URL: 'https://keycast.invalid', KEYCAST_SERVICE_TOKEN: 'test-token' });
    let keycastCalls: string[];

    beforeEach(async () => {
      for (const t of ['protected_minor_projection_jobs', 'protected_minor_account_bindings', 'protected_minor_subjects']) {
        await DB.prepare(`DELETE FROM ${t}`).run();
      }
      keycastCalls = [];
      vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
        if (String(input).includes('/verified-minor')) keycastCalls.push(init?.method ?? 'GET');
        return Promise.resolve(new Response('{}', { status: 200 }));
      });
    });
    afterEach(() => vi.restoreAllMocks());

    async function caseAt(id: string, state: string, resolution: string | null, updatedAt: string) {
      await DB.prepare(`INSERT INTO age_review_cases
        (id, pubkey, state, clear_resolution, suspected_age_band, deadline_at, clock_paused, version, updated_at)
        VALUES (?, ?, ?, ?, 'age_13_15', NULL, 0, 1, ?)`).bind(id, P, state, resolution, updatedAt).run();
    }
    const activeCount = async () => (await DB.prepare(
      "SELECT COUNT(*) AS c FROM protected_minor_subjects WHERE classification_state = 'active'",
    ).first<{ c: number }>())!.c;

    it('(a) deny then a newer approval on a new subject: no retry, subject stays active', async () => {
      const { subjectId: s1 } = await createSubjectWithBinding(DB, 'deny-case', P);
      await caseAt('deny-case', 'denied_closed', null, '2026-03-01 00:00:00');
      await clearSubject(DB, P, undefined, 'age_review_denied', s1);
      await DB.prepare("DELETE FROM protected_minor_projection_jobs").run();
      await createSubjectWithBinding(DB, 'approve-case', P);
      await caseAt('approve-case', 'cleared', 'approved_minor', '2026-04-01 00:00:00');

      expect(await pendingSubjectClears(DB)).toEqual([]);
      await checkAgeReviewDeadlines(env());
      expect(await activeCount()).toBe(1);
      expect(keycastCalls).toEqual([]);
    });

    it('(b) approve then a later deny with the subject left active: still a retry source', async () => {
      const { subjectId } = await createSubjectWithBinding(DB, 'approve-case', P);
      await caseAt('approve-case', 'cleared', 'approved_minor', '2026-03-01 00:00:00');
      await caseAt('deny-case', 'denied_closed', null, '2026-04-01 00:00:00');

      const retries = await pendingSubjectClears(DB);
      expect(retries.map((r) => r.subjectId)).toEqual([subjectId]);
    });

    it('(d) a later not_minor Clear is not an approval: the denial stays a retry source', async () => {
      const { subjectId } = await createSubjectWithBinding(DB, 'onboarding-case', P); // clear failed: S1 active
      await caseAt('deny-case', 'denied_closed', null, '2026-03-01 00:00:00');
      await caseAt('dismiss-case', 'cleared', 'not_minor', '2026-04-01 00:00:00');
      expect((await pendingSubjectClears(DB)).map((r) => r.subjectId)).toEqual([subjectId]);
    });

    it('(e) a later legacy Clear (no resolution) is not an approval either', async () => {
      const { subjectId } = await createSubjectWithBinding(DB, 'onboarding-case', P);
      await caseAt('deny-case', 'denied_closed', null, '2026-03-01 00:00:00');
      await caseAt('legacy-case', 'cleared', null, '2026-04-01 00:00:00');
      expect((await pendingSubjectClears(DB)).map((r) => r.subjectId)).toEqual([subjectId]);
    });

    it('(f) same-second deny and approval: the later row (higher rowid) wins', async () => {
      await createSubjectWithBinding(DB, 'onboarding-case', P);
      await caseAt('deny-case', 'denied_closed', null, '2026-03-01 00:00:00');
      await caseAt('approve-case', 'cleared', 'approved_minor', '2026-03-01 00:00:00');
      expect(await pendingSubjectClears(DB)).toEqual([]);
    });

    it('(c) deny whose subject clear failed, then an approval reusing that subject: no retry', async () => {
      await createSubjectWithBinding(DB, 'onboarding-case', P); // S1 stays active
      await caseAt('deny-case', 'denied_closed', null, '2026-03-01 00:00:00');
      await caseAt('approve-case', 'cleared', 'approved_minor', '2026-04-01 00:00:00');

      expect(await pendingSubjectClears(DB)).toEqual([]);
    });
  });

  it('settles a clear job superseded by a newer active subject without calling keycast', async () => {
    for (const t of ['protected_minor_projection_jobs', 'protected_minor_account_bindings', 'protected_minor_subjects']) {
      await DB.prepare(`DELETE FROM ${t}`).run();
    }
    const P = 'd'.repeat(64);
    const { subjectId: s1 } = await createSubjectWithBinding(DB, 'old-case', P);
    await clearSubject(DB, P, undefined, 'age_review_denied', s1); // S1 cleared, clear job pending
    const { subjectId: s2 } = await createSubjectWithBinding(DB, 'new-case', P); // S2 active
    const calls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      if (String(input).includes('/verified-minor')) calls.push(init?.method ?? 'GET');
      return Promise.resolve(new Response('{}', { status: 200 }));
    });

    await checkAgeReviewDeadlines({ ...cronEnv, KEYCAST_URL: 'https://keycast.invalid', KEYCAST_SERVICE_TOKEN: 'test-token' });

    expect(calls).toEqual([]);
    const job = await DB.prepare('SELECT state FROM protected_minor_projection_jobs WHERE subject_id = ?')
      .bind(s1).first<{ state: string }>();
    expect(job!.state).toBe('complete');
    const s2row = await DB.prepare('SELECT classification_state FROM protected_minor_subjects WHERE subject_id = ?')
      .bind(s2).first<{ classification_state: string }>();
    expect(s2row!.classification_state).toBe('active');
  });

  it('re-arms the live subject when a clear lands after a racing approval completed its set', async () => {
    for (const t of ['protected_minor_projection_jobs', 'protected_minor_account_bindings', 'protected_minor_subjects']) {
      await DB.prepare(`DELETE FROM ${t}`).run();
    }
    const P = 'a1'.repeat(32);
    const { subjectId: s1 } = await createSubjectWithBinding(DB, 'old-case', P);
    await clearSubject(DB, P, undefined, 'age_review_denied', s1); // S1 cleared, clear job pending
    const calls: string[] = [];
    let s2 = '';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (!String(input).includes('/verified-minor')) return new Response('ok', { status: 200 });
      calls.push(init?.method ?? 'GET');
      if (init?.method === 'DELETE' && !s2) {
        // The approval creates S2 and its PUT completes while this DELETE is in flight.
        s2 = (await createSubjectWithBinding(DB, 'new-case', P)).subjectId;
        const now = new Date().toISOString();
        await DB.prepare(`INSERT INTO protected_minor_projection_jobs
          (subject_id, pubkey, reason, state, created_at, updated_at)
          VALUES (?, ?, 'age_review_approved', 'complete', ?, ?)`).bind(s2, P, now, now).run();
      }
      return new Response('{}', { status: 200 });
    });
    const env = { ...cronEnv, KEYCAST_URL: 'https://keycast.invalid', KEYCAST_SERVICE_TOKEN: 'test-token' };
    const jobState = async (id: string) => (await DB.prepare(
      'SELECT state FROM protected_minor_projection_jobs WHERE subject_id = ?',
    ).bind(id).first<{ state: string }>())!.state;

    await checkAgeReviewDeadlines(env);
    expect(calls).toEqual(['DELETE']);
    expect(await jobState(s1)).toBe('complete');
    expect(await jobState(s2)).toBe('pending');

    await checkAgeReviewDeadlines(env);
    expect(calls).toEqual(['DELETE', 'PUT']);
    expect(await jobState(s2)).toBe('complete');
  });
  it('re-arming keeps the age of an already-pending live job', async () => {
    for (const t of ['protected_minor_projection_jobs', 'protected_minor_account_bindings', 'protected_minor_subjects']) {
      await DB.prepare(`DELETE FROM ${t}`).run();
    }
    const P = 'b2'.repeat(32);
    const { subjectId } = await createSubjectWithBinding(DB, 'live-case', P);
    const old = '2026-01-01T00:00:00.000Z';
    await DB.prepare(`INSERT INTO protected_minor_projection_jobs
      (subject_id, pubkey, reason, state, created_at, updated_at)
      VALUES (?, ?, 'age_review_approved', 'pending', ?, ?)`).bind(subjectId, P, old, old).run();
    await rearmLiveSubjectProjection(DB, P);
    const job = await DB.prepare('SELECT state, created_at FROM protected_minor_projection_jobs WHERE subject_id = ?')
      .bind(subjectId).first<{ state: string; created_at: string }>();
    expect(job).toEqual({ state: 'pending', created_at: old });
  });
});
