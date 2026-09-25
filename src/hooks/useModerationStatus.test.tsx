// ABOUTME: Pins that a verification which could not complete stays "unknown".
// ABOUTME: An inconclusive check must not borrow the ban list's answer.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import type { ReactNode } from 'react';

// The hook has two sources of truth: the NIP-86 ban lists and a live
// verification call. Neither may turn "could not reach the relay" into a
// negative. The list reads used to swallow their own errors into `[]`, which
// made "list unavailable" and "not in list" the same value; the tests at the
// bottom of this file pin that they no longer do.

const {
  listBannedPubkeys,
  listBannedEvents,
  listSuspendedPubkeys,
  verifyPubkeyBanned,
  verifyEventDeleted,
} = vi.hoisted(() => ({
  listBannedPubkeys: vi.fn(),
  listBannedEvents: vi.fn(),
  listSuspendedPubkeys: vi.fn(),
  verifyPubkeyBanned: vi.fn(),
  verifyEventDeleted: vi.fn(),
}));

const apiUrl = vi.hoisted(() => ({ value: 'https://api.a.example' }));
vi.mock('@/hooks/useAdminApi', () => ({
  useApiUrl: () => apiUrl.value,
  useAdminApi: () => ({
    listBannedPubkeys,
    listBannedEvents,
    listSuspendedPubkeys,
    verifyPubkeyBanned,
    verifyEventDeleted,
  }),
}));

import { useModerationStatus } from './useModerationStatus';
import { useBannedPubkeys } from './useRelayBanLists';
import { RESOLUTION_READ_TIMEOUT_MS } from '@/lib/constants';

const PUBKEY = 'a'.repeat(64);
const EVENT_ID = 'b'.repeat(64);

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('useModerationStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiUrl.value = 'https://api.a.example';
    listBannedPubkeys.mockResolvedValue([]);
    listBannedEvents.mockResolvedValue([]);
    listSuspendedPubkeys.mockResolvedValue([]);
    verifyEventDeleted.mockResolvedValue(null);
  });

  it('uses the ban list before any check has run', async () => {
    listBannedPubkeys.mockResolvedValue([{ pubkey: PUBKEY }]);
    verifyPubkeyBanned.mockResolvedValue(null);

    // An event report that was found normally does not auto-check, so this is
    // the "no verification has run" state. (A user-only report auto-checks.)
    const { result } = renderHook(() => useModerationStatus(PUBKEY, EVENT_ID, false), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(verifyPubkeyBanned).not.toHaveBeenCalled();
    expect(result.current.isUserBanned).toBe(true);
  });

  it('reports unknown, not "not banned", when the check could not complete', async () => {
    // The live check could not answer (it resolves null). The list itself did
    // answer, with nobody in it -- which must not stand in for the check.
    verifyPubkeyBanned.mockResolvedValue(null);

    const { result } = renderHook(() => useModerationStatus(PUBKEY), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      result.current.recheck();
    });

    await waitFor(() => expect(result.current.checkedAt).not.toBeNull());
    // The regression this pins: `null ?? isUserBannedFromList` yielded false.
    expect(result.current.isUserBanned).toBeNull();
    expect(result.current.isUserBanned).not.toBe(false);
  });

  it('still reports a completed negative check as not banned', async () => {
    verifyPubkeyBanned.mockResolvedValue(false);

    const { result } = renderHook(() => useModerationStatus(PUBKEY), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      result.current.recheck();
    });

    await waitFor(() => expect(result.current.checkedAt).not.toBeNull());
    expect(result.current.isUserBanned).toBe(false);
  });

  it('still reports a completed positive check as banned', async () => {
    verifyPubkeyBanned.mockResolvedValue(true);

    const { result } = renderHook(() => useModerationStatus(PUBKEY), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      result.current.recheck();
    });

    await waitFor(() => expect(result.current.checkedAt).not.toBeNull());
    expect(result.current.isUserBanned).toBe(true);
  });

  it('keeps a positive ban-list membership when the check could not answer', async () => {
    // Membership in the list is evidence however the live check went, so a
    // list `true` still settles the question when the check could not answer.
    listBannedPubkeys.mockResolvedValue([{ pubkey: PUBKEY }]);
    verifyPubkeyBanned.mockResolvedValue(null);

    const { result } = renderHook(() => useModerationStatus(PUBKEY), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      result.current.recheck();
    });

    await waitFor(() => expect(result.current.checkedAt).not.toBeNull());
    expect(result.current.isUserBanned).toBe(true);
  });

  it('keeps a positive banned-event membership when the check could not answer', async () => {
    listBannedEvents.mockResolvedValue([{ id: EVENT_ID }]);
    verifyEventDeleted.mockResolvedValue(null);

    const { result } = renderHook(() => useModerationStatus(PUBKEY, EVENT_ID, true), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      result.current.recheck();
    });

    await waitFor(() => expect(result.current.checkedAt).not.toBeNull());
    expect(result.current.isEventGone).toBe(true);
  });

  // --- A failed list read is not a negative answer -------------------------
  //
  // Each of the three NIP-86 list reads used to catch its own error and return
  // `[]`, so a relay that did not answer was indistinguishable from a relay
  // that answered "nobody is in this list". The moderator was shown a
  // confident negative for something never confirmed.
  //
  // The derivations already end in `?? null`; they were simply never reached,
  // because a swallowed error still produced data. One test per list, so that
  // restoring any single catch turns its own test red. Restoring the suspended
  // one also reddens the stale-refresh test further down, which needs that same
  // read to fail.

  it('reports unknown, not "not suspended", when the suspended list read fails', async () => {
    listSuspendedPubkeys.mockRejectedValue(new Error('relay unreachable'));

    const { result } = renderHook(() => useModerationStatus(PUBKEY, EVENT_ID, false), { wrapper });

    // The shared definition retries once before giving up, so this settles at
    // about a second. Waiting on isLoading is the non-circular signal: it stays
    // true across the retry and only clears once every list has settled.
    await waitFor(() => expect(result.current.isLoading).toBe(false), { timeout: 5000 });

    expect(result.current.isUserSuspended).toBeNull();
    expect(result.current.isUserSuspended).not.toBe(false);
  });

  it('reports unknown, not "not banned", when the banned-events list read fails', async () => {
    listBannedEvents.mockRejectedValue(new Error('relay unreachable'));

    const { result } = renderHook(() => useModerationStatus(PUBKEY, EVENT_ID, false), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false), { timeout: 5000 });

    expect(result.current.isEventBanned).toBeNull();
    expect(result.current.isEventBanned).not.toBe(false);
  });

  it('reports unknown, not "not banned", when the banned-pubkeys list read fails and no check has run', async () => {
    // The `wsResult.userBanned === undefined` branch: an event report that was
    // found normally does not auto-check, so the list is the only source. A
    // failed read there used to fall through as a plain `false`.
    listBannedPubkeys.mockRejectedValue(new Error('relay unreachable'));

    const { result } = renderHook(() => useModerationStatus(PUBKEY, EVENT_ID, false), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false), { timeout: 5000 });

    expect(verifyPubkeyBanned).not.toHaveBeenCalled();
    expect(result.current.isUserBanned).toBeNull();
    expect(result.current.isUserBanned).not.toBe(false);
  });

  it('reports unknown when a refresh fails, rather than the stale answer', async () => {
    // React Query keeps the last good result in `data` through a failed
    // refetch, so `data?.some()` alone would still say "not suspended". Only the
    // query's error state distinguishes a confirmed negative from a stale one.
    // This also pins that Re-check refetches the lists at all: if it stopped,
    // the second read would never happen and this stays false.
    listSuspendedPubkeys.mockResolvedValueOnce([]);
    verifyPubkeyBanned.mockResolvedValue(null);

    const { result } = renderHook(() => useModerationStatus(PUBKEY, EVENT_ID, false), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false), { timeout: 5000 });
    expect(result.current.isUserSuspended).toBe(false);

    listSuspendedPubkeys.mockRejectedValue(new Error('relay unreachable'));
    await act(async () => {
      result.current.recheck();
    });

    await waitFor(() => expect(result.current.isUserSuspended).toBeNull(), { timeout: 5000 });
    expect(result.current.isUserSuspended).not.toBe(false);
  });

  it("does not present the previous environment's ban list as a confirmed answer", async () => {
    // Switching environment calls queryClient.clear(). A still-mounted pane
    // then gets a fresh query. The list reads used to carry
    // `placeholderData: prev => prev`, which seeded that query with the OLD
    // environment's list as a "success", indistinguishable from a confirmed
    // answer, so the pane stated one environment's ban status on another
    // environment's report. The option is gone; this keeps it gone.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const clientWrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );

    listBannedPubkeys.mockResolvedValueOnce([{ pubkey: PUBKEY }]);
    const { result, rerender } = renderHook(
      () => useModerationStatus(PUBKEY, EVENT_ID, false),
      { wrapper: clientWrapper },
    );
    await waitFor(() => expect(result.current.isUserBanned).toBe(true), { timeout: 5000 });

    // The new environment's read never settles within the test.
    listBannedPubkeys.mockImplementation(() => new Promise(() => {}));
    act(() => {
      client.clear();
    });
    rerender();

    await waitFor(() => expect(listBannedPubkeys).toHaveBeenCalledTimes(2), { timeout: 5000 });
    expect(result.current.isUserBanned).not.toBe(true);
    expect(result.current.isUserBanned).toBeNull();
  });

  it("does not hand the reports queue the previous environment's ban list either", async () => {
    // The queue reads `data` from this same hook and treats any data as an
    // answer (`hasData: !!bannedPubkeys`). After an environment switch it must
    // see nothing until the new environment has answered, exactly as on a fresh
    // page load -- not the old environment's list standing in for it.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const clientWrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );

    listBannedPubkeys.mockResolvedValueOnce([{ pubkey: PUBKEY }]);
    const { result, rerender } = renderHook(() => useBannedPubkeys(), { wrapper: clientWrapper });
    await waitFor(() => expect(result.current.data).toEqual([{ pubkey: PUBKEY }]), { timeout: 5000 });

    listBannedPubkeys.mockImplementation(() => new Promise(() => {}));
    act(() => {
      client.clear();
    });
    rerender();

    await waitFor(() => expect(listBannedPubkeys).toHaveBeenCalledTimes(2), { timeout: 5000 });
    expect(result.current.data).toBeUndefined();
  });

  it('keeps a banned account shown as banned when a later refresh fails', async () => {
    // Membership from the last good read is still the best evidence there is,
    // and the reports queue already keeps treating it as current. Dropping it
    // on one failed poll swapped "Unban User" for "Ban User" on a banned
    // account and made the pane disagree with the queue about the same target.
    listBannedPubkeys.mockResolvedValueOnce([{ pubkey: PUBKEY }]);
    verifyPubkeyBanned.mockResolvedValue(null);

    const { result } = renderHook(() => useModerationStatus(PUBKEY, EVENT_ID, false), { wrapper });
    await waitFor(() => expect(result.current.isUserBanned).toBe(true), { timeout: 5000 });

    listBannedPubkeys.mockRejectedValue(new Error('relay unreachable'));
    await act(async () => {
      result.current.recheck();
    });

    // The value is not expected to change, so there is no transition to wait
    // on. Wait for the refresh to exhaust its retry -- one initial read plus two
    // attempts -- then let the error state land before asserting. Asserting any
    // earlier would pass before the failure had been observed at all.
    await waitFor(() => expect(listBannedPubkeys).toHaveBeenCalledTimes(3), { timeout: 5000 });
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 100));
    });

    expect(result.current.isUserBanned).toBe(true);
  });

  it('reads all three lists with the resolution-read timeout', async () => {
    // The two shared keys are also read by the reports queue, and the timeout
    // applied is whichever observer triggers the fetch -- so the pane must pass
    // the same bound the queue does, not the 30s default.
    const { result } = renderHook(() => useModerationStatus(PUBKEY, EVENT_ID, false), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false), { timeout: 5000 });

    expect(listBannedPubkeys).toHaveBeenCalledWith({ timeoutMs: RESOLUTION_READ_TIMEOUT_MS });
    expect(listBannedEvents).toHaveBeenCalledWith({ timeoutMs: RESOLUTION_READ_TIMEOUT_MS });
    expect(listSuspendedPubkeys).toHaveBeenCalledWith({ timeoutMs: RESOLUTION_READ_TIMEOUT_MS });
  });

  it('re-reads all three lists on Re-check', async () => {
    verifyPubkeyBanned.mockResolvedValue(false);
    const { result } = renderHook(() => useModerationStatus(PUBKEY, EVENT_ID, false), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false), { timeout: 5000 });

    const before = [listBannedPubkeys, listBannedEvents, listSuspendedPubkeys]
      .map(fn => fn.mock.calls.length);

    await act(async () => {
      result.current.recheck();
    });

    await waitFor(() => {
      expect(listBannedPubkeys.mock.calls.length).toBeGreaterThan(before[0]);
      expect(listBannedEvents.mock.calls.length).toBeGreaterThan(before[1]);
      expect(listSuspendedPubkeys.mock.calls.length).toBeGreaterThan(before[2]);
    }, { timeout: 5000 });
  });

  it('reports the account lists as settled even while the banned-events list is still loading', async () => {
    // The account-status note picks "checking" or "could not be confirmed" from
    // this. The banned-events list is not an account status, so a slow read of
    // it must not make an already-failed suspended read say "checking".
    listSuspendedPubkeys.mockRejectedValue(new Error('relay unreachable'));
    listBannedEvents.mockImplementation(() => new Promise(() => {}));

    const { result } = renderHook(() => useModerationStatus(PUBKEY, EVENT_ID, false), { wrapper });

    // Initial read plus one retry, then let the error state land.
    await waitFor(() => expect(listSuspendedPubkeys).toHaveBeenCalledTimes(2), { timeout: 5000 });
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 100));
    });

    expect(result.current.isUserSuspended).toBeNull();
    expect(result.current.isLoading).toBe(true);
    expect(result.current.isAccountStatusLoading).toBe(false);
  });

  it('reports the account status as still loading while a live check of the pubkey runs', async () => {
    // The status block's own button says "Checking..." for this whole window --
    // verifyPubkeyBanned is its own listbannedpubkeys read, up to 30s. The
    // account note beside it must not say "could not be confirmed" meanwhile.
    listSuspendedPubkeys.mockRejectedValue(new Error('relay unreachable'));
    verifyPubkeyBanned.mockImplementation(() => new Promise(() => {}));

    const { result } = renderHook(() => useModerationStatus(PUBKEY, EVENT_ID, false), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false), { timeout: 5000 });
    expect(result.current.isAccountStatusLoading).toBe(false);

    act(() => {
      result.current.recheck();
    });

    await waitFor(() => expect(result.current.isChecking).toBe(true));
    expect(result.current.isAccountStatusLoading).toBe(true);
  });

  it('does not report an account status as loading during a live check of a post alone', async () => {
    // A report can name a post whose author is not known yet. The live check
    // then asks only about the post, so there is no account status to wait on.
    verifyEventDeleted.mockImplementation(() => new Promise(() => {}));

    const { result } = renderHook(() => useModerationStatus(undefined, EVENT_ID, true), { wrapper });
    await waitFor(() => expect(result.current.isChecking).toBe(true), { timeout: 5000 });

    expect(verifyPubkeyBanned).not.toHaveBeenCalled();
    expect(result.current.isAccountStatusLoading).toBe(false);
  });

  it('does not report an account status as loading while the lists re-read after a check of a post alone', async () => {
    // The check still asks the account lists to re-read, but with no account
    // in view there is no account status for that re-read to settle.
    listBannedPubkeys
      .mockResolvedValueOnce([])
      .mockImplementation(() => new Promise(() => {}));
    listSuspendedPubkeys
      .mockResolvedValueOnce([])
      .mockImplementation(() => new Promise(() => {}));
    verifyEventDeleted.mockResolvedValue(true);

    const { result } = renderHook(() => useModerationStatus(undefined, EVENT_ID, true), { wrapper });
    await waitFor(() => expect(listBannedPubkeys).toHaveBeenCalledTimes(2), { timeout: 5000 });
    await waitFor(() => expect(result.current.isChecking).toBe(false), { timeout: 5000 });

    expect(result.current.isAccountStatusLoading).toBe(false);
  });

  // --- A kept positive says it is kept ---------------------------------------
  //
  // A ban or suspension from the last good read is still shown after a refresh
  // fails, so an undo is reachable. But it must not look confirmed: right after
  // a moderator's own successful Unban or Unsuspend, a failed refresh would
  // otherwise show the old status as current with nothing to say otherwise.

  it('marks a kept suspension as stale when a later refresh fails', async () => {
    listSuspendedPubkeys.mockResolvedValueOnce([{ pubkey: PUBKEY }]);
    verifyPubkeyBanned.mockResolvedValue(null);

    const { result } = renderHook(() => useModerationStatus(PUBKEY, EVENT_ID, false), { wrapper });
    await waitFor(() => expect(result.current.isUserSuspended).toBe(true), { timeout: 5000 });
    expect(result.current.isUserSuspendedStale).toBe(false);

    listSuspendedPubkeys.mockRejectedValue(new Error('relay unreachable'));
    await act(async () => {
      result.current.recheck();
    });
    await waitFor(() => expect(listSuspendedPubkeys).toHaveBeenCalledTimes(3), { timeout: 5000 });
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 100));
    });

    expect(result.current.isUserSuspended).toBe(true);
    expect(result.current.isUserSuspendedStale).toBe(true);
  });

  it('marks a kept ban as stale when a later refresh fails and the live check could not answer', async () => {
    listBannedPubkeys.mockResolvedValueOnce([{ pubkey: PUBKEY }]);
    verifyPubkeyBanned.mockResolvedValue(null);

    const { result } = renderHook(() => useModerationStatus(PUBKEY, EVENT_ID, false), { wrapper });
    await waitFor(() => expect(result.current.isUserBanned).toBe(true), { timeout: 5000 });
    expect(result.current.isUserBannedStale).toBe(false);

    listBannedPubkeys.mockRejectedValue(new Error('relay unreachable'));
    await act(async () => {
      result.current.recheck();
    });
    await waitFor(() => expect(listBannedPubkeys).toHaveBeenCalledTimes(3), { timeout: 5000 });
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 100));
    });

    expect(result.current.isUserBanned).toBe(true);
    expect(result.current.isUserBannedStale).toBe(true);
  });

  it('does not mark a ban stale when the live check itself confirmed it', async () => {
    // The live check is a fresh read of the same list. If it answered, the ban
    // is current, whatever became of the background refresh.
    listBannedPubkeys.mockResolvedValueOnce([{ pubkey: PUBKEY }]);
    verifyPubkeyBanned.mockResolvedValue(true);

    const { result } = renderHook(() => useModerationStatus(PUBKEY, EVENT_ID, false), { wrapper });
    await waitFor(() => expect(result.current.isUserBanned).toBe(true), { timeout: 5000 });

    listBannedPubkeys.mockRejectedValue(new Error('relay unreachable'));
    await act(async () => {
      result.current.recheck();
    });
    await waitFor(() => expect(listBannedPubkeys).toHaveBeenCalledTimes(3), { timeout: 5000 });
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 100));
    });

    expect(result.current.isUserBanned).toBe(true);
    expect(result.current.isUserBannedStale).toBe(false);
  });

  // --- A live check answers for one environment and one report ---------------
  //
  // The live check's result outranks the lists. Switching environment clears
  // the cache but not this hook's own state, and the pane stays mounted, so an
  // answer from the old environment used to keep answering in the new one.

  it('does not carry a live check across an environment switch', async () => {
    verifyPubkeyBanned.mockResolvedValueOnce(true).mockResolvedValue(false);

    const { result, rerender } = renderHook(() => useModerationStatus(PUBKEY), { wrapper });
    await waitFor(() => expect(result.current.isUserBanned).toBe(true), { timeout: 5000 });

    apiUrl.value = 'https://api.b.example';
    rerender();

    await waitFor(() => expect(verifyPubkeyBanned).toHaveBeenCalledTimes(2), { timeout: 5000 });
    await waitFor(() => expect(result.current.isUserBanned).toBe(false), { timeout: 5000 });
  });

  it("drops a manual Re-check's answer when the environment changes, even with no auto-check to replace it", async () => {
    // An event report found normally never auto-checks, so nothing re-runs the
    // live check after a switch. Its old answer has to be dropped outright, or
    // it keeps outranking the new environment's lists.
    listBannedPubkeys.mockResolvedValue([]);
    verifyPubkeyBanned.mockResolvedValueOnce(true);

    const { result, rerender } = renderHook(() => useModerationStatus(PUBKEY, EVENT_ID, false), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false), { timeout: 5000 });
    await act(async () => {
      result.current.recheck();
    });
    await waitFor(() => expect(result.current.isUserBanned).toBe(true), { timeout: 5000 });

    apiUrl.value = 'https://api.b.example';
    rerender();

    await waitFor(() => expect(result.current.isUserBanned).toBe(false), { timeout: 5000 });
    expect(verifyPubkeyBanned).toHaveBeenCalledTimes(1);
  });

  it('discards a live check that started in the previous environment', async () => {
    let resolveOld: (value: boolean) => void = () => {};
    verifyPubkeyBanned
      .mockImplementationOnce(() => new Promise<boolean>(resolve => { resolveOld = resolve; }))
      .mockResolvedValue(false);

    const { result, rerender } = renderHook(() => useModerationStatus(PUBKEY), { wrapper });
    await waitFor(() => expect(verifyPubkeyBanned).toHaveBeenCalledTimes(1), { timeout: 5000 });

    apiUrl.value = 'https://api.b.example';
    rerender();
    await waitFor(() => expect(result.current.isUserBanned).toBe(false), { timeout: 5000 });

    // The old environment's answer arrives late. It must not land.
    await act(async () => {
      resolveOld(true);
      await new Promise(resolve => setTimeout(resolve, 50));
    });
    expect(result.current.isUserBanned).toBe(false);
  });

  it('discards a live check that started for a different report', async () => {
    const OTHER = 'c'.repeat(64);
    let resolveFirst: (value: boolean) => void = () => {};
    verifyPubkeyBanned
      .mockImplementationOnce(() => new Promise<boolean>(resolve => { resolveFirst = resolve; }))
      .mockResolvedValue(false);

    const { result, rerender } = renderHook(({ pk }) => useModerationStatus(pk), {
      wrapper,
      initialProps: { pk: PUBKEY },
    });
    await waitFor(() => expect(verifyPubkeyBanned).toHaveBeenCalledTimes(1), { timeout: 5000 });

    rerender({ pk: OTHER });
    await waitFor(() => expect(result.current.isUserBanned).toBe(false), { timeout: 5000 });

    await act(async () => {
      resolveFirst(true);
      await new Promise(resolve => setTimeout(resolve, 50));
    });
    expect(result.current.isUserBanned).toBe(false);
  });

  it("marks a kept ban stale when the list's refresh fails and no live check has run", async () => {
    // An event report found normally never auto-checks, so the lists are the
    // only source -- and the queue's 15s poll can fail with no Re-check at all.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const clientWrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    listBannedPubkeys.mockResolvedValueOnce([{ pubkey: PUBKEY }]);

    const { result } = renderHook(() => useModerationStatus(PUBKEY, EVENT_ID, false), { wrapper: clientWrapper });
    await waitFor(() => expect(result.current.isUserBanned).toBe(true), { timeout: 5000 });

    listBannedPubkeys.mockRejectedValue(new Error('relay unreachable'));
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['banned-pubkeys'] });
    });
    await waitFor(() => expect(listBannedPubkeys).toHaveBeenCalledTimes(3), { timeout: 5000 });
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 100));
    });

    expect(verifyPubkeyBanned).not.toHaveBeenCalled();
    expect(result.current.isUserBanned).toBe(true);
    expect(result.current.isUserBannedStale).toBe(true);
  });

  // --- Only the latest check answers -----------------------------------------
  //
  // A re-check runs after every moderator action, and a check can already be
  // running when it starts. Checks for the same report are not ordered by the
  // relay, so an older one can land last.

  it('drops an older check that lands after a newer one for the same report', async () => {
    let resolveFirst: (value: boolean) => void = () => {};
    verifyPubkeyBanned
      // the check that runs when the report opens, still in flight...
      .mockImplementationOnce(() => new Promise<boolean>(resolve => { resolveFirst = resolve; }))
      // ...when the moderator bans and the re-check after the ban answers.
      .mockResolvedValueOnce(true);

    const { result } = renderHook(() => useModerationStatus(PUBKEY), { wrapper });
    await waitFor(() => expect(verifyPubkeyBanned).toHaveBeenCalledTimes(1), { timeout: 5000 });

    await act(async () => {
      result.current.recheck();
    });
    await waitFor(() => expect(result.current.isUserBanned).toBe(true), { timeout: 5000 });

    // The pre-ban answer arrives last. It must not land.
    await act(async () => {
      resolveFirst(false);
      await new Promise(resolve => setTimeout(resolve, 50));
    });
    expect(result.current.isUserBanned).toBe(true);
  });

  it("lets a newer check's re-reads finish when an older check lands after they started", async () => {
    // The older check must stop before it cancels anything. Its cancel would
    // undo the newer check's re-reads, leaving the lists behind their marks
    // with nothing newer on the way.
    listSuspendedPubkeys.mockResolvedValueOnce([{ pubkey: PUBKEY }]);
    let resolveOlder: (value: boolean) => void = () => {};
    verifyPubkeyBanned
      .mockImplementationOnce(() => new Promise<boolean>(resolve => { resolveOlder = resolve; }))
      .mockResolvedValueOnce(false);

    const { result } = renderHook(() => useModerationStatus(PUBKEY, EVENT_ID, false), { wrapper });
    await waitFor(() => expect(result.current.isUserSuspended).toBe(true), { timeout: 5000 });

    // A check is still out when the moderator unsuspends and checks again.
    await act(async () => {
      result.current.recheck();
    });
    await waitFor(() => expect(verifyPubkeyBanned).toHaveBeenCalledTimes(1), { timeout: 5000 });
    let resolveReRead: (value: Array<{ pubkey: string }>) => void = () => {};
    listSuspendedPubkeys.mockImplementation(() => new Promise(resolve => { resolveReRead = resolve; }));
    await act(async () => {
      result.current.recheck();
    });
    await waitFor(() => expect(listSuspendedPubkeys).toHaveBeenCalledTimes(2), { timeout: 5000 });

    // The older check lands while the newer one's re-read is out.
    await act(async () => {
      resolveOlder(true);
      await new Promise(resolve => setTimeout(resolve, 50));
    });
    // Then the re-read answers, without the account.
    await act(async () => {
      resolveReRead([]);
      await new Promise(resolve => setTimeout(resolve, 50));
    });

    expect(result.current.isUserSuspended).toBe(false);
    expect(result.current.isUserSuspendedStale).toBe(false);
    expect(result.current.isAccountStatusLoading).toBe(false);
    expect(result.current.isUserBanned).toBe(false);
  });

  it('ignores a failure from an older check while a newer one is still running', async () => {
    let rejectFirst: (error: Error) => void = () => {};
    verifyPubkeyBanned
      .mockImplementationOnce(() => new Promise<boolean>((_, reject) => { rejectFirst = reject; }))
      .mockImplementationOnce(() => new Promise<boolean>(() => {}));

    const { result } = renderHook(() => useModerationStatus(PUBKEY), { wrapper });
    await waitFor(() => expect(verifyPubkeyBanned).toHaveBeenCalledTimes(1), { timeout: 5000 });
    await act(async () => {
      result.current.recheck();
    });
    await waitFor(() => expect(verifyPubkeyBanned).toHaveBeenCalledTimes(2), { timeout: 5000 });

    await act(async () => {
      rejectFirst(new Error('relay unreachable'));
      await new Promise(resolve => setTimeout(resolve, 50));
    });
    // The newer check is still running; the older one's failure must not say otherwise.
    expect(result.current.isChecking).toBe(true);
  });

  it('discards a live check that started for a different post by the same author', async () => {
    // Several reports about one author's posts is the common case, so the
    // pubkey alone does not identify what a check was for.
    const OTHER_EVENT = 'f'.repeat(64);
    let resolveFirst: (value: boolean) => void = () => {};
    verifyPubkeyBanned.mockResolvedValue(false);
    verifyEventDeleted
      .mockImplementationOnce(() => new Promise<boolean>(resolve => { resolveFirst = resolve; }))
      .mockResolvedValue(false);

    const { result, rerender } = renderHook(({ ev }) => useModerationStatus(PUBKEY, ev, true), {
      wrapper,
      initialProps: { ev: EVENT_ID },
    });
    await waitFor(() => expect(verifyEventDeleted).toHaveBeenCalledTimes(1), { timeout: 5000 });

    rerender({ ev: OTHER_EVENT });
    await waitFor(() => expect(verifyEventDeleted).toHaveBeenCalledTimes(2), { timeout: 5000 });
    await waitFor(() => expect(result.current.isEventGone).toBe(false), { timeout: 5000 });

    await act(async () => {
      resolveFirst(true);
      await new Promise(resolve => setTimeout(resolve, 50));
    });
    expect(result.current.isEventGone).toBe(false);
  });

  it('runs exactly one live check per report and per environment on a warm cache', async () => {
    // `wrapper` builds a new QueryClient on every rerender, which leaves the lists
    // loading at each switch and so hides a doubled check. One client stays warm.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const clientWrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const OTHER = 'c'.repeat(64);
    verifyPubkeyBanned.mockResolvedValue(false);

    const { rerender } = renderHook(({ pk }) => useModerationStatus(pk), {
      wrapper: clientWrapper,
      initialProps: { pk: PUBKEY },
    });
    await waitFor(() => expect(verifyPubkeyBanned).toHaveBeenCalledTimes(1), { timeout: 5000 });

    rerender({ pk: OTHER });
    await waitFor(() => expect(verifyPubkeyBanned).toHaveBeenCalledTimes(2), { timeout: 5000 });
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 100));
    });
    expect(verifyPubkeyBanned).toHaveBeenCalledTimes(2);

    apiUrl.value = 'https://api.b.example';
    act(() => {
      client.clear();
    });
    rerender({ pk: OTHER });
    await waitFor(() => expect(verifyPubkeyBanned).toHaveBeenCalledTimes(3), { timeout: 5000 });
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 100));
    });
    expect(verifyPubkeyBanned).toHaveBeenCalledTimes(3);
  });

  // --- The account status stays "checking" until the lists have re-read ------
  //
  // After a moderator's action the lists still hold the pre-action copy until
  // they re-read. The live check finishing does not make the ACCOUNT status
  // current; an account list answering does.

  it('reports a check in progress until the banned list has re-read, not just the live check', async () => {
    verifyPubkeyBanned.mockResolvedValueOnce(true).mockResolvedValueOnce(null);

    const { result } = renderHook(() => useModerationStatus(PUBKEY), { wrapper });
    await waitFor(() => expect(result.current.isUserBanned).toBe(true), { timeout: 5000 });
    await waitFor(() => expect(result.current.isChecking).toBe(false), { timeout: 5000 });

    // After the moderator's Unban: the live check fails fast, the list re-read hangs.
    listBannedPubkeys.mockImplementation(() => new Promise(() => {}));
    await act(async () => {
      result.current.recheck();
    });
    await waitFor(() => expect(verifyPubkeyBanned).toHaveBeenCalledTimes(2), { timeout: 5000 });
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 100));
    });

    expect(result.current.isAccountStatusLoading).toBe(true);
  });

  it('reports a check in progress while the suspended list is still re-reading', async () => {
    listSuspendedPubkeys.mockResolvedValueOnce([{ pubkey: PUBKEY }]);
    verifyPubkeyBanned.mockResolvedValue(false);

    const { result } = renderHook(() => useModerationStatus(PUBKEY, EVENT_ID, false), { wrapper });
    await waitFor(() => expect(result.current.isUserSuspended).toBe(true), { timeout: 5000 });

    // After the moderator's Unsuspend: the ban check answers, the suspended re-read hangs.
    listSuspendedPubkeys.mockImplementation(() => new Promise(() => {}));
    await act(async () => {
      result.current.recheck();
    });
    await waitFor(() => expect(verifyPubkeyBanned).toHaveBeenCalledTimes(1), { timeout: 5000 });
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 100));
    });

    expect(result.current.isAccountStatusLoading).toBe(true);
  });

  // --- Whether the BAN is still being checked -------------------------------
  //
  // isAccountStatusLoading waits on both account lists. The ban's own wording
  // ("Checking now." vs "could not confirm it") must follow only what can
  // still settle the ban: the banned list's first read, the live check, and the
  // banned list's re-read.

  it('reports the ban as being checked while the live check runs', async () => {
    verifyPubkeyBanned.mockImplementation(() => new Promise(() => {}));

    const { result } = renderHook(() => useModerationStatus(PUBKEY, EVENT_ID, false), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false), { timeout: 5000 });
    expect(result.current.isUserBanChecking).toBe(false);

    await act(async () => {
      result.current.recheck();
    });

    expect(result.current.isChecking).toBe(true);
    expect(result.current.isUserBanChecking).toBe(true);
  });

  it('reports the ban as being checked while the banned list has not answered yet', async () => {
    listBannedPubkeys.mockImplementation(() => new Promise(() => {}));

    const { result } = renderHook(() => useModerationStatus(PUBKEY, EVENT_ID, false), { wrapper });
    await waitFor(() => expect(listBannedPubkeys).toHaveBeenCalled(), { timeout: 5000 });

    expect(result.current.isChecking).toBe(false);
    expect(result.current.isUserBanChecking).toBe(true);
  });

  it('reports the ban as being checked while the banned list re-reads after the check', async () => {
    listBannedPubkeys.mockResolvedValueOnce([{ pubkey: PUBKEY }]);
    verifyPubkeyBanned.mockResolvedValue(null);

    const { result } = renderHook(() => useModerationStatus(PUBKEY, EVENT_ID, false), { wrapper });
    await waitFor(() => expect(result.current.isUserBanned).toBe(true), { timeout: 5000 });

    listBannedPubkeys.mockImplementation(() => new Promise(() => {}));
    await act(async () => {
      result.current.recheck();
    });
    await waitFor(() => expect(result.current.isChecking).toBe(false), { timeout: 5000 });

    expect(result.current.isUserBannedStale).toBe(true);
    expect(result.current.isUserBanChecking).toBe(true);
  });

  it('does not report the ban as being checked once its re-read failed, while the suspended list still re-reads', async () => {
    listBannedPubkeys.mockResolvedValueOnce([{ pubkey: PUBKEY }]);
    verifyPubkeyBanned.mockResolvedValue(null);

    const { result } = renderHook(() => useModerationStatus(PUBKEY, EVENT_ID, false), { wrapper });
    await waitFor(() => expect(result.current.isUserBanned).toBe(true), { timeout: 5000 });

    listBannedPubkeys.mockRejectedValue(new Error('relay unreachable'));
    listSuspendedPubkeys.mockImplementation(() => new Promise(() => {}));
    await act(async () => {
      result.current.recheck();
    });
    // The re-read and its one retry.
    await waitFor(() => expect(listBannedPubkeys).toHaveBeenCalledTimes(3), { timeout: 5000 });
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 100));
    });

    expect(result.current.isUserBanned).toBe(true);
    expect(result.current.isUserBannedStale).toBe(true);
    // Nothing still out can settle the ban; the suspended read can only settle
    // the suspension.
    expect(result.current.isUserBanChecking).toBe(false);
    expect(result.current.isAccountStatusLoading).toBe(true);
  });

  it('does not report a ban as being checked with no account in view', async () => {
    verifyEventDeleted.mockImplementation(() => new Promise(() => {}));

    const { result } = renderHook(() => useModerationStatus(null, EVENT_ID, true), { wrapper });
    await waitFor(() => expect(result.current.isChecking).toBe(true), { timeout: 5000 });

    expect(result.current.isUserBanChecking).toBe(false);
  });

  it('drops a manual Re-check still running when the environment changes, with no new check to supersede it', async () => {
    // An event report found normally never auto-checks, so after a switch no
    // newer check starts that would outrank this one by itself. The switch has
    // to retire it directly.
    let resolveManual: (value: boolean) => void = () => {};
    verifyPubkeyBanned.mockImplementationOnce(() => new Promise<boolean>(resolve => { resolveManual = resolve; }));

    const { result, rerender } = renderHook(() => useModerationStatus(PUBKEY, EVENT_ID, false), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false), { timeout: 5000 });
    await act(async () => {
      result.current.recheck();
    });
    await waitFor(() => expect(verifyPubkeyBanned).toHaveBeenCalledTimes(1), { timeout: 5000 });

    apiUrl.value = 'https://api.b.example';
    rerender();
    await waitFor(() => expect(result.current.isLoading).toBe(false), { timeout: 5000 });

    await act(async () => {
      resolveManual(true);
      await new Promise(resolve => setTimeout(resolve, 50));
    });
    expect(verifyPubkeyBanned).toHaveBeenCalledTimes(1);
    expect(result.current.isUserBanned).not.toBe(true);
    expect(result.current.checkedAt).toBeNull();
  });

  // --- "Checking" means an account list has not answered since the check ------
  //
  // Waiting on the reload promise was the wrong signal: a reload can pause
  // (offline, or a retry waiting for the tab to regain focus), can be cancelled
  // and replaced by another screen's Retry, and the banned-posts list is not an
  // account status at all. What matters is whether each ACCOUNT list has
  // answered since the check asked it to.

  it('reports the live check finished as soon as it answers, while the lists re-read', async () => {
    // The Re-check button and the "not found" view's spinner follow isChecking,
    // so it must not wait on three list reloads.
    verifyPubkeyBanned.mockResolvedValue(true);
    const { result } = renderHook(() => useModerationStatus(PUBKEY, EVENT_ID, false), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false), { timeout: 5000 });

    listBannedPubkeys.mockImplementation(() => new Promise(() => {}));
    await act(async () => {
      result.current.recheck();
    });
    await waitFor(() => expect(result.current.isUserBanned).toBe(true), { timeout: 5000 });
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 100));
    });

    expect(result.current.isChecking).toBe(false);
    expect(result.current.isAccountStatusLoading).toBe(true);
  });

  it('does not hold the account status on "checking" while only the banned-posts list re-reads', async () => {
    verifyPubkeyBanned.mockResolvedValue(false);
    const { result } = renderHook(() => useModerationStatus(PUBKEY, EVENT_ID, false), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false), { timeout: 5000 });

    listBannedEvents.mockImplementation(() => new Promise(() => {}));
    await act(async () => {
      result.current.recheck();
    });
    await waitFor(() => expect(verifyPubkeyBanned).toHaveBeenCalledTimes(1), { timeout: 5000 });
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 100));
    });

    expect(result.current.isAccountStatusLoading).toBe(false);
  });

  it('does not stay "checking" while the browser is offline, and treats the old copy as unconfirmed', async () => {
    listSuspendedPubkeys.mockResolvedValueOnce([{ pubkey: PUBKEY }]);
    verifyPubkeyBanned.mockResolvedValue(false);
    const { result } = renderHook(() => useModerationStatus(PUBKEY, EVENT_ID, false), { wrapper });
    await waitFor(() => expect(result.current.isUserSuspended).toBe(true), { timeout: 5000 });

    onlineManager.setOnline(false);
    try {
      await act(async () => {
        result.current.recheck();
      });
      await waitFor(() => expect(verifyPubkeyBanned).toHaveBeenCalledTimes(1), { timeout: 5000 });
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 100));
      });

      // The reloads are paused, not failed, and nothing newer is coming.
      expect(result.current.isChecking).toBe(false);
      expect(result.current.isAccountStatusLoading).toBe(false);
      expect(result.current.isUserSuspended).toBe(true);
      expect(result.current.isUserSuspendedStale).toBe(true);
    } finally {
      onlineManager.setOnline(true);
    }
  });

  it('stays "checking" when another screen reloads a list mid re-read', async () => {
    // Another screen invalidating the same list (user management does this for
    // the suspended list) cancels the re-read the check started and replaces
    // it. The copy on screen is still from before the action while the
    // replacement is out.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const clientWrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    listSuspendedPubkeys.mockResolvedValueOnce([{ pubkey: PUBKEY }]);
    verifyPubkeyBanned.mockResolvedValue(false);

    const { result } = renderHook(() => useModerationStatus(PUBKEY, EVENT_ID, false), { wrapper: clientWrapper });
    await waitFor(() => expect(result.current.isUserSuspended).toBe(true), { timeout: 5000 });

    listSuspendedPubkeys.mockImplementation(() => new Promise(() => {}));
    await act(async () => {
      result.current.recheck();
    });
    await waitFor(() => expect(listSuspendedPubkeys).toHaveBeenCalledTimes(2), { timeout: 5000 });

    await act(async () => {
      void client.invalidateQueries({ queryKey: ['suspended-pubkeys'] });
      await new Promise(resolve => setTimeout(resolve, 50));
    });

    expect(listSuspendedPubkeys).toHaveBeenCalledTimes(3);
    expect(result.current.isAccountStatusLoading).toBe(true);
    // Still the pre-action copy, so the kept suspension is last known, not
    // confirmed.
    expect(result.current.isUserSuspended).toBe(true);
    expect(result.current.isUserSuspendedStale).toBe(true);
  });


  it('keeps the next report on "checking" while the shared lists are still re-reading', async () => {
    // The lists belong to no single report. Moving on before they answer does
    // not make their pre-action copy current for the next one.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const clientWrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const OTHER = 'c'.repeat(64);
    verifyPubkeyBanned.mockResolvedValue(false);

    const { result, rerender } = renderHook(({ pk }) => useModerationStatus(pk, EVENT_ID, false), {
      wrapper: clientWrapper,
      initialProps: { pk: PUBKEY },
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false), { timeout: 5000 });

    listSuspendedPubkeys.mockImplementation(() => new Promise(() => {}));
    await act(async () => {
      result.current.recheck();
    });
    await waitFor(() => expect(listSuspendedPubkeys).toHaveBeenCalledTimes(2), { timeout: 5000 });

    rerender({ pk: OTHER });
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 100));
    });

    expect(result.current.isAccountStatusLoading).toBe(true);
  });

  it('returns to a confirmed status once the lists have answered after a check', async () => {
    // The ordinary path after every action: the lists re-read, answer, and the
    // status is current again -- not "checking", not stale, not unknown.
    listSuspendedPubkeys.mockResolvedValueOnce([{ pubkey: PUBKEY }]);
    verifyPubkeyBanned.mockResolvedValue(false);
    const { result } = renderHook(() => useModerationStatus(PUBKEY, EVENT_ID, false), { wrapper });
    await waitFor(() => expect(result.current.isUserSuspended).toBe(true), { timeout: 5000 });

    // After an Unsuspend, the re-read answers without the account.
    listSuspendedPubkeys.mockResolvedValue([]);
    await act(async () => {
      result.current.recheck();
    });

    await waitFor(() => expect(result.current.isUserSuspended).toBe(false), { timeout: 5000 });
    expect(result.current.isAccountStatusLoading).toBe(false);
    expect(result.current.isUserSuspendedStale).toBe(false);
  });

  // The ordinary sequence after every action: the check's re-read answers, and
  // a later refresh, such as the reports queue's poll, fails. Passing the mark
  // does not make every later copy current.

  it('marks a kept suspension stale when a refresh fails after the check has re-read', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const clientWrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    listSuspendedPubkeys.mockResolvedValue([{ pubkey: PUBKEY }]);
    verifyPubkeyBanned.mockResolvedValue(false);

    const { result } = renderHook(() => useModerationStatus(PUBKEY, EVENT_ID, false), { wrapper: clientWrapper });
    await waitFor(() => expect(result.current.isUserSuspended).toBe(true), { timeout: 5000 });

    await act(async () => {
      result.current.recheck();
    });
    await waitFor(() => expect(listSuspendedPubkeys).toHaveBeenCalledTimes(2), { timeout: 5000 });
    await waitFor(() => expect(result.current.isAccountStatusLoading).toBe(false), { timeout: 5000 });
    expect(result.current.isUserSuspendedStale).toBe(false);

    listSuspendedPubkeys.mockRejectedValue(new Error('relay unreachable'));
    await act(async () => {
      await client.refetchQueries({ queryKey: ['suspended-pubkeys'] });
    });
    expect(client.getQueryState(['suspended-pubkeys'])?.status).toBe('error');
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 50));
    });

    expect(result.current.isUserSuspended).toBe(true);
    expect(result.current.isUserSuspendedStale).toBe(true);
  });

  it('reads an account missing from a refresh that failed after the check has re-read as unknown', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const clientWrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    verifyPubkeyBanned.mockResolvedValue(false);

    const { result } = renderHook(() => useModerationStatus(PUBKEY, EVENT_ID, false), { wrapper: clientWrapper });
    await waitFor(() => expect(result.current.isUserSuspended).toBe(false), { timeout: 5000 });

    await act(async () => {
      result.current.recheck();
    });
    await waitFor(() => expect(listSuspendedPubkeys).toHaveBeenCalledTimes(2), { timeout: 5000 });
    await waitFor(() => expect(result.current.isAccountStatusLoading).toBe(false), { timeout: 5000 });
    expect(result.current.isUserSuspended).toBe(false);

    listSuspendedPubkeys.mockRejectedValue(new Error('relay unreachable'));
    await act(async () => {
      await client.refetchQueries({ queryKey: ['suspended-pubkeys'] });
    });
    expect(client.getQueryState(['suspended-pubkeys'])?.status).toBe('error');
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 50));
    });

    expect(result.current.isUserSuspended).toBeNull();
    expect(result.current.isUserSuspended).not.toBe(false);
  });

  it('does not count a list read that started before the check as its answer', async () => {
    // A list with no data yet has its in-flight read JOINED by a refetch rather
    // than replaced. If the moderator acts while the suspended list's first
    // read is still running, that read carries the pre-action list, and must
    // not pass for the re-read the check asked for.
    let resolveFirstRead: (value: Array<{ pubkey: string }>) => void = () => {};
    listSuspendedPubkeys
      .mockImplementationOnce(() => new Promise(resolve => { resolveFirstRead = resolve; }))
      .mockResolvedValue([{ pubkey: PUBKEY }]);   // the read after the Suspend
    verifyPubkeyBanned.mockResolvedValue(false);

    const { result } = renderHook(() => useModerationStatus(PUBKEY, EVENT_ID, false), { wrapper });
    await waitFor(() => expect(listSuspendedPubkeys).toHaveBeenCalledTimes(1), { timeout: 5000 });

    // The moderator suspends while the first read is still out.
    await act(async () => {
      result.current.recheck();
    });
    await waitFor(() => expect(listSuspendedPubkeys).toHaveBeenCalledTimes(2), { timeout: 5000 });

    // The first read lands late, with the pre-Suspend list.
    await act(async () => {
      resolveFirstRead([]);
      await new Promise(resolve => setTimeout(resolve, 50));
    });

    await waitFor(() => expect(result.current.isUserSuspended).toBe(true), { timeout: 5000 });
  });

  it('reads an account missing from a paused re-read as unknown, not as not suspended', async () => {
    // The dangerous direction: absence from a copy that predates the check is
    // not a confirmed negative, and nothing newer is coming until the browser
    // is back online.
    verifyPubkeyBanned.mockResolvedValue(false);
    const { result } = renderHook(() => useModerationStatus(PUBKEY, EVENT_ID, false), { wrapper });
    await waitFor(() => expect(result.current.isUserSuspended).toBe(false), { timeout: 5000 });

    onlineManager.setOnline(false);
    try {
      await act(async () => {
        result.current.recheck();
      });
      await waitFor(() => expect(verifyPubkeyBanned).toHaveBeenCalledTimes(1), { timeout: 5000 });
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 100));
      });

      expect(result.current.isUserSuspended).toBeNull();
      expect(result.current.isUserSuspended).not.toBe(false);
    } finally {
      onlineManager.setOnline(true);
    }
  });

  it('does not count a read that answered during the live check as the re-read', async () => {
    // Another screen's read of the list can land while the live check is still
    // running. That read is not the re-read the check asks for, so the re-read
    // has to be measured from after the live check, not from when it began.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const clientWrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    listSuspendedPubkeys.mockResolvedValueOnce([{ pubkey: PUBKEY }]);
    let resolveVerify: (value: boolean) => void = () => {};
    verifyPubkeyBanned.mockImplementationOnce(() => new Promise<boolean>(resolve => { resolveVerify = resolve; }));

    const { result } = renderHook(() => useModerationStatus(PUBKEY, EVENT_ID, false), { wrapper: clientWrapper });
    await waitFor(() => expect(result.current.isUserSuspended).toBe(true), { timeout: 5000 });

    // The moderator unsuspends; the live check is slow.
    await act(async () => {
      result.current.recheck();
    });
    await waitFor(() => expect(verifyPubkeyBanned).toHaveBeenCalledTimes(1), { timeout: 5000 });

    // Meanwhile another screen's read returns the pre-action list.
    listSuspendedPubkeys.mockResolvedValueOnce([{ pubkey: PUBKEY }]);
    await act(async () => {
      await client.refetchQueries({ queryKey: ['suspended-pubkeys'] });
    });

    // The re-read after the live check is still out when the check answers.
    listSuspendedPubkeys.mockImplementation(() => new Promise(() => {}));
    await act(async () => {
      resolveVerify(false);
      await new Promise(resolve => setTimeout(resolve, 50));
    });

    expect(result.current.isAccountStatusLoading).toBe(true);
  });

  it('does not count a banned-list read that started before the check as its answer', async () => {
    // The banned twin of the suspended case. With the live check inconclusive,
    // the list is all that answers; a pre-Unban read joined by the refetch
    // would show the account as banned, confirmed, right after the Unban.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const clientWrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    let resolveFirstRead: (value: Array<{ pubkey: string }>) => void = () => {};
    listBannedPubkeys
      .mockImplementationOnce(() => new Promise(resolve => { resolveFirstRead = resolve; }))
      .mockImplementation(() => new Promise(() => {}));   // the re-read after the Unban hangs
    verifyPubkeyBanned.mockResolvedValue(null);

    const { result } = renderHook(() => useModerationStatus(PUBKEY, EVENT_ID, false), { wrapper: clientWrapper });
    await waitFor(() => expect(listBannedPubkeys).toHaveBeenCalledTimes(1), { timeout: 5000 });

    await act(async () => {
      result.current.recheck();
    });
    await waitFor(() => expect(listBannedPubkeys).toHaveBeenCalledTimes(2), { timeout: 5000 });

    // The first read lands late, with the pre-Unban list.
    await act(async () => {
      resolveFirstRead([{ pubkey: PUBKEY }]);
      await new Promise(resolve => setTimeout(resolve, 50));
    });

    expect(result.current.isUserBanned).not.toBe(true);
    expect(result.current.isAccountStatusLoading).toBe(true);
    // Cancelling must undo the read, not record it as a failure: a recorded
    // failure on a list with no data trips the reports queue's cold-failure
    // pane until the replacement read lands.
    expect(client.getQueryState(['banned-pubkeys'])?.errorUpdateCount).toBe(0);
  });

  it("does not hold an environment switch's fresh queries, which count from zero, behind the old marks", async () => {
    // One client, so the switch is a real queryClient.clear() rather than the
    // fresh client the default wrapper builds on every rerender.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const clientWrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    verifyPubkeyBanned.mockResolvedValue(false);

    const { result, rerender } = renderHook(() => useModerationStatus(PUBKEY, EVENT_ID, false), { wrapper: clientWrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false), { timeout: 5000 });

    // A check in the old environment leaves marks behind.
    await act(async () => {
      result.current.recheck();
    });
    await waitFor(() => expect(result.current.isAccountStatusLoading).toBe(false), { timeout: 5000 });

    apiUrl.value = 'https://api.b.example';
    act(() => {
      client.clear();
    });
    rerender();

    // The new environment's lists load once and answer; the account is
    // confirmed not suspended, not stuck behind the old environment's mark.
    await waitFor(() => expect(result.current.isUserSuspended).toBe(false), { timeout: 5000 });
    expect(result.current.isUserSuspendedStale).toBe(false);
  });

  it('does not hold a cleared cache behind the old marks when the environment stays the same', async () => {
    // EnvironmentSelector clears the cache even when the moderator re-selects
    // the environment already in use, so the lists' queries are replaced and
    // count from zero with no apiUrl change.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const clientWrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    verifyPubkeyBanned.mockResolvedValue(null);

    const { result, rerender } = renderHook(() => useModerationStatus(PUBKEY, EVENT_ID, false), { wrapper: clientWrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false), { timeout: 5000 });

    // Two checks leave marks above what a fresh query's first read counts.
    for (let i = 0; i < 2; i++) {
      await act(async () => {
        result.current.recheck();
      });
      await waitFor(() => expect(result.current.isAccountStatusLoading).toBe(false), { timeout: 5000 });
    }
    expect(client.getQueryState(['suspended-pubkeys'])?.dataUpdateCount).toBeGreaterThan(1);

    listBannedPubkeys.mockResolvedValue([{ pubkey: PUBKEY }]);
    act(() => {
      client.clear();
    });
    rerender();

    // The fresh lists' first reads are current: absence is a confirmed
    // negative and presence is not last known.
    await waitFor(() => expect(client.getQueryState(['suspended-pubkeys'])?.dataUpdateCount).toBe(1), { timeout: 2000 });
    await waitFor(() => expect(client.getQueryState(['banned-pubkeys'])?.dataUpdateCount).toBe(1), { timeout: 2000 });
    await waitFor(() => expect(result.current.isAccountStatusLoading).toBe(false), { timeout: 2000 });
    expect(result.current.isUserSuspended).toBe(false);
    expect(result.current.isUserSuspendedStale).toBe(false);
    expect(result.current.isUserBanned).toBe(true);
    expect(result.current.isUserBannedStale).toBe(false);
  });

  // --- A copy still re-reading after a check is not current ------------------
  //
  // Until an account list has answered since the check asked it to re-read,
  // the copy on screen predates the moderator's action. That holds while the
  // re-read is still out, not only once it has failed or paused. Presence from
  // that copy is shown as last known; absence from it is unknown.

  it('shows a ban from the pre-Unban copy as last known while the re-read is still out', async () => {
    listBannedPubkeys.mockResolvedValueOnce([{ pubkey: PUBKEY }]);
    verifyPubkeyBanned.mockResolvedValue(null);

    const { result } = renderHook(() => useModerationStatus(PUBKEY, EVENT_ID, false), { wrapper });
    await waitFor(() => expect(result.current.isUserBanned).toBe(true), { timeout: 5000 });
    expect(result.current.isUserBannedStale).toBe(false);

    // The moderator unbans. The live check cannot answer and the re-read hangs.
    listBannedPubkeys.mockImplementation(() => new Promise(() => {}));
    await act(async () => {
      result.current.recheck();
    });
    await waitFor(() => expect(listBannedPubkeys).toHaveBeenCalledTimes(2), { timeout: 5000 });
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 50));
    });

    expect(result.current.isUserBanned).toBe(true);
    expect(result.current.isUserBannedStale).toBe(true);
    expect(result.current.isAccountStatusLoading).toBe(true);
  });

  it('keeps a failed refresh stale once a check starts a re-read', async () => {
    // One client, so the failed refresh and the check share the same queries.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const clientWrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    listBannedPubkeys.mockResolvedValueOnce([{ pubkey: PUBKEY }]);
    listSuspendedPubkeys.mockResolvedValueOnce([{ pubkey: PUBKEY }]);
    verifyPubkeyBanned.mockResolvedValue(null);

    const { result } = renderHook(() => useModerationStatus(PUBKEY, EVENT_ID, false), { wrapper: clientWrapper });
    await waitFor(() => {
      expect(result.current.isUserBanned).toBe(true);
      expect(result.current.isUserSuspended).toBe(true);
    }, { timeout: 5000 });

    // A refresh of both lists fails, its retry included. Not ...Once: a single
    // rejection would let the shared definition's retry succeed.
    listBannedPubkeys.mockRejectedValue(new Error('relay unreachable'));
    listSuspendedPubkeys.mockRejectedValue(new Error('relay unreachable'));
    await act(async () => {
      await Promise.all([
        client.refetchQueries({ queryKey: ['banned-pubkeys'] }),
        client.refetchQueries({ queryKey: ['suspended-pubkeys'] }),
      ]);
    });
    expect(client.getQueryState(['banned-pubkeys'])?.status).toBe('error');
    expect(client.getQueryState(['suspended-pubkeys'])?.status).toBe('error');
    await waitFor(() => {
      expect(result.current.isUserBannedStale).toBe(true);
      expect(result.current.isUserSuspendedStale).toBe(true);
    }, { timeout: 5000 });

    // Then a check asks both lists to re-read, and the re-reads hang.
    listBannedPubkeys.mockImplementation(() => new Promise(() => {}));
    listSuspendedPubkeys.mockImplementation(() => new Promise(() => {}));
    await act(async () => {
      result.current.recheck();
    });
    await waitFor(() => {
      expect(listBannedPubkeys).toHaveBeenCalledTimes(4);
      expect(listSuspendedPubkeys).toHaveBeenCalledTimes(4);
    }, { timeout: 5000 });
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 50));
    });

    expect(result.current.isAccountStatusLoading).toBe(true);
    expect(result.current.isUserBanned).toBe(true);
    expect(result.current.isUserBannedStale).toBe(true);
    expect(result.current.isUserSuspended).toBe(true);
    expect(result.current.isUserSuspendedStale).toBe(true);
  });

  it('reads an account missing from a copy still re-reading as unknown, not as not suspended', async () => {
    verifyPubkeyBanned.mockResolvedValue(false);
    const { result } = renderHook(() => useModerationStatus(PUBKEY, EVENT_ID, false), { wrapper });
    await waitFor(() => expect(result.current.isUserSuspended).toBe(false), { timeout: 5000 });

    // After a Suspend, the re-read hangs. The copy on screen predates it.
    listSuspendedPubkeys.mockImplementation(() => new Promise(() => {}));
    await act(async () => {
      result.current.recheck();
    });
    await waitFor(() => expect(listSuspendedPubkeys).toHaveBeenCalledTimes(2), { timeout: 5000 });
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 50));
    });

    expect(result.current.isAccountStatusLoading).toBe(true);
    expect(result.current.isUserSuspended).toBeNull();
    expect(result.current.isUserSuspended).not.toBe(false);
  });

  it('keeps the next report unknown, not "not banned", while the banned re-read is still out', async () => {
    // The banned twin of 'keeps the next report on "checking"...'. Moving to
    // the next report clears the live answer but keeps the marks, so the lists
    // answer alone, and the banned list has not answered since the check.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const clientWrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const OTHER = 'c'.repeat(64);
    verifyPubkeyBanned.mockResolvedValue(false);

    const { result, rerender } = renderHook(({ pk }) => useModerationStatus(pk, EVENT_ID, false), {
      wrapper: clientWrapper,
      initialProps: { pk: PUBKEY },
    });
    await waitFor(() => expect(result.current.isUserBanned).toBe(false), { timeout: 5000 });

    listBannedPubkeys.mockImplementation(() => new Promise(() => {}));
    await act(async () => {
      result.current.recheck();
    });
    await waitFor(() => expect(listBannedPubkeys).toHaveBeenCalledTimes(2), { timeout: 5000 });

    // The next report is an event report found normally, so no check runs.
    rerender({ pk: OTHER });
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 60));
    });

    expect(result.current.isUserBanned).toBeNull();
    expect(result.current.isUserBanned).not.toBe(false);
    expect(result.current.isAccountStatusLoading).toBe(true);
  });

  // Each account list's first read counts on its own: the account status is
  // not settled until both have answered, even with no check running.

  it('reports the account status as loading while only the banned list has not answered yet', async () => {
    listBannedPubkeys.mockImplementation(() => new Promise(() => {}));

    const { result } = renderHook(() => useModerationStatus(PUBKEY, EVENT_ID, false), { wrapper });
    await waitFor(() => expect(listSuspendedPubkeys).toHaveBeenCalledTimes(1), { timeout: 5000 });
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 50));
    });

    expect(verifyPubkeyBanned).not.toHaveBeenCalled();
    expect(result.current.isUserSuspended).toBe(false);
    expect(result.current.isAccountStatusLoading).toBe(true);
  });

  it('reports the account status as loading while only the suspended list has not answered yet', async () => {
    listSuspendedPubkeys.mockImplementation(() => new Promise(() => {}));

    const { result } = renderHook(() => useModerationStatus(PUBKEY, EVENT_ID, false), { wrapper });
    await waitFor(() => expect(listBannedPubkeys).toHaveBeenCalledTimes(1), { timeout: 5000 });
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 50));
    });

    expect(verifyPubkeyBanned).not.toHaveBeenCalled();
    expect(result.current.isUserBanned).toBe(false);
    expect(result.current.isAccountStatusLoading).toBe(true);
  });

  // --- The check that follows a moderator's action ---------------------------
  //
  // Right after an action, the lists on screen and the previous check's answer
  // both predate it. Until the live check answers, neither is confirmed: the
  // previous answer no longer outranks the lists, presence from a pre-action
  // copy is last known, absence from it is unknown, and a list read that
  // finished after the action is current.

  function sharedClient() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const clientWrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    return { client, clientWrapper };
  }
  const hang = () => new Promise(() => {});
  const settle = () => act(async () => {
    await new Promise(resolve => setTimeout(resolve, 60));
  });

  it('shows a pre-Unban ban as last known while the live check after the Unban runs', async () => {
    listBannedPubkeys.mockResolvedValueOnce([{ pubkey: PUBKEY }]);
    const { result } = renderHook(() => useModerationStatus(PUBKEY, EVENT_ID, false), { wrapper });
    await waitFor(() => expect(result.current.isUserBanned).toBe(true), { timeout: 5000 });
    expect(result.current.isUserBannedStale).toBe(false);

    // The Unban succeeded. The relay is slow: the re-read and the live check
    // are both still out.
    listBannedPubkeys.mockImplementation(hang);
    verifyPubkeyBanned.mockImplementation(hang);
    await act(async () => {
      result.current.recheckAfterAction();
    });
    await waitFor(() => expect(result.current.isChecking).toBe(true), { timeout: 5000 });
    await settle();

    expect(result.current.isUserBanned).toBe(true);
    expect(result.current.isUserBannedStale).toBe(true);
    expect(result.current.isAccountStatusLoading).toBe(true);
  });

  it('lets a list read after the Unban overrule the previous check while the live check runs', async () => {
    // A user report: the check when it opened confirmed the ban.
    const { client, clientWrapper } = sharedClient();
    listBannedPubkeys.mockResolvedValue([{ pubkey: PUBKEY }]);
    verifyPubkeyBanned.mockResolvedValueOnce(true);
    const { result } = renderHook(() => useModerationStatus(PUBKEY, null, false), { wrapper: clientWrapper });
    await waitFor(() => expect(verifyPubkeyBanned).toHaveBeenCalledTimes(1), { timeout: 5000 });
    await waitFor(() => expect(result.current.isAccountStatusLoading).toBe(false), { timeout: 5000 });
    expect(result.current.isUserBanned).toBe(true);

    // The Unban succeeded. The list answers promptly without the account; the
    // live check is slow. A read another screen starts at the same moment,
    // like an invalidation, may be replaced but must not leave the list
    // uncounted.
    listBannedPubkeys.mockResolvedValue([]);
    verifyPubkeyBanned.mockImplementation(hang);
    const readsBefore = listBannedPubkeys.mock.calls.length;
    await act(async () => {
      void client.invalidateQueries({ queryKey: ['banned-pubkeys'] });
      result.current.recheckAfterAction();
    });
    await waitFor(() => expect(listBannedPubkeys.mock.calls.length).toBeGreaterThan(readsBefore), { timeout: 5000 });
    await settle();

    expect(result.current.isChecking).toBe(true);
    expect(result.current.isUserBanned).toBe(false);
    expect(result.current.isUserBannedStale).toBe(false);
  });

  it('lets a list read after the Ban overrule the previous check while the live check runs', async () => {
    // A user report: the check when it opened found the account not banned.
    const { clientWrapper } = sharedClient();
    verifyPubkeyBanned.mockResolvedValueOnce(false);
    const { result } = renderHook(() => useModerationStatus(PUBKEY, null, false), { wrapper: clientWrapper });
    await waitFor(() => expect(verifyPubkeyBanned).toHaveBeenCalledTimes(1), { timeout: 5000 });
    await waitFor(() => expect(result.current.isAccountStatusLoading).toBe(false), { timeout: 5000 });
    expect(result.current.isUserBanned).toBe(false);

    // The Ban succeeded. The list answers promptly with the account; the live
    // check is slow.
    listBannedPubkeys.mockResolvedValue([{ pubkey: PUBKEY }]);
    verifyPubkeyBanned.mockImplementation(hang);
    await act(async () => {
      result.current.recheckAfterAction();
    });
    await settle();

    expect(result.current.isChecking).toBe(true);
    expect(result.current.isUserBanned).toBe(true);
    expect(result.current.isUserBannedStale).toBe(false);
  });

  it('reads an account missing from the pre-Suspend copy as unknown while the live check runs', async () => {
    const { result } = renderHook(() => useModerationStatus(PUBKEY, EVENT_ID, false), { wrapper });
    await waitFor(() => expect(result.current.isUserSuspended).toBe(false), { timeout: 5000 });

    // The Suspend succeeded. The suspended re-read and the live check hang.
    listSuspendedPubkeys.mockImplementation(hang);
    verifyPubkeyBanned.mockImplementation(hang);
    await act(async () => {
      result.current.recheckAfterAction();
    });
    await settle();

    expect(result.current.isChecking).toBe(true);
    expect(result.current.isUserSuspended).toBeNull();
    expect(result.current.isUserSuspended).not.toBe(false);
    expect(result.current.isAccountStatusLoading).toBe(true);
  });

  it('lets a suspended-list read after the Suspend count while the live check runs', async () => {
    const { result } = renderHook(() => useModerationStatus(PUBKEY, EVENT_ID, false), { wrapper });
    await waitFor(() => expect(result.current.isUserSuspended).toBe(false), { timeout: 5000 });

    // The Suspend succeeded. The list answers promptly with the account; the
    // live check is slow.
    listSuspendedPubkeys.mockResolvedValue([{ pubkey: PUBKEY }]);
    verifyPubkeyBanned.mockImplementation(hang);
    await act(async () => {
      result.current.recheckAfterAction();
    });
    await settle();

    expect(result.current.isChecking).toBe(true);
    expect(result.current.isUserSuspended).toBe(true);
    expect(result.current.isUserSuspendedStale).toBe(false);
  });

  it('does not count a first read that started before the action as a read after it', async () => {
    // A list with no data yet has its in-flight read JOINED by a refetch, not
    // replaced. That read carries the pre-action list and must not pass for
    // the re-read the check after the action asks for.
    let resolveFirstRead: (value: Array<{ pubkey: string }>) => void = () => {};
    listSuspendedPubkeys
      .mockImplementationOnce(() => new Promise(resolve => { resolveFirstRead = resolve; }))
      .mockImplementation(hang);
    verifyPubkeyBanned.mockImplementation(hang);
    const { result } = renderHook(() => useModerationStatus(PUBKEY, EVENT_ID, false), { wrapper });
    await waitFor(() => expect(listSuspendedPubkeys).toHaveBeenCalledTimes(1), { timeout: 5000 });

    // The moderator suspends while the first read is still out.
    await act(async () => {
      result.current.recheckAfterAction();
    });

    // The first read lands late, with the pre-Suspend list.
    await act(async () => {
      resolveFirstRead([]);
    });
    await settle();

    expect(result.current.isUserSuspended).toBeNull();
    expect(result.current.isUserSuspended).not.toBe(false);
  });

  it('keeps a confirmed answer through a plain Re-check, so routine checks do not flicker', async () => {
    // Only a check after an action supersedes the previous answer. A Re-check,
    // or the check when a report opens, has no reason to doubt it.
    const { clientWrapper } = sharedClient();
    verifyPubkeyBanned.mockResolvedValueOnce(true);
    const { result } = renderHook(() => useModerationStatus(PUBKEY, null, false), { wrapper: clientWrapper });
    await waitFor(() => expect(verifyPubkeyBanned).toHaveBeenCalledTimes(1), { timeout: 5000 });
    await waitFor(() => expect(result.current.isAccountStatusLoading).toBe(false), { timeout: 5000 });
    expect(result.current.isUserBanned).toBe(true);

    verifyPubkeyBanned.mockImplementation(hang);
    await act(async () => {
      result.current.recheck();
    });
    await settle();

    expect(result.current.isChecking).toBe(true);
    expect(result.current.isUserBanned).toBe(true);
    expect(result.current.isUserBannedStale).toBe(false);
  });
});
