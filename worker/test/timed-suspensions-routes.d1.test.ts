// ABOUTME: Real-D1 route tests for suspending with an end time over /api/relay-rpc, and for
// ABOUTME: a manual unsuspend cancelling the timer. Relay, Keycast and notify are faked.
import { Miniflare } from 'miniflare';
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import worker from '../src/index';
import { ensureSchema } from '../src/db';
import { isHumanHandling } from '../../shared/handling';
import { DURATION_ERROR, formatSuspensionEnd, suspensionEndsAt } from '../../shared/suspension';
import { emptyManagementState, managementFake, type ManagementState } from '../src/test-helpers/management-fake';

const TEST_NSEC = 'nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5';
const PK = 'c3'.repeat(32);
const MOD = 'd4'.repeat(32);

let mf: Miniflare;
let DB: D1Database;

beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok"); } };',
    compatibilityDate: '2024-12-01',
    compatibilityFlags: ['nodejs_compat'],
    d1Databases: ['DB'],
  });
  DB = (await mf.getD1Database('DB')) as unknown as D1Database;
  await ensureSchema(DB);
});
afterAll(async () => { await mf?.dispose(); });
afterEach(async () => {
  vi.restoreAllMocks();
  await DB.prepare('DELETE FROM age_review_cases').run();
  await DB.prepare('DELETE FROM timed_suspensions').run();
  await DB.prepare('DELETE FROM moderation_decisions').run();
});

function env() {
  return {
    ADMIN_API_KEY: 'k',
    ALLOWED_ORIGINS: 'https://app.example',
    RELAY_URL: 'wss://relay.example',
    NOSTR_NSEC: TEST_NSEC,
    MODERATION_ADMIN_URL: 'https://moderation.example',
    SERVICE_API_TOKEN: 'service-token',
    KEYCAST_URL: 'https://login.example',
    KEYCAST_SERVICE_TOKEN: 'keycast-token',
    MODERATOR_LOGIN_URL: 'https://login.example',
    SLACK_WEBHOOK_URL: 'https://hooks.example/services/T/B/x',
    ENVIRONMENT: 'test',
    DB,
  } as never;
}

function setup(overrides: Partial<ManagementState> = {}) {
  const state: ManagementState = {
    ...emptyManagementState(),
    keycast: new Map([[PK, 'active']]),
    moderator: MOD,
    ...overrides,
  };
  return managementFake(state);
}

async function rpc(body: Record<string, unknown>) {
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); } } as unknown as ExecutionContext;
  const res = await worker.fetch(new Request('https://api.example/api/relay-rpc', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Admin-Key': 'k',
      'X-Divine-Login-Token': 'tok',
      Origin: 'https://app.example',
    },
    body: JSON.stringify(body),
  }), env(), ctx);
  const json = await res.json() as Record<string, unknown>;
  // Everything registered off the response path has finished before asserting.
  await Promise.allSettled(pending);
  return { status: res.status, json };
}

type Row = { status: string; ends_at: string | null; set_by: string | null; version: number };
const record = () => DB.prepare('SELECT * FROM timed_suspensions WHERE pubkey = ?').bind(PK).first<Row>();
const decisions = async () => (await DB.prepare(
  'SELECT action, reason, moderator_pubkey FROM moderation_decisions WHERE target_id = ? ORDER BY id',
).bind(PK).all<{ action: string; reason: string; moderator_pubkey: string | null }>()).results;

async function seedRecord(status: string, endsAt: string | null) {
  await DB.prepare(
    `INSERT INTO timed_suspensions (pubkey, ends_at, status, set_by, set_at) VALUES (?, ?, ?, NULL, ?)`,
  ).bind(PK, endsAt, status, new Date().toISOString()).run();
}

describe('suspendpubkey with an end time', () => {
  it('suspend with 3 days stores the end, writes the decision, and states the end in the message', async () => {
    const fake = setup();
    const before = new Date();
    const res = await rpc({ method: 'suspendpubkey', params: [PK, 'policy'], suspension: { duration: { value: 3, unit: 'days' } } });
    const after = new Date();

    expect(res.status).toBe(200);
    expect(res.json.success).toBe(true);
    const suspension = res.json.suspension as { endsAt: string; recorded: boolean; decisionRecorded: boolean };
    expect(suspension.recorded).toBe(true);
    expect(suspension.decisionRecorded).toBe(true);
    const lo = suspensionEndsAt({ value: 3, unit: 'days' }, before);
    const hi = suspensionEndsAt({ value: 3, unit: 'days' }, after);
    expect(suspension.endsAt >= lo && suspension.endsAt <= hi).toBe(true);

    expect(await record()).toMatchObject({ status: 'active', ends_at: suspension.endsAt, set_by: MOD });

    const rows = await decisions();
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('suspend_user');
    expect(rows[0].reason).toContain(suspension.endsAt);
    expect(rows[0].moderator_pubkey).toBe(MOD);

    expect(fake.notifies).toHaveLength(1);
    expect(fake.notifies[0]).toMatchObject({ action: 'ACCOUNT_SUSPENDED', recipientPubkey: PK, endsAt: suspension.endsAt });
    expect(fake.relayWrites()).toEqual([{ method: 'suspendpubkey', params: [PK, 'policy'] }]);
    expect(fake.keycastPuts).toEqual([{ pubkey: PK, status: 'suspended', actor: MOD }]);
  });

  it('suspend with duration null stores an open-ended record and sends no endsAt', async () => {
    const fake = setup();
    const res = await rpc({ method: 'suspendpubkey', params: [PK, 'policy'], suspension: { duration: null } });

    expect(res.status).toBe(200);
    expect(res.json.suspension).toEqual({ endsAt: null, recorded: true, decisionRecorded: true });
    expect(await record()).toMatchObject({ status: 'active', ends_at: null });
    const rows = await decisions();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'suspend_user', reason: 'Suspended by moderator, no end date' });
    expect(fake.notifies).toHaveLength(1);
    expect(fake.notifies[0].action).toBe('ACCOUNT_SUSPENDED');
    expect('endsAt' in fake.notifies[0]).toBe(false);
  });

  // Review Focus 5: the worker answers 400 before touching the relay.
  it.each([
    [{ value: 0, unit: 'days' }],
    [{ value: -1, unit: 'hours' }],
    [{ value: 1.5, unit: 'days' }],
    [{ value: '3', unit: 'days' }],
    [{ value: 366, unit: 'days' }],
    [{ value: 8761, unit: 'hours' }],
    [{ value: 3 }],
    [{ value: 3, unit: 'weeks' }],
    ['3 days'],
  ])('an invalid duration %j is refused before the relay is called', async (duration) => {
    const fake = setup();
    const res = await rpc({ method: 'suspendpubkey', params: [PK, 'policy'], suspension: { duration } });

    expect(res.status).toBe(400);
    expect(res.json).toEqual({ success: false, error: DURATION_ERROR, code: 'invalid_duration' });
    expect(fake.rpcCalls).toHaveLength(0);
    expect(fake.keycastPuts).toHaveLength(0);
    expect(fake.notifies).toHaveLength(0);
    expect(await record()).toBeNull();
    expect(await decisions()).toHaveLength(0);
  });

  it('a legacy suspend (no field) replaces the record but writes no decision and adds no response field', async () => {
    const fake = setup();
    await seedRecord('active', '2030-01-01T00:00:00.000Z');
    const res = await rpc({ method: 'suspendpubkey', params: [PK, 'policy'] });

    expect(res.status).toBe(200);
    expect(res.json).toEqual({ success: true, result: true });
    expect(await record()).toMatchObject({ status: 'active', ends_at: null, set_by: MOD });
    expect(await decisions()).toHaveLength(0);
    expect(fake.notifies).toHaveLength(1);
    expect('endsAt' in fake.notifies[0]).toBe(false);
  });

  it('a record write failure keeps the suspend, reports recorded:false, and sends no endsAt', async () => {
    const fake = setup();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await DB.prepare('DROP TABLE timed_suspensions').run();
    try {
      const res = await rpc({ method: 'suspendpubkey', params: [PK, 'policy'], suspension: { duration: { value: 2, unit: 'hours' } } });

      expect(res.status).toBe(200);
      expect(res.json.success).toBe(true);
      expect(res.json.suspension).toMatchObject({ endsAt: null, recorded: false });
      expect(fake.relayWrites()).toEqual([{ method: 'suspendpubkey', params: [PK, 'policy'] }]);
      expect(fake.keycastPuts).toEqual([{ pubkey: PK, status: 'suspended', actor: MOD }]);
      expect(fake.notifies).toHaveLength(1);
      expect(fake.notifies[0].action).toBe('ACCOUNT_SUSPENDED');
      expect('endsAt' in fake.notifies[0]).toBe(false);
      // The history must not claim an end that nothing will act on.
      const rows = await decisions();
      expect(rows).toHaveLength(1);
      expect(rows[0].reason).toContain('end date not saved');
      // The pre-check read and the write both failed, so nothing ruled out a lift in flight.
      expect(fake.alerts).toHaveLength(1);
      expect(fake.alerts[0]).toContain(PK);
    } finally {
      await ensureSchema(DB);
    }
  });

  it('a relay failure on suspend writes no record', async () => {
    const fake = setup({ fail: { suspendpubkey: true } });
    const res = await rpc({ method: 'suspendpubkey', params: [PK, 'policy'], suspension: { duration: { value: 3, unit: 'days' } } });

    expect(res.status).toBe(400);
    expect(res.json.success).toBe(false);
    expect(await record()).toBeNull();
    expect(await decisions()).toHaveLength(0);
    expect(fake.keycastPuts).toHaveLength(0);
    expect(fake.notifies).toHaveLength(0);
  });

  // F12: a re-suspend must not overwrite the timer's claim mid-lift.
  it('a re-suspend while the timer is lifting is refused with 409 before the relay is called', async () => {
    const fake = setup();
    await seedRecord('lifting', '2026-01-01T00:00:00.000Z');
    const res = await rpc({ method: 'suspendpubkey', params: [PK, 'policy'], suspension: { duration: { value: 3, unit: 'days' } } });

    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ success: false, code: 'suspension_ending' });
    expect(fake.rpcCalls).toHaveLength(0);
    expect(fake.keycastPuts).toHaveLength(0);
    expect(fake.notifies).toHaveLength(0);
    expect(await record()).toMatchObject({ status: 'lifting', ends_at: '2026-01-01T00:00:00.000Z' });
    expect(await decisions()).toHaveLength(0);
  });

  it('a legacy re-suspend while the timer is lifting is refused the same way', async () => {
    const fake = setup();
    await seedRecord('lifting', '2026-01-01T00:00:00.000Z');
    const res = await rpc({ method: 'suspendpubkey', params: [PK, 'policy'] });

    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ success: false, code: 'suspension_ending' });
    expect(fake.rpcCalls).toHaveLength(0);
  });

  it('a re-suspend after the relay lift (keycast_pending) replaces the record', async () => {
    setup();
    await seedRecord('keycast_pending', '2026-01-01T00:00:00.000Z');
    const res = await rpc({ method: 'suspendpubkey', params: [PK, 'policy'], suspension: { duration: null } });

    expect(res.status).toBe(200);
    expect(res.json.suspension).toMatchObject({ recorded: true });
    expect(await record()).toMatchObject({ status: 'active', ends_at: null });
  });

  // F12's narrow race: the timer claims the row while the relay suspend is in flight, so its
  // lift may undo this suspend. The claim is left alone, the moderator gets the same 409 as
  // the pre-check, nothing is sent to the person or Keycast, the history says what happened,
  // and the team is alerted to check the account.
  it.each([
    ['with an end', { suspension: { duration: { value: 3, unit: 'days' } } }],
    ['legacy (no field)', {}],
  ])('a timer claim landing during the relay call (%s) is refused with 409, sends nothing, and is recorded and alerted', async (_label, extra) => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await seedRecord('active', '2026-01-01T00:00:00.000Z');
    const fake = setup({
      before: {
        suspendpubkey: async () => {
          await DB.prepare(`UPDATE timed_suspensions SET status = 'lifting', claimed_at = ? WHERE pubkey = ?`)
            .bind(new Date().toISOString(), PK).run();
        },
      },
    });
    const res = await rpc({ method: 'suspendpubkey', params: [PK, 'policy'], ...extra });

    expect(res.status).toBe(409);
    expect(res.json).toEqual({
      success: false,
      error: 'This suspension is ending now. Check again in a few minutes.',
      code: 'suspension_ending',
    });
    expect(fake.relayWrites()).toEqual([{ method: 'suspendpubkey', params: [PK, 'policy'] }]);
    expect(await record()).toMatchObject({ status: 'lifting', ends_at: '2026-01-01T00:00:00.000Z' });
    expect(fake.notifies).toHaveLength(0);
    expect(fake.keycastPuts).toHaveLength(0);
    const rows = await decisions();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'suspend_user', moderator_pubkey: MOD });
    expect(rows[0].reason).toMatch(/^Suspended by moderator while a timed lift was in progress; the lift may undo this suspension/);
    expect(fake.alerts).toHaveLength(1);
    expect(fake.alerts[0]).toContain(PK);
    expect(errors.mock.calls.some(c => String(c[0]).includes('lifting') && String(c[0]).includes(PK))).toBe(true);
  });
});

describe('unsuspendpubkey and the timer', () => {
  it('manual unsuspend cancels an active record and sends one ACCOUNT_RESTORED', async () => {
    const fake = setup({ keycast: new Map([[PK, 'suspended']]), suspended: new Map([[PK, 'policy']]) });
    await seedRecord('active', '2030-01-01T00:00:00.000Z');
    const res = await rpc({ method: 'unsuspendpubkey', params: [PK] });

    expect(res.status).toBe(200);
    expect(res.json).toEqual({ success: true, result: true });
    expect(await record()).toMatchObject({ status: 'cancelled_unsuspend', ends_at: '2030-01-01T00:00:00.000Z' });
    expect(fake.notifies).toHaveLength(1);
    expect(fake.notifies[0]).toMatchObject({ action: 'ACCOUNT_RESTORED', recipientPubkey: PK });
    expect('endsAt' in fake.notifies[0]).toBe(false);
    expect(fake.keycastPuts).toEqual([{ pubkey: PK, status: 'active', actor: MOD }]);
    expect(fake.state.keycast.get(PK)).toBe('active');
  });

  it('manual unsuspend with no record still restores once', async () => {
    const fake = setup({ keycast: new Map([[PK, 'suspended']]) });
    const res = await rpc({ method: 'unsuspendpubkey', params: [PK] });

    expect(res.status).toBe(200);
    expect(await record()).toBeNull();
    expect(fake.notifies.map(n => n.action)).toEqual(['ACCOUNT_RESTORED']);
    expect(fake.keycastPuts).toHaveLength(1);
  });

  // The Suspended tab offers Unsuspend on a banned row. Keycast activate is the same call
  // unban uses, so restoring there would lift the Keycast ban while the relay ban stands,
  // and "restored" would be untrue.
  it('manual unsuspend of a banned account sends no ACCOUNT_RESTORED and leaves Keycast banned', async () => {
    const fake = setup({ banned: new Set([PK]), keycast: new Map([[PK, 'banned']]), suspended: new Map([[PK, 'policy']]) });
    await seedRecord('cancelled_ban', '2030-01-01T00:00:00.000Z');
    const res = await rpc({ method: 'unsuspendpubkey', params: [PK] });

    expect(res.status).toBe(200);
    expect(fake.relayWrites().map(c => c.method)).toEqual(['unsuspendpubkey']);
    expect(await record()).toMatchObject({ status: 'cancelled_unsuspend' });
    expect(fake.notifies).toEqual([]);
    expect(fake.keycastPuts).toEqual([]);
    expect(fake.state.keycast.get(PK)).toBe('banned');
    expect(fake.alerts).toEqual([]);
  });

  it('manual unsuspend with an unreadable ban list restores nothing and alerts', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fake = setup({ keycast: new Map([[PK, 'suspended']]), suspended: new Map([[PK, 'policy']]),
      fail: { listbannedpubkeys: true } });
    const res = await rpc({ method: 'unsuspendpubkey', params: [PK] });

    expect(res.status).toBe(200);
    expect(fake.notifies).toEqual([]);
    expect(fake.keycastPuts).toEqual([]);
    expect(fake.alerts).toHaveLength(1);
    expect(fake.alerts[0]).toContain(PK);
    expect(fake.alerts[0]).toContain('[test]');
  });

  it('a relay failure on unsuspend leaves the record active and sends nothing', async () => {
    const fake = setup({ fail: { unsuspendpubkey: true } });
    await seedRecord('active', '2030-01-01T00:00:00.000Z');
    const res = await rpc({ method: 'unsuspendpubkey', params: [PK] });

    expect(res.status).toBe(400);
    expect(await record()).toMatchObject({ status: 'active' });
    expect(fake.notifies).toHaveLength(0);
    expect(fake.keycastPuts).toHaveLength(0);
  });
});


// ---------------------------------------------------------------------------
// B5: change a suspension's end date, and list timed suspensions.
// ---------------------------------------------------------------------------

async function call(method: 'GET' | 'POST', path: string, body?: Record<string, unknown>, e: unknown = env()) {
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); } } as unknown as ExecutionContext;
  const res = await worker.fetch(new Request(`https://api.example${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Admin-Key': 'k',
      'X-Divine-Login-Token': 'tok',
      Origin: 'https://app.example',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }), e as never, ctx);
  const json = await res.json() as Record<string, unknown>;
  await Promise.allSettled(pending);
  return { status: res.status, json };
}
const changeEnd = (body: Record<string, unknown>, e?: unknown) => call('POST', '/api/suspensions/end', body, e);
const THREE_DAYS = { value: 3, unit: 'days' };

async function seedAgeCase() {
  await DB.prepare(
    `INSERT INTO age_review_cases (id, pubkey, state, deadline_at, clock_paused, version)
     VALUES ('c1', ?, 'restricted_pending_user_response', ?, 0, 0)`,
  ).bind(PK, new Date(Date.now() + 864e5).toISOString()).run();
}

describe('POST /api/suspensions/end', () => {
  it('changes an active record\'s end, writes change_suspension_end, and sends ACCOUNT_SUSPENSION_CHANGED with the new end', async () => {
    const fake = setup({ suspended: new Map([[PK, 'policy']]) });
    const old = '2030-01-01T00:00:00.000Z';
    await seedRecord('active', old);
    const res = await changeEnd({ pubkey: PK, duration: THREE_DAYS });

    expect(res.status).toBe(200);
    expect(res.json.success).toBe(true);
    expect(res.json.decisionRecorded).toBe(true);
    const endsAt = res.json.endsAt as string;
    expect(endsAt).toMatch(/Z$/);
    expect(await record()).toMatchObject({ status: 'active', ends_at: endsAt });
    const rows = await decisions();
    expect(rows).toEqual([{ action: 'change_suspension_end', reason: `Ends ${endsAt}; was ${old}`, moderator_pubkey: MOD }]);
    expect(fake.notifies).toHaveLength(1);
    expect(fake.notifies[0]).toMatchObject({ action: 'ACCOUNT_SUSPENSION_CHANGED', recipientPubkey: PK, endsAt });
    expect(fake.relayWrites()).toEqual([]);
    expect(fake.keycastPuts).toEqual([]);
  });

  it('adds an end date to a suspended account with no record', async () => {
    const fake = setup({ suspended: new Map([[PK, null]]) });
    const res = await changeEnd({ pubkey: PK, duration: THREE_DAYS });

    expect(res.status).toBe(200);
    expect(await record()).toMatchObject({ status: 'active', ends_at: res.json.endsAt, set_by: MOD });
    expect((await decisions())[0].reason).toBe(`Ends ${res.json.endsAt}; was no end date`);
    expect(fake.notifies).toHaveLength(1);
  });

  it('refuses a non-canonical pubkey with 400 invalid_pubkey', async () => {
    const fake = setup({ suspended: new Map([[PK, null]]) });
    const res = await changeEnd({ pubkey: PK.toUpperCase(), duration: THREE_DAYS });
    expect(res.status).toBe(400);
    expect(res.json.code).toBe('invalid_pubkey');
    expect(fake.notifies).toEqual([]);
  });

  it.each(['not json', 'null', '[]', '"text"', '3', 'false'])(
    'refuses a non-object request body (%s) with 400 invalid_body', async (body) => {
      const fake = setup({ suspended: new Map([[PK, null]]) });
      const res = await worker.fetch(new Request('https://api.example/api/suspensions/end', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Key': 'k', 'X-Divine-Login-Token': 'tok', Origin: 'https://app.example' },
        body,
      }), env(), { waitUntil: () => {} } as unknown as ExecutionContext);
      expect(res.status).toBe(400);
      expect((await res.json() as { code: string }).code).toBe('invalid_body');
      expect(fake.relayWrites()).toEqual([]);
      expect(fake.notifies).toEqual([]);
    },
  );

  it.each([[{ value: 0, unit: 'days' }], [{ value: 1.5, unit: 'hours' }], [null], [undefined]])(
    'refuses duration %j with 400 invalid_duration', async (duration) => {
      setup({ suspended: new Map([[PK, null]]) });
      const res = await changeEnd({ pubkey: PK, duration });
      expect(res.status).toBe(400);
      expect(res.json.code).toBe('invalid_duration');
      expect(res.json.error).toBe(DURATION_ERROR);
    });

  it('answers 503 without a DB binding', async () => {
    const fake = setup({ suspended: new Map([[PK, null]]) });
    const res = await changeEnd({ pubkey: PK, duration: THREE_DAYS }, { ...(env() as object), DB: undefined });
    expect(res.status).toBe(503);
    expect(fake.notifies).toEqual([]);
  });

  it('refuses with the age-review 409 while the account has an open case', async () => {
    const fake = setup({ suspended: new Map([[PK, null]]) });
    await seedRecord('active', null);
    await seedAgeCase();
    const res = await changeEnd({ pubkey: PK, duration: THREE_DAYS });
    expect(res.status).toBe(409);
    expect(res.json.code).toBe('age_review_active');
    expect((await record())?.ends_at).toBeNull();
    expect(await decisions()).toEqual([]);
    expect(fake.notifies).toEqual([]);
  });

  it('refuses with 409 account_banned when the relay ban list has the account', async () => {
    const fake = setup({ banned: new Set([PK]), suspended: new Map([[PK, null]]) });
    const res = await changeEnd({ pubkey: PK, duration: THREE_DAYS });
    expect(res.status).toBe(409);
    expect(res.json.code).toBe('account_banned');
    expect(await record()).toBeNull();
    expect(await decisions()).toEqual([]);
    expect(fake.notifies).toEqual([]);
  });

  it('refuses with 409 account_banned when only Keycast has the ban (F17)', async () => {
    const fake = setup({ suspended: new Map([[PK, null]]), keycast: new Map([[PK, 'banned']]) });
    const res = await changeEnd({ pubkey: PK, duration: THREE_DAYS });
    expect(res.status).toBe(409);
    expect(res.json.code).toBe('account_banned');
    expect(await record()).toBeNull();
    expect(fake.notifies).toEqual([]);
  });

  it('proceeds when the Keycast status cannot be read', async () => {
    const fake = setup({ suspended: new Map([[PK, null]]), fail: { keycast_get: true } });
    const res = await changeEnd({ pubkey: PK, duration: THREE_DAYS });
    expect(res.status).toBe(200);
    expect(fake.notifies).toHaveLength(1);
  });

  it('refuses with 409 not_suspended when the relay does not list the account', async () => {
    const fake = setup();
    const res = await changeEnd({ pubkey: PK, duration: THREE_DAYS });
    expect(res.status).toBe(409);
    expect(res.json.code).toBe('not_suspended');
    expect(await record()).toBeNull();
    expect(await decisions()).toEqual([]);
    expect(fake.notifies).toEqual([]);
  });

  it('answers 503 status_unavailable, never not_suspended, when the suspension list cannot be read', async () => {
    const fake = setup({ fail: { listsuspendedpubkeys: true } });
    const res = await changeEnd({ pubkey: PK, duration: THREE_DAYS });
    expect(res.status).toBe(503);
    expect(res.json.code).toBe('status_unavailable');
    expect(await record()).toBeNull();
    expect(fake.notifies).toEqual([]);
  });

  it('answers 503 status_unavailable when the ban list cannot be read', async () => {
    const fake = setup({ suspended: new Map([[PK, null]]), fail: { listbannedpubkeys: true } });
    const res = await changeEnd({ pubkey: PK, duration: THREE_DAYS });
    expect(res.status).toBe(503);
    expect(res.json.code).toBe('status_unavailable');
    expect(await record()).toBeNull();
    expect(fake.notifies).toEqual([]);
  });

  it.each(['lifting', 'keycast_pending'])('refuses while the record is %s and leaves ends_at unchanged', async (status) => {
    const fake = setup({ suspended: new Map([[PK, null]]) });
    const old = '2030-01-01T00:00:00.000Z';
    await seedRecord(status, old);
    const res = await changeEnd({ pubkey: PK, duration: THREE_DAYS });
    expect(res.status).toBe(409);
    expect(res.json.code).toBe('suspension_ending');
    expect(await record()).toMatchObject({ status, ends_at: old });
    expect(await decisions()).toEqual([]);
    expect(fake.notifies).toEqual([]);
  });

  it('refuses with 409 conflict when the record changes under the write', async () => {
    const fake = setup({ suspended: new Map([[PK, null]]) });
    await seedRecord('active', null);
    // A second moderator's change lands between this request's read of the row and its guarded write.
    const racing = new Proxy(DB, {
      get(target, key) {
        if (key !== 'prepare') { const v = Reflect.get(target, key); return typeof v === 'function' ? v.bind(target) : v; }
        return (sql: string) => {
          const stmt = target.prepare(sql);
          if (!/UPDATE timed_suspensions\s+SET ends_at/.test(sql)) return stmt;
          return {
            bind: (...args: unknown[]) => {
              const bound = stmt.bind(...args);
              return { run: async () => {
                await DB.prepare('UPDATE timed_suspensions SET version = version + 1').run();
                return bound.run();
              } };
            },
          };
        };
      },
    });
    const res = await changeEnd({ pubkey: PK, duration: THREE_DAYS }, { ...(env() as object), DB: racing });
    expect(res.status).toBe(409);
    expect(res.json.code).toBe('conflict');
    expect((await record())?.ends_at).toBeNull();
    expect(await decisions()).toEqual([]);
    expect(fake.notifies).toEqual([]);
  });
});

describe('GET /api/suspensions', () => {
  it('lists active, lifting and cancelled_ban records only, as TimedSuspensionView', async () => {
    const PK2 = 'e5'.repeat(32); const PK3 = 'f6'.repeat(32); const PK4 = 'a7'.repeat(32); const PK5 = 'b8'.repeat(32);
    const at = '2031-01-01T00:00:00.000Z';
    const ins = (pk: string, st: string) => DB.prepare(
      `INSERT INTO timed_suspensions (pubkey, ends_at, status, set_by, set_at) VALUES (?, ?, ?, ?, ?)`,
    ).bind(pk, at, st, MOD, '2030-01-01T00:00:00.000Z').run();
    await ins(PK, 'active'); await ins(PK2, 'cancelled_ban'); await ins(PK3, 'lifting');
    await ins(PK4, 'lifted'); await ins(PK5, 'cancelled_unsuspend');
    const res = await call('GET', '/api/suspensions');
    expect(res.status).toBe(200);
    expect(res.json.success).toBe(true);
    const list = res.json.suspensions as Array<Record<string, unknown>>;
    expect(list.map(v => v.pubkey).sort()).toEqual([PK, PK2, PK3].sort());
    expect(list.find(v => v.pubkey === PK)).toEqual({
      pubkey: PK, endsAt: at, status: 'active', setBy: MOD, setAt: '2030-01-01T00:00:00.000Z', changedAt: null,
    });
    expect(list.find(v => v.pubkey === PK2)?.status).toBe('cancelled_ban');
    expect(list.find(v => v.pubkey === PK3)?.status).toBe('active');
  });

  it('answers 503 without a DB binding', async () => {
    const res = await call('GET', '/api/suspensions', undefined, { ...(env() as object), DB: undefined });
    expect(res.status).toBe(503);
  });
});

// ---------------------------------------------------------------------------
// B7: an unban asks what happens to a running suspension.
// ---------------------------------------------------------------------------

// Minute-aligned, relative to now (F2): never a real-clock literal that can go stale.
const minuteAhead = (ms: number) => new Date(Math.ceil((Date.now() + ms) / 60_000) * 60_000).toISOString();
const FUTURE_END = minuteAhead(3 * 864e5);
const PAST_END = minuteAhead(-864e5);
const unban = (suspensionChoice?: unknown) =>
  rpc({ method: 'unbanpubkey', params: [PK], ...(suspensionChoice !== undefined && { suspensionChoice }) });
const bannedSetup = (overrides: Partial<ManagementState> = {}) => setup({
  banned: new Set([PK]), keycast: new Map([[PK, 'banned']]), ...overrides,
});
const suspendedSetup = (overrides: Partial<ManagementState> = {}) => bannedSetup({
  suspended: new Map([[PK, 'policy']]), ...overrides,
});

describe('unbanpubkey and a running suspension', () => {
  it('not suspended: Keycast active, state not_suspended, and an in-force record goes already_lifted', async () => {
    const fake = bannedSetup();
    await seedRecord('cancelled_ban', FUTURE_END);
    const res = await unban();

    expect(res.status).toBe(200);
    expect(res.json.suspension).toMatchObject({ state: 'not_suspended' });
    expect(fake.keycastPuts).toEqual([{ pubkey: PK, status: 'active', actor: MOD }]);
    expect(await record()).toMatchObject({ status: 'already_lifted' });
    expect(fake.notifies).toHaveLength(0);
    expect(await decisions()).toHaveLength(0);
  });

  it('an unreadable suspended list: Keycast untouched, record untouched, state unknown, and an alert', async () => {
    const fake = bannedSetup({ fail: { listsuspendedpubkeys: true } });
    await seedRecord('cancelled_ban', FUTURE_END);
    const res = await unban('end_now');

    expect(res.status).toBe(200);
    expect(res.json.suspension).toMatchObject({ state: 'unknown' });
    expect(fake.keycastPuts).toHaveLength(0);
    expect(fake.notifies).toHaveLength(0);
    expect(fake.relayWrites().map(c => c.method)).toEqual(['unbanpubkey']);
    expect(await record()).toMatchObject({ status: 'cancelled_ban' });
    // Callers that never show the outcome (moderation-service allow_pubkey, EventDetail)
    // would otherwise leave the account Keycast-banned with no trace.
    expect(fake.alerts).toHaveLength(1);
    expect(fake.alerts[0]).toContain(PK);
    expect(fake.alerts[0]).toContain('[test]');
  });

  it('a version race on resume is unknown but sends no alert: the list was read', async () => {
    const fake = suspendedSetup();
    await seedRecord('lifting', FUTURE_END);
    const res = await unban();
    expect(res.json.suspension).toMatchObject({ state: 'unknown' });
    expect(fake.alerts).toEqual([]);
  });

  it('default (no choice) resumes: Keycast suspended, record active, CHANGED with the original end, no decision row', async () => {
    const fake = suspendedSetup();
    await seedRecord('active', FUTURE_END);
    const res = await unban();

    expect(res.status).toBe(200);
    expect(res.json.suspension).toMatchObject({ state: 'resumed', endsAt: FUTURE_END });
    expect(await record()).toMatchObject({ status: 'active', ends_at: FUTURE_END });
    expect(fake.keycastPuts).toEqual([{ pubkey: PK, status: 'suspended', actor: MOD }]);
    expect(fake.notifies).toHaveLength(1);
    expect(fake.notifies[0]).toMatchObject({ action: 'ACCOUNT_SUSPENSION_CHANGED', recipientPubkey: PK, endsAt: FUTURE_END });
    expect(await decisions()).toHaveLength(0);
  });

  it('resume leaves an unchanged end alone: changed_by and changed_at stay as they were', async () => {
    suspendedSetup();
    await seedRecord('active', FUTURE_END);
    await unban();
    const row = await DB.prepare('SELECT changed_by, changed_at FROM timed_suspensions WHERE pubkey = ?').bind(PK)
      .first<{ changed_by: string | null; changed_at: string | null }>();
    expect(row).toEqual({ changed_by: null, changed_at: null });
  });

  // G5: a change-end landing between the resume's read and its write must win, not be
  // overwritten with the end the resume read.
  it.each(['active', 'cancelled_ban'])('resume of an %s record never overwrites a change that landed after its read', async (status) => {
    const fake = suspendedSetup();
    await seedRecord(status, FUTURE_END);
    const OTHER = '2031-06-01T00:00:00.000Z';
    let reads = 0;
    const racingDb = new Proxy(DB, {
      get(target, prop) {
        if (prop !== 'prepare') return Reflect.get(target, prop).bind?.(target) ?? Reflect.get(target, prop);
        return (sql: string) => {
          const stmt = target.prepare(sql);
          if (!sql.startsWith('SELECT * FROM timed_suspensions WHERE pubkey = ?')) return stmt;
          return {
            bind: (...args: unknown[]) => ({
              first: async () => {
                const row = await stmt.bind(...args).first();
                if (reads++ === 0) {
                  await target.prepare(`UPDATE timed_suspensions SET ends_at = ?, status = 'active', version = version + 1 WHERE pubkey = ?`)
                    .bind(OTHER, PK).run();
                }
                return row;
              },
            }),
          };
        };
      },
    });
    const res = await call('POST', '/api/relay-rpc', { method: 'unbanpubkey', params: [PK] }, { ...(env() as object), DB: racingDb });

    expect(reads).toBeGreaterThan(0);
    expect(await record()).toMatchObject({ status: 'active', ends_at: OTHER });
    expect(res.json.suspension).toMatchObject({ state: 'unknown' });
    expect(fake.notifies).toHaveLength(0);
  });

  it('records a default timer restart without counting it as human handling', async () => {
    suspendedSetup();
    await seedRecord('cancelled_ban', FUTURE_END);
    const res = await unban();

    expect(res.json.suspension).toMatchObject({ state: 'resumed', endsAt: FUTURE_END });
    const rows = await decisions();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'resume_suspension_timer', moderator_pubkey: MOD });
    expect(rows[0].reason).toBe(
      `Unbanned; suspension resumed until ${formatSuspensionEnd(FUTURE_END)} (no choice sent; the ban had paused the timer)`);
    expect(isHumanHandling(rows[0])).toBe(false);
  });

  it('resume with an explicit choice writes a change_suspension_end decision naming the end', async () => {
    suspendedSetup();
    await seedRecord('active', FUTURE_END);
    const res = await unban('resume');

    expect((res.json.suspension as { decisionRecorded?: boolean }).decisionRecorded).toBe(true);
    const rows = await decisions();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'change_suspension_end', moderator_pubkey: MOD });
    expect(rows[0].reason).toBe(`Unbanned; suspension resumed until ${formatSuspensionEnd(FUTURE_END)}`);
  });

  it('resuming a cancelled_ban record makes it active with the same end', async () => {
    const fake = suspendedSetup();
    await seedRecord('cancelled_ban', FUTURE_END);
    const res = await unban('resume');

    expect(res.json.suspension).toMatchObject({ state: 'resumed', endsAt: FUTURE_END });
    expect(await record()).toMatchObject({ status: 'active', ends_at: FUTURE_END });
    expect(fake.notifies.map(n => n.action)).toEqual(['ACCOUNT_SUSPENSION_CHANGED']);
    // The explicit choice's own row only, not the default's as well.
    expect((await decisions()).map(r => r.reason)).toEqual([`Unbanned; suspension resumed until ${formatSuspensionEnd(FUTURE_END)}`]);
  });

  it('resuming a cancelled_ban record whose end is already past sends no message', async () => {
    const fake = suspendedSetup();
    await seedRecord('cancelled_ban', PAST_END);
    const res = await unban('resume');

    expect(res.json.suspension).toMatchObject({ state: 'resumed', endsAt: PAST_END });
    expect(await record()).toMatchObject({ status: 'active', ends_at: PAST_END });
    expect(fake.keycastPuts).toEqual([{ pubkey: PK, status: 'suspended', actor: MOD }]);
    expect(fake.notifies).toHaveLength(0);
  });

  it('resuming a cancelled_ban record with no end makes it active, with no message', async () => {
    const fake = suspendedSetup();
    await seedRecord('cancelled_ban', null);
    const res = await unban('resume');

    expect(res.json.suspension).toMatchObject({ state: 'resumed', endsAt: null });
    expect(await record()).toMatchObject({ status: 'active', ends_at: null });
    expect(fake.notifies).toHaveLength(0);
  });

  it('resume with no record suspends in Keycast only and writes no record', async () => {
    const fake = suspendedSetup();
    const res = await unban();

    expect(res.json.suspension).toMatchObject({ state: 'resumed', endsAt: null });
    expect(await record()).toBeNull();
    expect(fake.keycastPuts).toEqual([{ pubkey: PK, status: 'suspended', actor: MOD }]);
    expect(fake.notifies).toHaveLength(0);
  });

  it('open_ended clears the end, suspends in Keycast, sends ACCOUNT_SUSPENDED with no endsAt, and records the decision', async () => {
    const fake = suspendedSetup();
    await seedRecord('cancelled_ban', FUTURE_END);
    const res = await unban('open_ended');

    expect(res.json.suspension).toMatchObject({ state: 'open_ended', endsAt: null });
    expect(await record()).toMatchObject({ status: 'active', ends_at: null });
    expect(fake.keycastPuts).toEqual([{ pubkey: PK, status: 'suspended', actor: MOD }]);
    expect(fake.notifies).toHaveLength(1);
    expect(fake.notifies[0]).toMatchObject({ action: 'ACCOUNT_SUSPENDED', recipientPubkey: PK });
    expect('endsAt' in fake.notifies[0]).toBe(false);
    const rows = await decisions();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'change_suspension_end', reason: 'Unbanned; suspended with no end date' });
  });

  it('open_ended with no record creates an open-ended one', async () => {
    suspendedSetup();
    await unban('open_ended');
    expect(await record()).toMatchObject({ status: 'active', ends_at: null });
  });

  it('end_now lifts the suspension: relay unsuspend, record cancelled_unsuspend, one RESTORED, Keycast active, decision row', async () => {
    const fake = suspendedSetup();
    await seedRecord('cancelled_ban', FUTURE_END);
    const res = await unban('end_now');

    expect(res.status).toBe(200);
    expect(res.json.suspension).toMatchObject({ state: 'ended' });
    expect(fake.relayWrites().map(c => c.method)).toEqual(['unbanpubkey', 'unsuspendpubkey']);
    expect(await record()).toMatchObject({ status: 'cancelled_unsuspend' });
    expect(fake.notifies.map(n => n.action)).toEqual(['ACCOUNT_RESTORED']);
    expect(fake.keycastPuts).toEqual([{ pubkey: PK, status: 'active', actor: MOD }]);
    const rows = await decisions();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'unsuspend_user', reason: 'Unbanned; suspension ended' });
  });

  it('end_now where the relay unsuspend fails: 200, end_failed, Keycast suspended, record still in force', async () => {
    const fake = suspendedSetup({ fail: { unsuspendpubkey: true } });
    await seedRecord('cancelled_ban', FUTURE_END);
    const res = await unban('end_now');

    expect(res.status).toBe(200);
    expect(res.json.success).toBe(true);
    expect(res.json.suspension).toMatchObject({ state: 'end_failed' });
    expect(fake.keycastPuts).toEqual([{ pubkey: PK, status: 'suspended', actor: MOD }]);
    expect(await record()).toMatchObject({ status: 'cancelled_ban' });
    expect(fake.notifies).toHaveLength(0);
    expect(await decisions()).toHaveLength(0);
  });

  it.each(['resume', 'open_ended'])('%s while the timer is lifting (F7): nothing changes, no message, state unknown', async (choice) => {
    const fake = suspendedSetup();
    await seedRecord('lifting', FUTURE_END);
    const res = await unban(choice);

    expect(res.status).toBe(200);
    expect(res.json.suspension).toMatchObject({ state: 'unknown' });
    expect(await record()).toMatchObject({ status: 'lifting', ends_at: FUTURE_END });
    expect(fake.keycastPuts).toHaveLength(0);
    expect(fake.notifies).toHaveLength(0);
    expect(await decisions()).toHaveLength(0);
  });

  it('open_ended losing a version race (F7 conflict): nothing further, state unknown', async () => {
    const fake = suspendedSetup();
    await seedRecord('active', FUTURE_END);
    // A concurrent edit lands between changeSuspensionEnd's read and its guarded write.
    let bumped = false;
    const racingDb = new Proxy(DB, {
      get(target, prop) {
        if (prop !== 'prepare') return Reflect.get(target, prop).bind?.(target) ?? Reflect.get(target, prop);
        return (sql: string) => {
          const stmt = target.prepare(sql);
          if (bumped || !sql.includes('UPDATE timed_suspensions') || !sql.includes('AND version = ?')) return stmt;
          return {
            bind: (...args: unknown[]) => ({
              run: async () => {
                bumped = true;
                await target.prepare('UPDATE timed_suspensions SET version = version + 1 WHERE pubkey = ?').bind(PK).run();
                return stmt.bind(...args).run();
              },
            }),
          };
        };
      },
    });
    const res = await call('POST', '/api/relay-rpc',
      { method: 'unbanpubkey', params: [PK], suspensionChoice: 'open_ended' }, { ...(env() as object), DB: racingDb });
    expect(bumped).toBe(true);

    expect(res.json.suspension).toMatchObject({ state: 'unknown' });
    expect(fake.keycastPuts).toHaveLength(0);
    expect(fake.notifies).toHaveLength(0);
  });

  it('a non-canonical target skips the choice (F8): only the unban runs, and the response says so', async () => {
    const UPPER = PK.toUpperCase();
    const fake = setup({
      banned: new Set([UPPER]), suspended: new Map([[PK, 'policy']]), keycast: new Map([[UPPER, 'banned']]),
    });
    const res = await rpc({ method: 'unbanpubkey', params: [UPPER], suspensionChoice: 'end_now' });

    expect(res.status).toBe(200);
    expect(res.json.suspension).toBeUndefined();
    expect(res.json.suspensionChoiceSkipped).toBe('non_canonical_pubkey');
    expect(fake.relayWrites().map(c => c.method)).toEqual(['unbanpubkey']);
    // Keycast refuses a non-canonical pubkey outright, so today's call changes nothing either.
    expect(fake.keycastPuts.every(p => p.status !== 'suspended')).toBe(true);
    expect(fake.notifies).toHaveLength(0);
    expect(fake.state.suspended.has(PK)).toBe(true);
  });

  it('an invalid suspensionChoice is refused with 400 before the relay is called', async () => {
    const fake = bannedSetup();
    const res = await unban('bogus');

    expect(res.status).toBe(400);
    expect(res.json.code).toBe('invalid_suspension_choice');
    expect(fake.rpcCalls).toHaveLength(0);
    expect(fake.keycastPuts).toHaveLength(0);
  });

  it('the age-review guard still refuses an unban with an open case', async () => {
    const fake = suspendedSetup();
    await seedAgeCase();
    const res = await unban('end_now');

    expect(res.status).toBe(409);
    expect(fake.relayWrites()).toHaveLength(0);
  });
});
