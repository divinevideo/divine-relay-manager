// ABOUTME: Unit tests for liveSuspensionIo: how each live read maps to the timer's answers,
// ABOUTME: the Keycast status timeout, the fail-closed age-review check, and the Slack alert.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { liveSuspensionIo, KEYCAST_STATUS_TIMEOUT_MS, type SuspensionIoEnv } from './timed-suspensions-io';
import { emptyManagementState, managementFake } from './test-helpers/management-fake';

const TEST_NSEC = 'nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5';
const PK = 'a7'.repeat(32);
const MOD = 'b8'.repeat(32);
const WEBHOOK = 'https://hooks.example/services/T/B/secret';

// A DB whose age-review case lookup answers `row`.
function caseDb(row: unknown) {
  return {
    prepare: () => ({ bind: () => ({ first: async () => row }) }),
  } as unknown as D1Database;
}

function env(over: Partial<SuspensionIoEnv> = {}): SuspensionIoEnv {
  return {
    RELAY_URL: 'wss://relay.example',
    NOSTR_NSEC: TEST_NSEC,
    KEYCAST_URL: 'https://login.example',
    KEYCAST_SERVICE_TOKEN: 'keycast-token',
    SLACK_WEBHOOK_URL: WEBHOOK,
    DB: caseDb(null),
    ...over,
  } as SuspensionIoEnv;
}

const noNotify = vi.fn(async () => {});

afterEach(() => { vi.restoreAllMocks(); });

describe('liveSuspensionIo.readKeycastStatus', () => {
  it.each(['active', 'suspended', 'banned'] as const)('answers %s when Keycast says so', async (status) => {
    managementFake({ ...emptyManagementState(), keycast: new Map([[PK, status]]) });
    expect(await liveSuspensionIo(env(), noNotify).readKeycastStatus(PK)).toBe(status);
  });

  it('answers none when Keycast has no account', async () => {
    managementFake(emptyManagementState());
    expect(await liveSuspensionIo(env(), noNotify).readKeycastStatus(PK)).toBe('none');
  });

  it('answers unknown for a status it does not recognise', async () => {
    managementFake({ ...emptyManagementState(), keycast: new Map([[PK, 'deleted']]) });
    expect(await liveSuspensionIo(env(), noNotify).readKeycastStatus(PK)).toBe('unknown');
  });

  it('answers unknown when Keycast fails', async () => {
    managementFake({ ...emptyManagementState(), keycast: new Map([[PK, 'active']]), fail: { keycast_get: true } });
    expect(await liveSuspensionIo(env(), noNotify).readKeycastStatus(PK)).toBe('unknown');
  });

  it('answers unknown, without calling, when Keycast is not configured', async () => {
    const fake = managementFake(emptyManagementState());
    expect(await liveSuspensionIo(env({ KEYCAST_URL: undefined }), noNotify).readKeycastStatus(PK)).toBe('unknown');
    expect(fake.keycastGets).toHaveLength(0);
  });

  it('answers unknown when resolving the token throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    managementFake(emptyManagementState());
    const token = { get: async () => { throw new Error('secrets store down'); } };
    expect(await liveSuspensionIo(env({ KEYCAST_SERVICE_TOKEN: token }), noNotify).readKeycastStatus(PK)).toBe('unknown');
  });

  // F10: the scheduler reads Keycast for many rows, so one hang must not stall it.
  it('reads with a timeout', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const fake = managementFake({ ...emptyManagementState(), keycast: new Map([[PK, 'active']]) });
    await liveSuspensionIo(env(), noNotify).readKeycastStatus(PK);
    expect(timeout).toHaveBeenCalledWith(KEYCAST_STATUS_TIMEOUT_MS);
    const init = fake.spy.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('liveSuspensionIo.hasOpenAgeReviewCase', () => {
  it('is true when an open case exists', async () => {
    expect(await liveSuspensionIo(env({ DB: caseDb({ id: 'c1', state: 'open_reported' }) }), noNotify)
      .hasOpenAgeReviewCase(PK)).toBe(true);
  });

  it('is false when there is none', async () => {
    expect(await liveSuspensionIo(env(), noNotify).hasOpenAgeReviewCase(PK)).toBe(false);
  });

  // F11: no DB means "cannot tell", never "no case".
  it('throws when the DB binding is missing', async () => {
    await expect(liveSuspensionIo(env({ DB: undefined }), noNotify).hasOpenAgeReviewCase(PK)).rejects.toThrow();
  });
});

describe('liveSuspensionIo relay and Keycast calls', () => {
  it('reads the ban list and the suspended list fresh', async () => {
    managementFake({ ...emptyManagementState(), banned: new Set([PK]), suspended: new Map([[PK, 'age_review']]) });
    const io = liveSuspensionIo(env(), noNotify);
    expect(await io.readBan(PK)).toBe(true);
    expect(await io.readSuspension(PK)).toEqual({ suspended: true, reason: 'age_review' });
  });

  it('relayUnsuspend unsuspends on the relay and reports failure without throwing', async () => {
    const fake = managementFake({ ...emptyManagementState(), suspended: new Map([[PK, null]]) });
    const io = liveSuspensionIo(env(), noNotify);
    expect(await io.relayUnsuspend(PK)).toEqual({ success: true });
    expect(fake.state.suspended.has(PK)).toBe(false);
    fake.state.fail = { unsuspendpubkey: true };
    expect(await io.relayUnsuspend(PK)).toEqual({ success: false, error: 'unsuspendpubkey refused' });
  });

  it('relayUnsuspend reports a throw as a failure', async () => {
    managementFake(emptyManagementState());
    const io = liveSuspensionIo(env({ NOSTR_NSEC: undefined as never }), noNotify);
    expect((await io.relayUnsuspend(PK)).success).toBe(false);
  });

  it('keycastActivate and keycastSuspend name the actor', async () => {
    const fake = managementFake({ ...emptyManagementState(), keycast: new Map([[PK, 'active']]) });
    const io = liveSuspensionIo(env(), noNotify);
    expect((await io.keycastSuspend(PK, MOD)).success).toBe(true);
    expect((await io.keycastActivate(PK, MOD)).success).toBe(true);
    expect(fake.keycastPuts).toEqual([
      { pubkey: PK, status: 'suspended', actor: MOD },
      { pubkey: PK, status: 'active', actor: MOD },
    ]);
  });

  it('notify is the injected notifier', async () => {
    const notify = vi.fn(async () => {});
    await liveSuspensionIo(env(), notify).notify(PK, 'ACCOUNT_SUSPENDED', 'r', '2030-01-01T00:00:00.000Z');
    expect(notify).toHaveBeenCalledWith(PK, 'ACCOUNT_SUSPENDED', 'r', '2030-01-01T00:00:00.000Z');
  });
});

describe('liveSuspensionIo.alert', () => {
  it('posts the text to the Slack webhook and answers true', async () => {
    const fake = managementFake(emptyManagementState());
    expect(await liveSuspensionIo(env(), noNotify).alert('hello')).toBe(true);
    expect(fake.alerts).toEqual(['hello']);
  });

  it('answers false, without calling, when no webhook is set', async () => {
    const fake = managementFake(emptyManagementState());
    expect(await liveSuspensionIo(env({ SLACK_WEBHOOK_URL: undefined }), noNotify).alert('hello')).toBe(false);
    expect(fake.spy).not.toHaveBeenCalled();
  });

  it('answers false when Slack answers non-OK', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('no', { status: 500 }));
    expect(await liveSuspensionIo(env(), noNotify).alert('hello')).toBe(false);
  });

  // The webhook URL is itself a credential, and a fetch error can repeat it.
  it('answers false on a throw and logs only the error name', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError(`Invalid URL: ${WEBHOOK}`));
    expect(await liveSuspensionIo(env(), noNotify).alert('hello')).toBe(false);
    const logged = JSON.stringify(errors.mock.calls);
    expect(logged).toContain('TypeError');
    expect(logged).not.toContain('secret');
  });
});
