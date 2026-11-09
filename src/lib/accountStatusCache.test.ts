// ABOUTME: Pins the account-status cache key and the single-account refresh that
// ABOUTME: age review and the report view both use after an action.
import { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  KEYCAST_MIRROR_SETTLE_MS,
  accountStatusKey,
  invalidateAccountStatus,
  refreshAccountStatusAfterMirror,
} from './accountStatusCache';

const API = 'https://api.example';
const SUBJECT = 'ab'.repeat(32);
const OTHER = 'cd'.repeat(32);

function cached() {
  const client = new QueryClient();
  client.setQueryData(accountStatusKey(API, SUBJECT), { success: true, status: 'active' });
  client.setQueryData(accountStatusKey(API, OTHER), { success: true, status: 'active' });
  const isInvalidated = (pubkey: string) => client.getQueryState(accountStatusKey(API, pubkey))!.isInvalidated;
  return { client, isInvalidated };
}

describe('accountStatusCache', () => {
  it('keys an account by its lowercased pubkey, so both views share one entry', () => {
    expect(accountStatusKey(API, SUBJECT.toUpperCase())).toEqual(['account-status', API, SUBJECT]);
  });

  it('refreshes only the acted-on account', async () => {
    const { client, isInvalidated } = cached();
    await invalidateAccountStatus(client, SUBJECT);
    expect(isInvalidated(SUBJECT)).toBe(true);
    expect(isInvalidated(OTHER)).toBe(false);
  });

  // A report's p tag can be uppercase; the cached entry is always lowercase.
  it('refreshes the entry for an uppercase pubkey', async () => {
    const { client, isInvalidated } = cached();
    await invalidateAccountStatus(client, SUBJECT.toUpperCase());
    expect(isInvalidated(SUBJECT)).toBe(true);
  });

  describe('after an action the worker mirrors into Keycast', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    const accountStatusCalls = (spy: ReturnType<typeof vi.spyOn>) =>
      spy.mock.calls.filter(([filters]) => JSON.stringify((filters as { queryKey?: unknown })?.queryKey) === JSON.stringify(['account-status']));

    // The mirror runs after the worker responds, so the first read can beat it.
    it('refreshes the account at once and once more after the mirror has had time to land', () => {
      vi.useFakeTimers();
      const { client } = cached();
      const invalidate = vi.spyOn(client, 'invalidateQueries');

      refreshAccountStatusAfterMirror(client, SUBJECT);
      expect(accountStatusCalls(invalidate)).toHaveLength(1);

      vi.advanceTimersByTime(KEYCAST_MIRROR_SETTLE_MS - 1);
      expect(accountStatusCalls(invalidate)).toHaveLength(1);

      vi.advanceTimersByTime(1);
      expect(accountStatusCalls(invalidate)).toHaveLength(2);

      vi.advanceTimersByTime(KEYCAST_MIRROR_SETTLE_MS * 10);
      expect(accountStatusCalls(invalidate)).toHaveLength(2);
    });

    it('refreshes only the acted-on account the second time too', () => {
      vi.useFakeTimers();
      const { client, isInvalidated } = cached();
      refreshAccountStatusAfterMirror(client, SUBJECT);
      // A fetch the first refresh started would clear the flag; reset both entries
      // so the delayed refresh is what this checks.
      client.setQueryData(accountStatusKey(API, SUBJECT), { success: true, status: 'banned' });
      client.setQueryData(accountStatusKey(API, OTHER), { success: true, status: 'active' });

      vi.advanceTimersByTime(KEYCAST_MIRROR_SETTLE_MS);

      expect(isInvalidated(SUBJECT)).toBe(true);
      expect(isInvalidated(OTHER)).toBe(false);
    });
  });
});
