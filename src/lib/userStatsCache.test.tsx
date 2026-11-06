import { afterEach, describe, it, expect, vi } from 'vitest';
import { render, renderHook, screen, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { endRestoreWindow, markHidden, markRestored, resetAccountContentReads, RESTORE_SETTLE_MS, useJustRestored } from './userStatsCache';
import { AppContext, type AppContextType } from '@/contexts/AppContext';
import { authoredContentStat } from './historyCount';

const PUBKEY = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

function setup(queryFn: () => Promise<{ postCount: number }>, key: readonly unknown[] = ['user-stats', 'wss://relay.test', PUBKEY]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const hook = renderHook(() => useQuery({ queryKey: key, queryFn }), { wrapper });
  return { client, hook };
}

describe('resetAccountContentReads', () => {
  // An action while the account's first stats read is still out. Invalidating
  // would join that read, which started before the action, and its answer would
  // land as fresh. The re-read after the reset is the relay's answer at that
  // moment, which right after an Unsuspend can still lag (see markRestored
  // below); this test only pins that the pre-action read is dropped.
  it('drops a read that started before the action and reads again', async () => {
    const beforeAction = deferred<{ postCount: number }>();
    const queryFn = vi.fn()
      .mockImplementationOnce(() => beforeAction.promise)
      .mockResolvedValueOnce({ postCount: 5 });
    const { client, hook } = setup(queryFn);
    await waitFor(() => expect(queryFn).toHaveBeenCalledTimes(1));

    await act(async () => { await resetAccountContentReads(client, PUBKEY); });
    await act(async () => { beforeAction.resolve({ postCount: 0 }); });

    await waitFor(() => expect(hook.result.current.data).toEqual({ postCount: 5 }));
    expect(queryFn).toHaveBeenCalledTimes(2);
  });

  it('clears a cached read so no screen shows it after the action', async () => {
    const client = new QueryClient();
    client.setQueryData(['user-stats', 'wss://relay.test', PUBKEY], { postCount: 0 });
    client.setQueryData(['user-posts-stats', 'https://api.test', PUBKEY], { count: 0 });

    await resetAccountContentReads(client, PUBKEY);

    expect(client.getQueryData(['user-stats', 'wss://relay.test', PUBKEY])).toBeUndefined();
    expect(client.getQueryData(['user-posts-stats', 'https://api.test', PUBKEY])).toBeUndefined();
  });

  it("leaves other accounts' reads alone", async () => {
    const client = new QueryClient();
    client.setQueryData(['user-stats', 'wss://relay.test', OTHER], { postCount: 3 });

    await resetAccountContentReads(client, PUBKEY);

    expect(client.getQueryData(['user-stats', 'wss://relay.test', OTHER])).toEqual({ postCount: 3 });
  });
});

describe('resetAccountContentReads key matching', () => {
  // A report's p tag can carry an uppercase pubkey (#313), and so can the key.
  it('matches the account whatever the case of its pubkey', async () => {
    const client = new QueryClient();
    client.setQueryData(['user-stats', 'wss://relay.test', PUBKEY.toUpperCase()], { postCount: 0 });

    await resetAccountContentReads(client, PUBKEY);

    expect(client.getQueryData(['user-stats', 'wss://relay.test', PUBKEY.toUpperCase()])).toBeUndefined();
  });
});

// Funnelcake drops the account from the suspended list at once, but its read
// filter catches up on a periodic refresh (about five minutes). So the re-read
// right after an Unsuspend can still come back empty, and with the account no
// longer suspended that would print as a plain "0 events".
describe('markRestored', () => {
  // Funnelcake's read filters refresh every five minutes. The window's last
  // re-read has to come after that refresh has finished, not on its boundary.
  it('keeps the window open past the relay\'s five-minute refresh', () => {
    expect(RESTORE_SETTLE_MS).toBeGreaterThan(5 * 60_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function Count({ pubkey, relay }: { pubkey: string; relay: { visible: boolean } }) {
    const { data } = useQuery({
      queryKey: ['user-stats', 'wss://relay.test', pubkey],
      queryFn: async () => ({ postCount: relay.visible ? 3 : 0 }),
    });
    const justRestored = useJustRestored(pubkey);
    return (
      <p>
        {authoredContentStat({
          count: data?.postCount, incomplete: false, suspended: false, suspendedStale: false,
          noun: 'events', limit: 20, justRestored,
        })}
      </p>
    );
  }

  it('qualifies the empty read until the relay catches up, then reads again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const pk = 'd'.repeat(64);
    const relay = { visible: false };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 2 * 60_000 } } });
    render(<QueryClientProvider client={client}><Count pubkey={pk} relay={relay} /></QueryClientProvider>);
    expect(await screen.findByText('0 events')).toBeInTheDocument();

    await act(async () => { await markRestored(client, pk, undefined); });
    expect(await screen.findByText('0 events (just restored; posts can take a few minutes to reappear)')).toBeInTheDocument();

    // The relay's filter catches up; nothing re-reads until the window ends.
    relay.visible = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(RESTORE_SETTLE_MS - 1000); });
    expect(screen.getByText('0 events (just restored; posts can take a few minutes to reappear)')).toBeInTheDocument();

    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(await screen.findByText('3 events')).toBeInTheDocument();
  });

  it('starts the window over when the account is unsuspended again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const pk = 'e'.repeat(64);
    const client = new QueryClient();
    const { result } = renderHook(() => useJustRestored(pk), {
      wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
    });

    await act(async () => { await markRestored(client, pk, undefined); });
    await act(async () => { await vi.advanceTimersByTimeAsync(RESTORE_SETTLE_MS - 1000); });
    await act(async () => { await markRestored(client, pk, undefined); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(result.current).toBe(true);

    await act(async () => { await vi.advanceTimersByTimeAsync(RESTORE_SETTLE_MS); });
    expect(result.current).toBe(false);
  });

  it('is only for the account that was unsuspended', async () => {
    const client = new QueryClient();
    await markRestored(client, 'f'.repeat(64), undefined);
    const { result } = renderHook(() => useJustRestored(OTHER));
    expect(result.current).toBe(false);
  });
});

// A ban or suspend after a restore hides the account again, so "just restored"
// would be wrong from then on.
describe('markHidden', () => {
  it('ends the restore window and resets the reads', async () => {
    const pk = '1a'.repeat(32);
    const client = new QueryClient();
    await markRestored(client, pk, undefined);
    client.setQueryData(['user-stats', 'wss://relay.test', pk], { postCount: 0 });
    const { result } = renderHook(() => useJustRestored(pk));
    expect(result.current).toBe(true);

    await act(async () => { await markHidden(client, pk, undefined); });

    expect(result.current).toBe(false);
    expect(client.getQueryData(['user-stats', 'wss://relay.test', pk])).toBeUndefined();
  });

  it('cancels the scheduled re-read of the window it ended', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const pk = '2b'.repeat(32);
      const client = new QueryClient();
      await markRestored(client, pk, undefined);
      endRestoreWindow(pk, undefined);
      // A later restore's window must not be cut short by the old timer: the
      // old one would fire two minutes into the new window.
      await act(async () => { await vi.advanceTimersByTimeAsync(2 * 60_000); });
      await markRestored(client, pk, undefined);
      const { result } = renderHook(() => useJustRestored(pk));
      await act(async () => { await vi.advanceTimersByTimeAsync(RESTORE_SETTLE_MS - 2 * 60_000 + 1000); });
      expect(result.current).toBe(true);
      await act(async () => { await vi.advanceTimersByTimeAsync(2 * 60_000); });
      expect(result.current).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

// Windows belong to the environment the action ran in. Switching environment
// clears the query cache but not this module, so a production restore must not
// read as "just restored" on staging.
describe('restore windows per environment', () => {
  const env = (relayUrl: string) => ({ children }: { children: ReactNode }) => (
    <AppContext.Provider value={{ config: { relayUrl, apiUrl: '', theme: 'light' }, updateConfig: () => {} } as AppContextType}>
      {children}
    </AppContext.Provider>
  );

  it('opens the window only in the environment of the action', async () => {
    const pk = '3c'.repeat(32);
    await markRestored(new QueryClient(), pk, 'wss://relay.prod.test');

    expect(renderHook(() => useJustRestored(pk), { wrapper: env('wss://relay.prod.test') }).result.current).toBe(true);
    expect(renderHook(() => useJustRestored(pk), { wrapper: env('wss://relay.staging.test') }).result.current).toBe(false);
  });

  it('ends only the window of the environment of the action', async () => {
    const pk = '4d'.repeat(32);
    await markRestored(new QueryClient(), pk, 'wss://relay.prod.test');
    await markRestored(new QueryClient(), pk, 'wss://relay.staging.test');

    endRestoreWindow(pk, 'wss://relay.staging.test');

    expect(renderHook(() => useJustRestored(pk), { wrapper: env('wss://relay.prod.test') }).result.current).toBe(true);
    expect(renderHook(() => useJustRestored(pk), { wrapper: env('wss://relay.staging.test') }).result.current).toBe(false);
  });
});
