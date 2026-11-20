// ABOUTME: Real-D1 route tests for suspending with an end time over /api/relay-rpc, and for
// ABOUTME: a manual unsuspend cancelling the timer. Relay, Keycast and notify are faked.
import { Miniflare } from 'miniflare';
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import worker from '../src/index';
import { ensureSchema } from '../src/db';
import { DURATION_ERROR, suspensionEndsAt } from '../../shared/suspension';
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
