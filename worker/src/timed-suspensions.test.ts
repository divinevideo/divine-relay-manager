// ABOUTME: Unit tests for restoreAfterLift, the shared "restored" notice plus Keycast
// ABOUTME: reactivation that both the manual unsuspend and the timer run after a relay lift.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { restoreAfterLift, type SuspensionIo } from './timed-suspensions';
import type { KeycastResult } from './keycast-client';

const PK = 'e5'.repeat(32);
const MOD = 'f6'.repeat(32);

function fakeIo(keycast: () => Promise<KeycastResult>, notify: SuspensionIo['notify'] = vi.fn(async () => {})) {
  const order: string[] = [];
  const io = {
    readBan: vi.fn(), readSuspension: vi.fn(), readKeycastStatus: vi.fn(), hasOpenAgeReviewCase: vi.fn(),
    relayUnsuspend: vi.fn(), keycastSuspend: vi.fn(), alert: vi.fn(),
    notify: vi.fn(async (...args: Parameters<SuspensionIo['notify']>) => { order.push('notify'); return notify(...args); }),
    keycastActivate: vi.fn(async () => { order.push('keycast'); return keycast(); }),
  } as unknown as SuspensionIo;
  return { io, order };
}

afterEach(() => { vi.restoreAllMocks(); });

describe('restoreAfterLift', () => {
  it('sends ACCOUNT_RESTORED, then activates Keycast with the moderator, and answers ok', async () => {
    const { io, order } = fakeIo(async () => ({ success: true }));
    expect(await restoreAfterLift(io, PK, { reason: 'Account restored by moderator', moderator: MOD })).toBe('ok');
    expect(order).toEqual(['notify', 'keycast']);
    expect(io.notify).toHaveBeenCalledWith(PK, 'ACCOUNT_RESTORED', 'Account restored by moderator');
    expect(io.keycastActivate).toHaveBeenCalledWith(PK, MOD);
  });

  it('answers not_applicable when Keycast has no account (self-custody)', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { io } = fakeIo(async () => ({ success: false, notFound: true, error: '404' }));
    expect(await restoreAfterLift(io, PK, { reason: 'r' })).toBe('not_applicable');
  });

  it('answers failed when Keycast refuses', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { io } = fakeIo(async () => ({ success: false, error: '500: down' }));
    expect(await restoreAfterLift(io, PK, { reason: 'r' })).toBe('failed');
  });

  it('answers failed, without throwing, when the Keycast call throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { io } = fakeIo(async () => { throw new Error('boom'); });
    await expect(restoreAfterLift(io, PK, { reason: 'r' })).resolves.toBe('failed');
  });

  it('still activates Keycast when the notice throws', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { io, order } = fakeIo(async () => ({ success: true }), async () => { throw new Error('notify down'); });
    expect(await restoreAfterLift(io, PK, { reason: 'r' })).toBe('ok');
    expect(order).toEqual(['notify', 'keycast']);
    expect(errors.mock.calls.some(c => String(c[0]).includes('restored notice'))).toBe(true);
  });
});
