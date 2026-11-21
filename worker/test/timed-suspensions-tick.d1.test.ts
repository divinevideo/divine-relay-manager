// ABOUTME: Real-D1 tests for the timed-suspension scheduler tick: due lifts, ban and age-review
// ABOUTME: holds, moderator races, retries, stale-claim recovery and alerts, over a fake SuspensionIo.
import { Miniflare } from 'miniflare';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { ensureSchema } from '../src/db';
import {
  applyUnbanChoice, endSuspensionRecord, replaceSuspensionRecord, runTimedSuspensionTick, TICK_BATCH,
  type SuspensionIo, type SuspensionRecord,
} from '../src/timed-suspensions';

const PK = 'e5'.repeat(32);
const PK2 = 'f6'.repeat(32);

// A same-day literal: a lexical compare of ISO ends_at ('T') against datetime(now) (' ')
// would wrongly read 13:59 as later than 14:00 on the same day (Review Focus 1).
const NOW = new Date('2026-11-20T14:00:00.000Z');
const ONE_MIN_AGO = '2026-11-20T13:59:00.000Z';
const ONE_MIN_AHEAD = '2026-11-20T14:01:00.000Z';
const at = (minutesFromNow: number) => new Date(NOW.getTime() + minutesFromNow * 60_000);

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
beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  await DB.prepare('DELETE FROM timed_suspensions').run();
  await DB.prepare('DELETE FROM moderation_decisions').run();
  await DB.prepare('DELETE FROM moderation_targets').run();
});

const env = () => ({ DB, ENVIRONMENT: 'test' });

type Seed = Partial<Pick<SuspensionRecord,
  'status' | 'ends_at' | 'attempts' | 'last_error' | 'last_attempt_at' | 'last_alerted_at' | 'claimed_at' | 'version'>>;
async function seed(pubkey: string, s: Seed = {}) {
  await DB.prepare(`
    INSERT INTO timed_suspensions
      (pubkey, ends_at, status, set_by, set_at, version, attempts, last_error, last_attempt_at, last_alerted_at, claimed_at)
    VALUES (?, ?, ?, NULL, '2026-11-01T00:00:00.000Z', ?, ?, ?, ?, ?, ?)
  `).bind(
    pubkey, s.ends_at === undefined ? ONE_MIN_AGO : s.ends_at, s.status ?? 'active', s.version ?? 1,
    s.attempts ?? 0, s.last_error ?? null, s.last_attempt_at ?? null, s.last_alerted_at ?? null, s.claimed_at ?? null,
  ).run();
}
const record = (pubkey = PK) =>
  DB.prepare('SELECT * FROM timed_suspensions WHERE pubkey = ?').bind(pubkey).first<SuspensionRecord>();
const decisions = async (pubkey = PK) => (await DB.prepare(
  'SELECT action, reason, moderator_pubkey FROM moderation_decisions WHERE target_id = ? ORDER BY id',
).bind(pubkey).all<{ action: string; reason: string; moderator_pubkey: string | null }>()).results;
const humanReviewed = async (pubkey = PK) => (await DB.prepare(
  'SELECT COUNT(*) AS n FROM moderation_targets WHERE target_id = ?',
).bind(pubkey).first<{ n: number }>())!.n;

type FakeIo = { [K in keyof SuspensionIo]: ReturnType<typeof vi.fn> & SuspensionIo[K] };
function fakeIo(over: Partial<SuspensionIo> = {}): FakeIo {
  const base: SuspensionIo = {
    readBan: async () => false,
    readSuspension: async () => ({ suspended: true, reason: 'policy' }),
    readKeycastStatus: async () => 'suspended',
    hasOpenAgeReviewCase: async () => false,
    relayUnsuspend: async () => ({ success: true }),
    keycastActivate: async () => ({ success: true }),
    keycastSuspend: async () => ({ success: true }),
    notify: async () => {},
    alert: async () => true,
  };
  const merged = { ...base, ...over };
  return Object.fromEntries(
    Object.entries(merged).map(([k, fn]) => [k, vi.fn(fn as (...a: unknown[]) => unknown)]),
  ) as unknown as FakeIo;
}

// Answers in order; the last one repeats. Each entry may be a function, run at that call.
function inTurn<T>(...answers: Array<T | (() => Promise<T>)>): () => Promise<T> {
  let i = 0;
  return async () => {
    const a = answers[Math.min(i++, answers.length - 1)];
    return typeof a === 'function' ? (a as () => Promise<T>)() : a;
  };
}

// A moderator re-suspends the account (B4's write), as it would land mid-tick.
const reSuspend = () => replaceSuspensionRecord(DB, { pubkey: PK, endsAt: '2026-12-01T00:00:00.000Z', moderator: 'ab'.repeat(32) });

// Nothing that would unsuspend, restore or tell the person happened.
function expectNoLift(io: FakeIo) {
  expect(io.relayUnsuspend).not.toHaveBeenCalled();
  expect(io.notify).not.toHaveBeenCalled();
  expect(io.keycastActivate).not.toHaveBeenCalled();
}

describe('scheduler batch fairness', () => {
  const earlierPubkeys = Array.from({ length: TICK_BATCH }, (_, i) => i.toString(16).padStart(64, '0'));

  it('reaches due rows beyond a full batch of age-review holds', async () => {
    await Promise.all(earlierPubkeys.map(pubkey => seed(pubkey, { ends_at: at(-2).toISOString() })));
    await seed(PK2);
    const io = fakeIo({ hasOpenAgeReviewCase: async pubkey => pubkey !== PK2 });

    expect((await runTimedSuspensionTick(env(), io, NOW)).waiting).toBe(TICK_BATCH);
    await runTimedSuspensionTick(env(), io, at(5));

    expect(io.relayUnsuspend.mock.calls).toEqual([[PK2]]);
    expect(await record(PK2)).toMatchObject({ status: 'lifted' });
    expect(await record(earlierPubkeys[0])).toMatchObject({ status: 'active', attempts: 0 });
  });

  it('reaches a Keycast retry beyond a full batch of age-review holds', async () => {
    await Promise.all(earlierPubkeys.map(pubkey => seed(pubkey, { status: 'keycast_pending' })));
    await seed(PK2, { status: 'keycast_pending' });
    const io = fakeIo({ hasOpenAgeReviewCase: async pubkey => pubkey !== PK2 });

    await runTimedSuspensionTick(env(), io, NOW);
    expect(io.keycastActivate).not.toHaveBeenCalled();
    await runTimedSuspensionTick(env(), io, at(5));

    expect(io.keycastActivate.mock.calls).toEqual([[PK2]]);
    expect(await record(PK2)).toMatchObject({ status: 'lifted' });
  });

  it('reaches a stale claim beyond a full batch of failed recoveries', async () => {
    const oldest = { status: 'lifting', claimed_at: at(-20).toISOString() } as const;
    await Promise.all(earlierPubkeys.map(pubkey => seed(pubkey, oldest)));
    await seed(PK2, { status: 'lifting', claimed_at: at(-16).toISOString() });
    const io = fakeIo({ readSuspension: async pubkey => pubkey === PK2 ? { suspended: false } : 'unknown' });

    expect((await runTimedSuspensionTick(env(), io, NOW)).recovered).toBe(0);
    expect((await runTimedSuspensionTick(env(), io, at(5))).recovered).toBe(1);
    expect(await record(PK2)).toMatchObject({ status: 'lifted' });
  });
});

describe('due lifts', () => {
  it('lifts a record that ended one minute ago today', async () => {
    await seed(PK);
    const io = fakeIo();

    const summary = await runTimedSuspensionTick(env(), io, NOW);

    expect(io.relayUnsuspend).toHaveBeenCalledTimes(1);
    expect(io.relayUnsuspend).toHaveBeenCalledWith(PK);
    expect(io.notify).toHaveBeenCalledTimes(1);
    expect(io.notify.mock.calls[0][0]).toBe(PK);
    expect(io.notify.mock.calls[0][1]).toBe('ACCOUNT_RESTORED');
    // The restored message carries no end time.
    expect(io.notify.mock.calls[0][3]).toBeUndefined();
    expect(io.keycastActivate).toHaveBeenCalledTimes(1);
    expect((await record())!.status).toBe('lifted');
    expect(await decisions()).toEqual([
      { action: 'auto_unsuspend_user', reason: 'Timed suspension ended', moderator_pubkey: null },
    ]);
    // The timer is not a human decision.
    expect(await humanReviewed()).toBe(0);
    expect(summary).toMatchObject({ lifted: 1, failed: 0 });
  });

  it('leaves a record ending one minute from now alone', async () => {
    await seed(PK, { ends_at: ONE_MIN_AHEAD });
    const io = fakeIo();

    await runTimedSuspensionTick(env(), io, NOW);

    expect(io.readBan).not.toHaveBeenCalled();
    expectNoLift(io);
    expect((await record())).toMatchObject({ status: 'active', attempts: 0, version: 1 });
  });

  it('leaves an open-ended suspension alone', async () => {
    await seed(PK, { ends_at: null });
    const io = fakeIo();

    await runTimedSuspensionTick(env(), io, NOW);

    expect(io.readBan).not.toHaveBeenCalled();
    expect((await record())).toMatchObject({ status: 'active', version: 1 });
  });

  it('treats Keycast "no account" as a finished restore', async () => {
    await seed(PK);
    const io = fakeIo({ keycastActivate: async () => ({ success: false, notFound: true }) });

    await runTimedSuspensionTick(env(), io, NOW);

    expect((await record())!.status).toBe('lifted');
    expect(io.notify).toHaveBeenCalledTimes(1);
  });
});

describe('ban checks', () => {
  it.each([
    ['on the relay', { readBan: async () => true }],
    ['in Keycast', { readKeycastStatus: async () => 'banned' as const }],
  ])('a ban %s cancels the timer with no lift, message or Keycast change', async (_label, over) => {
    await seed(PK);
    const io = fakeIo(over as Partial<SuspensionIo>);

    const summary = await runTimedSuspensionTick(env(), io, NOW);

    expectNoLift(io);
    expect((await record())).toMatchObject({ status: 'cancelled_ban', attempts: 0 });
    expect(await decisions()).toEqual([
      { action: 'cancel_suspension_timer', reason: 'Account is banned', moderator_pubkey: null },
    ]);
    expect(await humanReviewed()).toBe(0);
    expect(summary.cancelledByBan).toBe(1);
  });

  it('a Keycast ban wins over a ban read that throws', async () => {
    await seed(PK);
    const io = fakeIo({
      readBan: async () => { throw new Error('relay socket'); },
      readKeycastStatus: async () => 'banned',
    });

    await runTimedSuspensionTick(env(), io, NOW);

    expectNoLift(io);
    expect((await record())!.status).toBe('cancelled_ban');
  });

  it('a known ban wins over an unreadable Keycast status', async () => {
    await seed(PK);
    const io = fakeIo({ readBan: async () => true, readKeycastStatus: async () => 'unknown' });

    await runTimedSuspensionTick(env(), io, NOW);

    expect((await record())!.status).toBe('cancelled_ban');
  });

  it.each([
    ['ban list', { readBan: async () => 'unknown' as const }],
    ['Keycast status', { readKeycastStatus: async () => 'unknown' as const }],
    ['suspended list', { readSuspension: async () => 'unknown' as const }],
    ['age-review check', { hasOpenAgeReviewCase: async () => { throw new Error('db down'); } }],
    ['age-review answer (not a boolean)', { hasOpenAgeReviewCase: async () => undefined as unknown as boolean }],
    ['Keycast status (unexpected value)', { readKeycastStatus: async () => 'deleted' as never }],
    ['ban list (read throws)', { readBan: async () => { throw new Error('relay socket'); } }],
    ['Keycast status (read throws)', { readKeycastStatus: async () => { throw new Error('keycast socket'); } }],
  ])('an unreadable %s counts an attempt and lifts nothing', async (_label, over) => {
    await seed(PK);
    const io = fakeIo(over as Partial<SuspensionIo>);

    const summary = await runTimedSuspensionTick(env(), io, NOW);

    expectNoLift(io);
    const row = (await record())!;
    expect(row).toMatchObject({ status: 'active', attempts: 1, last_attempt_at: NOW.toISOString() });
    expect(row.last_error).toBeTruthy();
    expect(await decisions()).toEqual([]);
    expect(summary.failed).toBe(1);
  });
});

describe('holds and already-lifted', () => {
  it('waits while an age-review case is open, with no attempt counted', async () => {
    await seed(PK);
    const io = fakeIo({ hasOpenAgeReviewCase: async () => true });

    const summary = await runTimedSuspensionTick(env(), io, NOW);

    expectNoLift(io);
    expect(io.readSuspension).not.toHaveBeenCalled();
    expect((await record())).toMatchObject({ status: 'active', attempts: 0, last_error: null, last_attempt_at: NOW.toISOString() });
    expect(io.alert).not.toHaveBeenCalled();
    expect(summary.waiting).toBe(1);
  });

  it('marks a record already lifted when the relay no longer suspends the account, with no message or Keycast change', async () => {
    await seed(PK);
    const io = fakeIo({ readSuspension: async () => ({ suspended: false }) });

    const summary = await runTimedSuspensionTick(env(), io, NOW);

    expectNoLift(io);
    expect((await record())!.status).toBe('already_lifted');
    expect(await decisions()).toEqual([
      { action: 'cancel_suspension_timer', reason: 'Account was no longer suspended', moderator_pubkey: null },
    ]);
    expect(summary.alreadyLifted).toBe(1);
  });

  it('never lifts a suspended row whose reason is age_review', async () => {
    await seed(PK);
    const io = fakeIo({ readSuspension: async () => ({ suspended: true, reason: 'age_review' }) });

    await runTimedSuspensionTick(env(), io, NOW);

    expectNoLift(io);
    expect((await record())).toMatchObject({ status: 'active', attempts: 1, last_error: 'age_review row' });
  });
});

describe('moderator races', () => {
  it('skips the row when its version moved between read and claim', async () => {
    await seed(PK);
    const io = fakeIo({
      hasOpenAgeReviewCase: async () => {
        await DB.prepare('UPDATE timed_suspensions SET version = version + 1 WHERE pubkey = ?').bind(PK).run();
        return false;
      },
    });

    await runTimedSuspensionTick(env(), io, NOW);

    expectNoLift(io);
    expect((await record())).toMatchObject({ status: 'active', attempts: 0, claimed_at: null, version: 2 });
  });

  it('sends no message when a manual unsuspend lands between the relay lift and the post-lift CAS', async () => {
    await seed(PK);
    const io = fakeIo({
      relayUnsuspend: async () => {
        // The moderator's Unsuspend ends the record (and sends its own message) first.
        await endSuspensionRecord(DB, PK, 'cancelled_unsuspend');
        return { success: true };
      },
    });

    await runTimedSuspensionTick(env(), io, NOW);

    expect(io.relayUnsuspend).toHaveBeenCalledTimes(1);
    expect(io.notify).not.toHaveBeenCalled();
    expect(io.keycastActivate).not.toHaveBeenCalled();
    expect((await record())!.status).toBe('cancelled_unsuspend');
    expect(await decisions()).toEqual([]);
  });

  it('an unban that sees the lift land during the relay call leaves it to the tick: one message, one row', async () => {
    await seed(PK);
    // The unban reads the relay after the tick's unsuspend landed, so it finds the account
    // unsuspended and sends no message of its own.
    const unbanIo = fakeIo({ readSuspension: async () => ({ suspended: false }) });
    const io = fakeIo({
      relayUnsuspend: async () => {
        await applyUnbanChoice(DB, unbanIo, PK, undefined, { now: NOW });
        return { success: true };
      },
    });

    const summary = await runTimedSuspensionTick(env(), io, NOW);

    expect(unbanIo.notify).not.toHaveBeenCalled();
    expect(io.notify).toHaveBeenCalledTimes(1);
    expect(io.notify.mock.calls[0].slice(0, 2)).toEqual([PK, 'ACCOUNT_RESTORED']);
    expect(io.keycastActivate).toHaveBeenCalledTimes(1);
    expect((await record())!.status).toBe('lifted');
    expect(await decisions()).toEqual([
      { action: 'auto_unsuspend_user', reason: 'Timed suspension ended', moderator_pubkey: null },
    ]);
    expect(summary.lifted).toBe(1);
  });

  // An unban whose record moved during its relay unban sets Keycast suspended. A tick that read
  // the row before that must not go on to lift it: its Keycast activate could land before the
  // unban's suspend, leaving the account lifted on the relay and suspended in Keycast with
  // nothing to repair it. The unban bumps the version, so that tick loses its claim.
  it('a tick that read the row before an unban\'s Keycast suspend loses its claim', async () => {
    // The dialog showed version 1. A change moved the row to 2 during the relay unban, and
    // this tick selected it at 2.
    await seed(PK, { version: 2 });
    const unbanIo = fakeIo();
    let unbanState: string | undefined;
    const io = fakeIo({
      hasOpenAgeReviewCase: async () => {
        const res = await applyUnbanChoice(DB, unbanIo, PK, 'resume', { now: NOW, shownVersion: 1 });
        await Promise.all(res.waitUntil);
        unbanState = res.state;
        return false;
      },
    });

    await runTimedSuspensionTick(env(), io, NOW);

    expect(unbanState).toBe('changed');
    expect(unbanIo.keycastSuspend).toHaveBeenCalledTimes(1);
    expectNoLift(io);
    expect(await record()).toMatchObject({ status: 'active', claimed_at: null });
  });

  it('the same unban landing after the post-lift CAS (keycast_pending) still gets the one message', async () => {
    await seed(PK);
    const unbanIo = fakeIo({ readSuspension: async () => ({ suspended: false }) });
    const io = fakeIo({
      // The first call is the pre-lift hold check; the second is clearToRestore's re-check,
      // after the record went keycast_pending and before its record re-read.
      hasOpenAgeReviewCase: inTurn<boolean>(false, async () => {
        await applyUnbanChoice(DB, unbanIo, PK, undefined, { now: NOW });
        return false;
      }),
    });

    await runTimedSuspensionTick(env(), io, NOW);

    expect(io.hasOpenAgeReviewCase).toHaveBeenCalledTimes(2);
    expect(unbanIo.notify).not.toHaveBeenCalled();
    expect(io.notify).toHaveBeenCalledTimes(1);
    expect(io.notify.mock.calls[0].slice(0, 2)).toEqual([PK, 'ACCOUNT_RESTORED']);
    expect((await record())!.status).toBe('lifted');
    expect(await decisions()).toEqual([
      { action: 'auto_unsuspend_user', reason: 'Timed suspension ended', moderator_pubkey: null },
    ]);
  });
});

describe('failures and retries', () => {
  it('a relay failure returns the record to active with attempts + 1', async () => {
    await seed(PK);
    const io = fakeIo({ relayUnsuspend: async () => ({ success: false, error: 'relay said no' }) });

    const summary = await runTimedSuspensionTick(env(), io, NOW);

    expect(io.notify).not.toHaveBeenCalled();
    expect(io.keycastActivate).not.toHaveBeenCalled();
    const row = (await record())!;
    expect(row).toMatchObject({ status: 'active', attempts: 1, claimed_at: null, last_attempt_at: NOW.toISOString() });
    expect(row.last_error).toContain('relay said no');
    expect(await decisions()).toEqual([]);
    expect(summary).toMatchObject({ lifted: 0, failed: 1 });
  });

  it('a relay answer with no success flag counts as a failure', async () => {
    await seed(PK);
    const io = fakeIo({ relayUnsuspend: async () => undefined as never });

    await runTimedSuspensionTick(env(), io, NOW);

    expect(io.notify).not.toHaveBeenCalled();
    expect((await record())).toMatchObject({ status: 'active', attempts: 1, claimed_at: null });
  });

  it('a relay call that throws returns the record to active with attempts + 1', async () => {
    await seed(PK);
    const io = fakeIo({ relayUnsuspend: async () => { throw new Error('socket closed'); } });

    await runTimedSuspensionTick(env(), io, NOW);

    expect(io.notify).not.toHaveBeenCalled();
    const row = (await record())!;
    expect(row).toMatchObject({ status: 'active', attempts: 1, claimed_at: null });
    expect(row.last_error).toContain('socket closed');
  });

  // I2: a relay call that reports failure (a timeout, say) may still have landed, so the
  // suspended list is read back before deciding.
  it('a relay failure the read-back shows landed continues the lift: one message, Keycast, lifted', async () => {
    await seed(PK);
    const io = fakeIo({
      relayUnsuspend: async () => ({ success: false, error: 'timeout after 15000ms' }),
      readSuspension: inTurn<Awaited<ReturnType<SuspensionIo['readSuspension']>>>(
        { suspended: true, reason: 'policy' }, { suspended: false }),
    });

    const summary = await runTimedSuspensionTick(env(), io, NOW);

    expect(io.readSuspension).toHaveBeenCalledTimes(2);
    expect(io.notify).toHaveBeenCalledTimes(1);
    expect(io.notify.mock.calls[0][1]).toBe('ACCOUNT_RESTORED');
    expect(io.keycastActivate).toHaveBeenCalledTimes(1);
    expect((await record())!.status).toBe('lifted');
    expect(await decisions()).toEqual([
      { action: 'auto_unsuspend_user', reason: 'Timed suspension ended', moderator_pubkey: null },
    ]);
    expect(summary).toMatchObject({ lifted: 1, failed: 0 });
  });

  it('a relay failure whose read-back is still suspended reverts to active with attempts + 1', async () => {
    await seed(PK);
    const io = fakeIo({
      relayUnsuspend: async () => ({ success: false, error: 'timeout after 15000ms' }),
      readSuspension: inTurn<Awaited<ReturnType<SuspensionIo['readSuspension']>>>(
        { suspended: true, reason: 'policy' }, { suspended: true, reason: 'policy' }),
    });

    await runTimedSuspensionTick(env(), io, NOW);

    expect(io.readSuspension).toHaveBeenCalledTimes(2);
    expectNoLift({ ...io, relayUnsuspend: vi.fn() } as FakeIo);
    expect((await record())).toMatchObject({ status: 'active', attempts: 1, claimed_at: null });
    expect(await decisions()).toEqual([]);
  });

  // The unsuspend may have landed, so the row is not put back to active (the next Phase 1 would
  // then find it not suspended and mark it already_lifted silently). It stays 'lifting' and
  // Phase 0 settles it by a relay read once the claim is stale, and alerts.
  it.each([
    ['unreadable', async () => 'unknown' as const],
    ['a throw', async () => { throw new Error('relay socket'); }],
  ])('a relay failure whose read-back is %s stays lifting; Phase 0 later settles it and alerts', async (_label, back) => {
    await seed(PK);
    const io = fakeIo({
      relayUnsuspend: async () => ({ success: false, error: 'timeout after 15000ms' }),
      readSuspension: inTurn<Awaited<ReturnType<SuspensionIo['readSuspension']>>>(
        { suspended: true, reason: 'policy' }, back as never, { suspended: false }),
    });

    const first = await runTimedSuspensionTick(env(), io, NOW);

    expect(io.readSuspension).toHaveBeenCalledTimes(2);
    expectNoLift({ ...io, relayUnsuspend: vi.fn() } as FakeIo);
    const row = (await record())!;
    expect(row).toMatchObject({ status: 'lifting', attempts: 1, claimed_at: NOW.toISOString() });
    expect(row.last_error).toContain('read-back unreadable');
    expect(await decisions()).toEqual([]);
    expect(first.failed).toBe(1);

    // Inside the stale window nothing touches it.
    await runTimedSuspensionTick(env(), io, at(10));
    expect((await record())!.status).toBe('lifting');
    expect(io.readSuspension).toHaveBeenCalledTimes(2);

    // Once stale, Phase 0 reads the relay: the lift had landed, so Keycast is finished, the
    // decision row written, and an alert says the message may not have gone out.
    await runTimedSuspensionTick(env(), io, at(16));
    expect(io.relayUnsuspend).toHaveBeenCalledTimes(1);
    expect(io.notify).not.toHaveBeenCalled();
    expect(io.keycastActivate).toHaveBeenCalledTimes(1);
    expect((await record())!.status).toBe('lifted');
    expect(await decisions()).toHaveLength(1);
    expect(io.alert).toHaveBeenCalledTimes(1);
    expect(io.alert.mock.calls[0][0]).toContain('restored message may not have gone out');
  });

  it('checks a newly due row before a row that failed more recently', async () => {
    await seed(PK, { ends_at: '2026-11-20T12:00:00.000Z', attempts: 2, last_attempt_at: at(-1).toISOString() });
    await seed(PK2, { ends_at: at(-2).toISOString(), attempts: 0 });
    const io = fakeIo();

    await runTimedSuspensionTick(env(), io, NOW);

    expect(io.relayUnsuspend.mock.calls.map(c => c[0])).toEqual([PK2, PK]);
  });

  it('a Keycast failure after the lift leaves keycast_pending, and three ticks send exactly one message, the third succeeding', async () => {
    await seed(PK);
    let calls = 0;
    const io = fakeIo({
      keycastActivate: async () => (++calls < 3 ? { success: false, error: 'keycast 502' } : { success: true }),
    });

    await runTimedSuspensionTick(env(), io, NOW);
    expect((await record())).toMatchObject({ status: 'keycast_pending', attempts: 1 });
    expect(await decisions()).toHaveLength(1);

    await runTimedSuspensionTick(env(), io, at(5));
    expect((await record())).toMatchObject({ status: 'keycast_pending', attempts: 2 });

    const third = await runTimedSuspensionTick(env(), io, at(10));
    expect((await record())!.status).toBe('lifted');
    expect(third.keycastSettled).toBe(1);

    expect(io.relayUnsuspend).toHaveBeenCalledTimes(1);
    expect(io.notify).toHaveBeenCalledTimes(1);
    expect(io.keycastActivate).toHaveBeenCalledTimes(3);
    expect(await decisions()).toEqual([
      { action: 'auto_unsuspend_user', reason: 'Timed suspension ended', moderator_pubkey: null },
    ]);
  });

  it('the Keycast retry takes rows that last tried at the same time in pubkey order', async () => {
    // Seeded out of pubkey order, so only the pubkey tiebreak puts PK first.
    await seed(PK2, { status: 'keycast_pending', last_attempt_at: at(-5).toISOString() });
    await seed(PK, { status: 'keycast_pending', last_attempt_at: at(-5).toISOString() });
    const io = fakeIo();

    await runTimedSuspensionTick(env(), io, NOW);

    expect(io.keycastActivate.mock.calls.map(c => c[0])).toEqual([PK, PK2]);
  });

  it('the Keycast retry does not activate a newly banned account', async () => {
    await seed(PK, { status: 'keycast_pending', attempts: 1 });
    const io = fakeIo({ readBan: async () => true });

    await runTimedSuspensionTick(env(), io, NOW);

    expect(io.keycastActivate).not.toHaveBeenCalled();
    expect(io.notify).not.toHaveBeenCalled();
    expect((await record())!.status).toBe('lifted');
  });

  it('the Keycast retry does nothing on an unreadable ban list', async () => {
    await seed(PK, { status: 'keycast_pending', attempts: 1 });
    const io = fakeIo({ readBan: async () => 'unknown' });

    await runTimedSuspensionTick(env(), io, NOW);

    expect(io.keycastActivate).not.toHaveBeenCalled();
    expect((await record())).toMatchObject({ status: 'keycast_pending', attempts: 2 });
  });

  it('the Keycast retry waits while an age-review case is open', async () => {
    await seed(PK, { status: 'keycast_pending', attempts: 1 });
    const io = fakeIo({ hasOpenAgeReviewCase: async () => true });

    await runTimedSuspensionTick(env(), io, NOW);

    expect(io.keycastActivate).not.toHaveBeenCalled();
    expect((await record())).toMatchObject({ status: 'keycast_pending', attempts: 1 });
  });

  it.each([['active'], ['banned'], ['none']] as const)(
    'the Keycast retry settles without a call when Keycast reads %s', async (status) => {
      await seed(PK, { status: 'keycast_pending', attempts: 1 });
      const io = fakeIo({ readKeycastStatus: async () => status });

      await runTimedSuspensionTick(env(), io, NOW);

      expect(io.keycastActivate).not.toHaveBeenCalled();
      expect((await record())!.status).toBe('lifted');
    });

  it('the Keycast retry does nothing on an unreadable Keycast status', async () => {
    await seed(PK, { status: 'keycast_pending', attempts: 1 });
    const io = fakeIo({ readKeycastStatus: async () => 'unknown' });

    await runTimedSuspensionTick(env(), io, NOW);

    expect(io.keycastActivate).not.toHaveBeenCalled();
    expect((await record())).toMatchObject({ status: 'keycast_pending', attempts: 2 });
  });
});

// I1: a ban or a moderator change landing between the tick's first reads and its action must
// never get a restored message or a Keycast activate (banpubkey never touches the record).
describe('re-check immediately before restoring', () => {
  describe('Phase 1, before the restored message and Keycast', () => {
    it('a ban landing in the window: no message, no Keycast activate, left for retry; the next tick settles it', async () => {
      await seed(PK);
      const io = fakeIo({ readBan: inTurn<boolean | 'unknown'>(false, true) });

      await runTimedSuspensionTick(env(), io, NOW);

      expect(io.relayUnsuspend).toHaveBeenCalledTimes(1);
      expect(io.readBan).toHaveBeenCalledTimes(2);
      expect(io.notify).not.toHaveBeenCalled();
      expect(io.keycastActivate).not.toHaveBeenCalled();
      expect((await record())).toMatchObject({ status: 'keycast_pending', attempts: 1 });
      // A banned account needs no restored message, so nothing to send by hand.
      expect(io.alert).not.toHaveBeenCalled();

      // Phase 2 sees the ban and finishes with no Keycast call and no message.
      await runTimedSuspensionTick(env(), io, at(5));
      expect(io.keycastActivate).not.toHaveBeenCalled();
      expect(io.notify).not.toHaveBeenCalled();
      expect((await record())!.status).toBe('lifted');
    });

    it('a re-suspend landing in the window: no message, no Keycast activate, the moderator\'s record stands', async () => {
      await seed(PK);
      const io = fakeIo({ readBan: inTurn<boolean | 'unknown'>(false, async () => { await reSuspend(); return false; }) });

      await runTimedSuspensionTick(env(), io, NOW);

      expect(io.notify).not.toHaveBeenCalled();
      expect(io.keycastActivate).not.toHaveBeenCalled();
      expect((await record())).toMatchObject({ status: 'active', ends_at: '2026-12-01T00:00:00.000Z', attempts: 0 });
      expect(io.alert).not.toHaveBeenCalled();
    });

    // N1: the relay lift landed but the restored message is withheld. Phase 2 finishes Keycast
    // later without a message (decision 14), so the alert is the only way anyone learns the
    // person was never told.
    it.each([
      ['unreadable', 'unknown' as const],
      ['a throw', async () => { throw new Error('relay socket'); }],
    ])('a ban re-read that is %s: no message, no Keycast activate, an alert to send it by hand; the next tick lifts it silently', async (_label, second) => {
      await seed(PK);
      const io = fakeIo({ readBan: inTurn<boolean | 'unknown'>(false, second as never, false) });

      await runTimedSuspensionTick(env(), io, NOW);

      expect(io.notify).not.toHaveBeenCalled();
      expect(io.keycastActivate).not.toHaveBeenCalled();
      expect((await record())).toMatchObject({ status: 'keycast_pending', attempts: 1 });
      expect(io.alert).toHaveBeenCalledTimes(1);
      const lines = (io.alert.mock.calls[0][0] as string).split('\n');
      expect(lines[0]).toBe(':rotating_light: [test] 1 timed suspension(s) not lifting');
      expect(lines[1].startsWith(`• ${PK}: `)).toBe(true);
      expect(lines[1]).toContain('restored message was not sent');
      expect(lines[1]).toContain('send it by hand');

      // Phase 2 finishes Keycast and marks it lifted, never sending the message.
      await runTimedSuspensionTick(env(), io, at(5));
      expect(io.keycastActivate).toHaveBeenCalledTimes(1);
      expect(io.notify).not.toHaveBeenCalled();
      expect((await record())!.status).toBe('lifted');
    });
    // The age-review flow writes its case row, then suspends on the relay and in Keycast, and
    // never touches the timer record, so the version re-check cannot see a case that opens
    // after the tick's first age-review check. Restoring then would undo age review's Keycast
    // suspend and tell a possible minor they are restored.
    it.each([
      ['a case opening', true as const, 'an age-review case opened'],
      ['a case check with no answer', undefined, 'the age-review case check failed'],
      ['a case check that throws', async () => { throw new Error('d1 down'); }, 'the age-review case check failed'],
    ])('%s in the window, after the relay lift: no message, no Keycast activate, an alert to check the relay', async (_label, second, said) => {
      await seed(PK);
      const io = fakeIo({ hasOpenAgeReviewCase: inTurn<boolean>(false, second as never, true) });

      await runTimedSuspensionTick(env(), io, NOW);

      expect(io.relayUnsuspend).toHaveBeenCalledTimes(1);
      expect(io.hasOpenAgeReviewCase).toHaveBeenCalledTimes(2);
      expect(io.notify).not.toHaveBeenCalled();
      expect(io.keycastActivate).not.toHaveBeenCalled();
      const row = (await record())!;
      expect(row).toMatchObject({ status: 'keycast_pending', attempts: 1 });
      expect(row.last_error).toMatch(/^age-review (case open|check failed) before the restore/);
      expect(io.alert).toHaveBeenCalledTimes(1);
      const lines = (io.alert.mock.calls[0][0] as string).split('\n');
      expect(lines[0]).toBe(':rotating_light: [test] 1 timed suspension(s) not lifting');
      expect(lines[1].startsWith(`• ${PK}: keycast step, the relay lift landed but ${said} before the restore`)).toBe(true);
      expect(lines[1]).toContain('restored message was not sent');
      expect(lines[1]).toContain('Keycast was left as it is');
      expect(lines[1]).toContain('relay suspension');

      // While the case stays open, Phase 2 holds: still no Keycast activate and no message.
      await runTimedSuspensionTick(env(), io, at(5));
      expect(io.keycastActivate).not.toHaveBeenCalled();
      expect(io.notify).not.toHaveBeenCalled();
      expect((await record())).toMatchObject({ status: 'keycast_pending', attempts: 1 });
    });
  });

  describe('Phase 2, before Keycast activate', () => {
    it('a ban landing in the window: no Keycast activate, left for retry', async () => {
      await seed(PK, { status: 'keycast_pending', attempts: 1 });
      const io = fakeIo({ readBan: inTurn<boolean | 'unknown'>(false, true) });

      await runTimedSuspensionTick(env(), io, NOW);

      expect(io.readBan).toHaveBeenCalledTimes(2);
      expect(io.keycastActivate).not.toHaveBeenCalled();
      expect((await record())).toMatchObject({ status: 'keycast_pending', attempts: 2 });
    });

    it('a re-suspend landing in the window: no Keycast activate, the moderator\'s record stands', async () => {
      await seed(PK, { status: 'keycast_pending', attempts: 1 });
      const io = fakeIo({ readBan: inTurn<boolean | 'unknown'>(false, async () => { await reSuspend(); return false; }) });

      await runTimedSuspensionTick(env(), io, NOW);

      expect(io.keycastActivate).not.toHaveBeenCalled();
      expect((await record())).toMatchObject({ status: 'active', ends_at: '2026-12-01T00:00:00.000Z', attempts: 0 });
    });

    it('an age-review case opening in the window: no Keycast activate, an attempt counted, no hand-send alert', async () => {
      await seed(PK, { status: 'keycast_pending', attempts: 1 });
      const io = fakeIo({ hasOpenAgeReviewCase: inTurn<boolean>(false, true) });

      await runTimedSuspensionTick(env(), io, NOW);

      expect(io.hasOpenAgeReviewCase).toHaveBeenCalledTimes(2);
      expect(io.keycastActivate).not.toHaveBeenCalled();
      expect((await record())).toMatchObject({ status: 'keycast_pending', attempts: 2 });
      // Phase 2 never sends the message and the relay lift is long done, so nothing to hand over.
      expect(io.alert).not.toHaveBeenCalled();
    });

    it('an unreadable ban re-read: no Keycast activate, an attempt counted, no hand-send alert', async () => {
      await seed(PK, { status: 'keycast_pending', attempts: 1 });
      const io = fakeIo({ readBan: inTurn<boolean | 'unknown'>(false, 'unknown') });

      await runTimedSuspensionTick(env(), io, NOW);

      expect(io.keycastActivate).not.toHaveBeenCalled();
      expect((await record())).toMatchObject({ status: 'keycast_pending', attempts: 2 });
      // Phase 2 never sends the message, so it has nothing to hand over (attempts below 3).
      expect(io.alert).not.toHaveBeenCalled();
    });
  });
});

describe('recovery and alerts', () => {
  it('recovers a stale lifting claim that is still suspended back to active', async () => {
    await seed(PK, { status: 'lifting', claimed_at: at(-16).toISOString() });
    // Hold the row in Phase 1 so this test sees only the recovery.
    const io = fakeIo({ hasOpenAgeReviewCase: async () => true });

    const summary = await runTimedSuspensionTick(env(), io, NOW);

    expectNoLift(io);
    expect((await record())).toMatchObject({ status: 'active', claimed_at: null });
    expect(summary.recovered).toBe(1);
    expect(io.alert).toHaveBeenCalledTimes(1);
    expect(io.alert.mock.calls[0][0]).toContain(PK);
  });

  it('recovers a stale lifting claim whose lift landed to the Keycast step, and says the message may be missing', async () => {
    await seed(PK, { status: 'lifting', claimed_at: at(-16).toISOString() });
    const io = fakeIo({ readSuspension: async () => ({ suspended: false }) });

    const summary = await runTimedSuspensionTick(env(), io, NOW);

    expect(io.relayUnsuspend).not.toHaveBeenCalled();
    expect(io.notify).not.toHaveBeenCalled();
    // Phase 2 then finishes the Keycast step in the same tick.
    expect(io.keycastActivate).toHaveBeenCalledTimes(1);
    expect((await record())!.status).toBe('lifted');
    expect(summary.recovered).toBe(1);
    expect(io.alert).toHaveBeenCalledTimes(1);
    const text = io.alert.mock.calls[0][0] as string;
    expect(text).toContain(PK);
    expect(text).toContain('restored message may not have gone out');
    expect(await decisions()).toEqual([{
      action: 'auto_unsuspend_user',
      reason: 'Timed suspension ended (recovered; restored message may not have gone out)',
      moderator_pubkey: null,
    }]);
    expect(await humanReviewed()).toBe(0);
  });

  it('leaves a fresh lifting claim alone', async () => {
    await seed(PK, { status: 'lifting', claimed_at: at(-14).toISOString() });
    const io = fakeIo();

    await runTimedSuspensionTick(env(), io, NOW);

    expect(io.readSuspension).not.toHaveBeenCalled();
    expect((await record())).toMatchObject({ status: 'lifting', version: 1 });
  });

  it('a stale claim on an unreadable suspended list counts an attempt and stays lifting', async () => {
    await seed(PK, { status: 'lifting', claimed_at: at(-16).toISOString() });
    const io = fakeIo({ readSuspension: async () => 'unknown' });

    const summary = await runTimedSuspensionTick(env(), io, NOW);

    expect((await record())).toMatchObject({ status: 'lifting', attempts: 1 });
    expect(summary.recovered).toBe(0);
    expect(io.alert).not.toHaveBeenCalled();
  });

  it('alerts once at 3 attempts, not again within 12 hours, again after', async () => {
    await seed(PK, { attempts: 1 });
    const io = fakeIo({ readBan: async () => 'unknown' });

    await runTimedSuspensionTick(env(), io, NOW); // attempts 2
    expect(io.alert).not.toHaveBeenCalled();

    await runTimedSuspensionTick(env(), io, at(5)); // attempts 3
    expect(io.alert).toHaveBeenCalledTimes(1);
    const text = io.alert.mock.calls[0][0] as string;
    expect(text.split('\n')[0]).toBe(':rotating_light: [test] 1 timed suspension(s) not lifting');
    expect(text.split('\n')[1]).toMatch(new RegExp(`^• ${PK}: relay step, 3 attempts, last error: .+`));
    expect((await record())!.last_alerted_at).toBe(at(5).toISOString());

    await runTimedSuspensionTick(env(), io, at(65)); // attempts 4, inside 12 hours
    expect(io.alert).toHaveBeenCalledTimes(1);

    await runTimedSuspensionTick(env(), io, at(5 + 12 * 60 + 1)); // attempts 5, past 12 hours
    expect(io.alert).toHaveBeenCalledTimes(2);
  });

  it('names the Keycast step for a stuck keycast_pending row and cuts the error at 200 characters', async () => {
    await seed(PK, { status: 'keycast_pending', attempts: 2 });
    const io = fakeIo({ keycastActivate: async () => ({ success: false, error: 'x'.repeat(500) }) });

    await runTimedSuspensionTick(env(), io, NOW);

    const line = (io.alert.mock.calls[0][0] as string).split('\n')[1];
    expect(line.startsWith(`• ${PK}: keycast step, 3 attempts, last error: `)).toBe(true);
    const error = line.slice(`• ${PK}: keycast step, 3 attempts, last error: `.length);
    expect(error.length).toBeLessThanOrEqual(200);
  });

  it('caps the alert at 50 lines plus "+N more", and marks only the rows it named', async () => {
    // Fresh 'lifting' claims: no phase acts on them, so only the alert phase sees them.
    const pks = Array.from({ length: 52 }, (_, i) => i.toString(16).padStart(2, '0').repeat(32));
    for (const pk of pks) await seed(pk, { status: 'lifting', claimed_at: at(-1).toISOString(), attempts: 3 });
    const io = fakeIo();

    await runTimedSuspensionTick(env(), io, NOW);

    expect(io.alert).toHaveBeenCalledTimes(1);
    const lines = (io.alert.mock.calls[0][0] as string).split('\n');
    expect(lines[0]).toBe(':rotating_light: [test] 52 timed suspension(s) not lifting');
    expect(lines.filter(l => l.startsWith('• '))).toHaveLength(50);
    expect(lines[lines.length - 1]).toBe('+2 more');
    const marked = await DB.prepare('SELECT COUNT(*) AS n FROM timed_suspensions WHERE last_alerted_at IS NOT NULL')
      .first<{ n: number }>();
    expect(marked!.n).toBe(50);
  });

  it('logs every line, uncapped, when the alert is not delivered', async () => {
    const pks = Array.from({ length: 52 }, (_, i) => i.toString(16).padStart(2, '0').repeat(32));
    for (const pk of pks) await seed(pk, { status: 'lifting', claimed_at: at(-1).toISOString(), attempts: 3 });
    const io = fakeIo({ alert: async () => false });

    await runTimedSuspensionTick(env(), io, NOW);

    const logged = vi.mocked(console.error).mock.calls.map(c => c.join(' ')).join('\n');
    for (const pk of pks) expect(logged).toContain(`• ${pk}: `);
    expect(logged).not.toContain('+2 more');
  });

  it('does not mark alerted when the alert fails, and leaves a trace in the log', async () => {
    await seed(PK, { attempts: 2 });
    const io = fakeIo({ readBan: async () => 'unknown', alert: async () => false });

    await runTimedSuspensionTick(env(), io, NOW);

    expect(io.alert).toHaveBeenCalledTimes(1);
    expect((await record())!.last_alerted_at).toBeNull();
    const logged = vi.mocked(console.error).mock.calls.map(c => c.join(' ')).join('\n');
    expect(logged).toContain('timed suspension(s) not lifting');
    expect(logged).toContain(PK);

    // Unmarked, so the next tick tries again.
    await runTimedSuspensionTick(env(), io, at(5));
    expect(io.alert).toHaveBeenCalledTimes(2);
  });
});

describe('isolation', () => {
  it('one row throwing does not stop the next row', async () => {
    await seed(PK, { ends_at: '2026-11-20T13:00:00.000Z' });
    await seed(PK2, { ends_at: ONE_MIN_AGO });
    // readSuspension, not readBan: the ban and Keycast reads turn a throw into 'unknown', so
    // only an unguarded call reaches the per-row catch this test is about.
    const io = fakeIo({
      readSuspension: async (pubkey: string) => {
        if (pubkey === PK) throw new Error('boom');
        return { suspended: true, reason: 'policy' };
      },
    });

    const summary = await runTimedSuspensionTick(env(), io, NOW);

    expect((await record(PK))).toMatchObject({ status: 'active', attempts: 1 });
    expect((await record(PK))!.last_error).toContain('boom');
    expect((await record(PK2))!.status).toBe('lifted');
    expect(io.relayUnsuspend).toHaveBeenCalledWith(PK2);
    expect(io.relayUnsuspend).not.toHaveBeenCalledWith(PK);
    expect(summary).toMatchObject({ lifted: 1, failed: 1 });
  });
});
