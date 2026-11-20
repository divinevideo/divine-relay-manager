// ABOUTME: Pins how suspended-list reads are ordered against this tab's Unsuspend: a read
// ABOUTME: takes its id when it starts, and markRestored records the latest id per environment.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider, defaultScheduler, notifyManager } from '@tanstack/react-query';
import { AppContext, type AppContextType } from '@/contexts/AppContext';
import { useSuspendedPubkeys } from '@/hooks/useRelayBanLists';
import { suspensionAfterRestore } from '@/lib/suspensionAfterRestore';
import { endRestoreWindow, markRestored, useSuspendedListReadAtRestore } from '@/lib/userStatsCache';

const listSuspendedPubkeys = vi.hoisted(() => vi.fn());
vi.mock('@/hooks/useAdminApi', () => ({ useAdminApi: () => ({ listSuspendedPubkeys }) }));

const PK = 'a'.repeat(64);
const RELAY_A = 'wss://relay-a.example.test';
const RELAY_B = 'wss://relay-b.example.test';

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

// The suspended list, the id recorded at this tab's Unsuspend, and the
// suspension useModerationStatus derives from them. `relayUrl` selects the
// environment the restore window is read in (useRestoreEnvironment).
function setup(relayUrl?: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const app = relayUrl === undefined ? undefined : ({ config: { relayUrl } } as unknown as AppContextType);
  const wrapper = ({ children }: { children: ReactNode }) => createElement(
    AppContext.Provider,
    { value: app },
    createElement(QueryClientProvider, { client: qc }, children),
  );
  const hook = renderHook(() => {
    const list = useSuspendedPubkeys();
    const atRestore = useSuspendedListReadAtRestore(PK);
    const listed = list.data ? list.data.some((e: { pubkey: string }) => e.pubkey === PK) : null;
    return { list, atRestore, corrected: suspensionAfterRestore(listed, list.readId, atRestore) };
  }, { wrapper });
  return { qc, hook };
}

// Resolves once the read settles. useSuspendedPubkeys sets `retry: 1`
// (baseOptions), which overrides the client's `retry: false`, so a failing read
// settles only after its one retry (React Query's ~1s first backoff). Awaiting
// it here keeps the failure tests deterministic, at that real-time cost.
const refetch = (qc: QueryClient) => act(async () => { await qc.refetchQueries({ queryKey: ['suspended-pubkeys'] }); });

// React Query batches observer notifications on a setTimeout(0), which an
// async act() does not wait for. On a microtask they settle inside act, so a
// read's answer (or a cancelled read's ignored answer) is on screen when the
// act that awaited it returns, with no polling or sleeping.
beforeAll(() => { notifyManager.setScheduler(queueMicrotask); });
afterAll(() => { notifyManager.setScheduler(defaultScheduler); });

// RTL's own cleanup (unmount) runs after each test: vite.config.ts sets
// `globals: true`. userStatsCache exports no reset for its restore windows, so
// each window this file opens is ended by its key.
afterEach(() => {
  for (const environment of [undefined, RELAY_A, RELAY_B]) endRestoreWindow(PK, environment);
  listSuspendedPubkeys.mockReset();
});

describe("suspended-list read ordering against this tab's Unsuspend", () => {
  // The race the ordering exists for: a read that started before the Unsuspend
  // can answer after it with the account still listed. Its id is the one taken
  // when it started, so the Unsuspend supersedes it.
  it('ignores a read started before the Unsuspend that answers after it', async () => {
    const d = deferred<{ pubkey: string }[]>();
    listSuspendedPubkeys.mockReturnValueOnce(d.promise);
    const { qc, hook } = setup();
    await waitFor(() => expect(listSuspendedPubkeys).toHaveBeenCalledTimes(1));

    await act(async () => { await markRestored(qc, PK, undefined); });
    await act(async () => { d.resolve([{ pubkey: PK }]); });

    await waitFor(() => expect(hook.result.current.list.data).toEqual([{ pubkey: PK }]));
    // Not a pass on a missing id: the read has one, and it is no later than
    // the one recorded at the Unsuspend.
    const { atRestore, list } = hook.result.current;
    expect(atRestore).toBeDefined();
    expect(list.readId).toBeDefined();
    expect(list.readId!).toBeLessThanOrEqual(atRestore!);
    expect(hook.result.current.corrected).toBe(false);
  });

  // The case a stale copy is about: the list's refresh after the Unsuspend
  // fails, so React Query keeps the pre-Unsuspend copy that lists the account.
  // That copy keeps its own read's id, so the Unsuspend still supersedes it.
  it('keeps discounting a pre-Unsuspend positive after the refresh fails', async () => {
    listSuspendedPubkeys.mockResolvedValueOnce([{ pubkey: PK }]);
    const { qc, hook } = setup();
    await waitFor(() => expect(hook.result.current.list.data).toEqual([{ pubkey: PK }]));
    const preUnsuspendRead = hook.result.current.list.readId;
    await act(async () => { await markRestored(qc, PK, undefined); });

    listSuspendedPubkeys.mockRejectedValue(new Error('down'));
    await refetch(qc);

    expect(hook.result.current.list.isError).toBe(true);
    expect(hook.result.current.list.data).toEqual([{ pubkey: PK }]);
    expect(hook.result.current.list.readId).toBe(preUnsuspendRead);
    expect(hook.result.current.corrected).toBe(false);
  });

  // Another moderator suspended the account again after this tab's Unsuspend.
  it('honours a read started after the Unsuspend, and keeps it after a failed refresh', async () => {
    listSuspendedPubkeys.mockResolvedValueOnce([]);
    const { qc, hook } = setup();
    await waitFor(() => expect(hook.result.current.list.data).toEqual([]));
    await act(async () => { await markRestored(qc, PK, undefined); });

    listSuspendedPubkeys.mockResolvedValueOnce([{ pubkey: PK }]);
    await refetch(qc);
    await waitFor(() => expect(hook.result.current.list.data).toEqual([{ pubkey: PK }]));
    expect(hook.result.current.corrected).toBe(true);

    const postUnsuspendRead = hook.result.current.list.readId;
    listSuspendedPubkeys.mockRejectedValue(new Error('down'));
    await refetch(qc);

    expect(hook.result.current.list.isError).toBe(true);
    expect(hook.result.current.list.readId).toBe(postUnsuspendRead);
    expect(hook.result.current.corrected).toBe(true);
  });

  // A refresh that started before the Unsuspend is cancelled by a later one
  // (refetchQueries cancels the read in flight). The later read lists the
  // account (suspended again since), so it counts. The cancelled read's late
  // answer must not replace it: its pre-Unsuspend id would discount that
  // suspension.
  it('does not let a cancelled pre-Unsuspend refresh that answers late replace a later read', async () => {
    const OTHER = { pubkey: 'b'.repeat(64) };
    const old = deferred<{ pubkey: string }[]>();
    listSuspendedPubkeys.mockResolvedValueOnce([]);
    const { qc, hook } = setup();
    await waitFor(() => expect(hook.result.current.list.data).toEqual([]));

    listSuspendedPubkeys.mockReturnValueOnce(old.promise);
    act(() => { void qc.refetchQueries({ queryKey: ['suspended-pubkeys'] }); });
    await waitFor(() => expect(hook.result.current.list.fetchStatus).toBe('fetching'));
    await act(async () => { await markRestored(qc, PK, undefined); });

    listSuspendedPubkeys.mockResolvedValueOnce([{ pubkey: PK }]);
    await refetch(qc);
    expect(hook.result.current.list.data).toEqual([{ pubkey: PK }]);
    const laterRead = hook.result.current.list.readId;
    expect(hook.result.current.corrected).toBe(true);

    await act(async () => {
      old.resolve([{ pubkey: PK }, OTHER]);
      await old.promise;
    });

    expect(hook.result.current.list.data).toEqual([{ pubkey: PK }]);
    expect(hook.result.current.list.readId).toBe(laterRead);
    expect(hook.result.current.corrected).toBe(true);
  });

  // This tab unsuspended the account, another moderator suspended it again
  // (a read since lists it), and this tab unsuspended it again. The second
  // Unsuspend supersedes that read, so it must record the newer id.
  it('records the newer read id when the account is unsuspended again', async () => {
    listSuspendedPubkeys.mockResolvedValueOnce([]);
    const { qc, hook } = setup();
    await waitFor(() => expect(hook.result.current.list.data).toEqual([]));
    await act(async () => { await markRestored(qc, PK, undefined); });

    listSuspendedPubkeys.mockResolvedValueOnce([{ pubkey: PK }]);
    await refetch(qc);
    await waitFor(() => expect(hook.result.current.list.data).toEqual([{ pubkey: PK }]));
    expect(hook.result.current.corrected).toBe(true);

    await act(async () => { await markRestored(qc, PK, undefined); });
    expect(hook.result.current.atRestore).toBe(hook.result.current.list.readId);
    expect(hook.result.current.corrected).toBe(false);
  });

  // Restore windows are per environment: an Unsuspend on one relay says
  // nothing about the account's suspension on another.
  it('does not discount a read in another environment', async () => {
    listSuspendedPubkeys.mockResolvedValueOnce([{ pubkey: PK }]);
    const { qc, hook } = setup(RELAY_B);
    await waitFor(() => expect(hook.result.current.list.data).toEqual([{ pubkey: PK }]));

    await act(async () => { await markRestored(qc, PK, RELAY_A); });

    expect(hook.result.current.atRestore).toBeUndefined();
    expect(hook.result.current.corrected).toBe(true);
  });

  it('discounts a read in the environment the account was restored in', async () => {
    listSuspendedPubkeys.mockResolvedValueOnce([{ pubkey: PK }]);
    const { qc, hook } = setup(RELAY_A);
    await waitFor(() => expect(hook.result.current.list.data).toEqual([{ pubkey: PK }]));

    await act(async () => { await markRestored(qc, PK, RELAY_A); });

    expect(hook.result.current.atRestore).toBe(hook.result.current.list.readId);
    expect(hook.result.current.corrected).toBe(false);
  });
});
