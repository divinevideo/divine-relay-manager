// ABOUTME: Covers the ban wiring of the Labels tab
// ABOUTME: A ban that may have landed must not read as a destructive failure

import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { markRestored, useJustRestored } from '@/lib/userStatsCache';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Labels } from './Labels';
import { BanNotConfirmedError } from '@/lib/adminApi';
import { banFailureToast, banSuccessNote } from '@/lib/banFeedback';

const PUBKEY = 'a'.repeat(64);

const api = vi.hoisted(() => ({
  banPubkey: vi.fn(),
  verifyPubkeyBanned: vi.fn(),
}));
const toast = vi.hoisted(() => vi.fn());
const query = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/useAdminApi', () => ({ useAdminApi: () => api }));
vi.mock('@/hooks/useToast', () => ({ useToast: () => ({ toast }) }));
vi.mock('@nostrify/react', () => ({ useNostr: () => ({ nostr: { query } }) }));
// Children are irrelevant to the ban wiring and drag in their own dependencies.
vi.mock('@/components/LabelPublisher', () => ({ LabelPublisher: () => null }));
vi.mock('@/components/EventContentPreview', () => ({ EventContentPreview: () => null }));
vi.mock('@/components/UserProfilePreview', () => ({ UserProfilePreview: () => null }));
vi.mock('@/components/ReporterInfo', () => ({ ReportedBy: () => null }));
vi.mock('@/components/UserIdentifier', () => ({ UserIdentifier: () => null, UserDisplayName: () => null }));

/** One kind 1985 label on a pubkey, so a Ban User button renders. */
const LABEL_EVENT = {
  id: 'b'.repeat(64),
  pubkey: 'c'.repeat(64),
  created_at: 1_700_000_000,
  kind: 1985,
  tags: [['L', 'dtsp'], ['l', 'spam', 'dtsp'], ['p', PUBKEY]],
  content: '',
  sig: 'd'.repeat(128),
};

async function banFromLabels(client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })) {
  render(
    <QueryClientProvider client={client}>
      <Labels relayUrl="wss://relay.test" />
    </QueryClientProvider>,
  );
  const [trigger] = await screen.findAllByRole('button', { name: /Ban User/ });
  await act(async () => { fireEvent.click(trigger); });
  const buttons = await screen.findAllByRole('button', { name: /^Ban User$/ });
  // The dialog's action button is the one added by opening it.
  await act(async () => { fireEvent.click(buttons[buttons.length - 1]); });
}

describe('Labels ban', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    query.mockResolvedValue([LABEL_EVENT]);
    api.verifyPubkeyBanned.mockResolvedValue(true);
  });

  it('reports an unconfirmed ban as not confirmed, not as a destructive failure', async () => {
    const notConfirmed = new BanNotConfirmedError('timed out');
    api.banPubkey.mockRejectedValue(notConfirmed);
    const invalidate = vi.spyOn(QueryClient.prototype, 'invalidateQueries');

    await banFromLabels();

    await waitFor(() => expect(toast).toHaveBeenCalledWith(banFailureToast(notConfirmed)));
    expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({ variant: 'destructive' }));
    // The toast asks for a re-check; the ban lists must not be the stale ones.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['banned-pubkeys'] });
    invalidate.mockRestore();
  });

  it('keeps what the ban left unconfirmed on the final toast', async () => {
    api.banPubkey.mockResolvedValue({ unconfirmed: 'removal_error' });

    await banFromLabels();

    await waitFor(() =>
      expect(toast).toHaveBeenLastCalledWith(expect.objectContaining({
        title: 'User banned',
        description: banSuccessNote({ unconfirmed: 'removal_error' }),
      })),
    );
  });
});

// The relay hides a banned account's content, so a stats read from before the
// ban describes the other state (lib/userStatsCache). A ban that could not be
// confirmed may still have landed.
describe('Labels ban drops cached authored-content reads', () => {
  const STATS_KEY = ['user-stats', 'wss://relay.test', PUBKEY];

  beforeEach(() => {
    vi.clearAllMocks();
    query.mockResolvedValue([LABEL_EVENT]);
    api.verifyPubkeyBanned.mockResolvedValue(true);
  });

  it.each([
    ['a confirmed ban', () => api.banPubkey.mockResolvedValue({ unconfirmed: null })],
    ['a ban that could not be confirmed', () => api.banPubkey.mockRejectedValue(new BanNotConfirmedError('timed out'))],
  ])('after %s', async (_name, arrange) => {
    arrange();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    client.setQueryData(STATS_KEY, { postCount: 0 });

    await banFromLabels(client);

    await waitFor(() => expect(client.getQueryData(STATS_KEY)).toBeUndefined());
  });
});

describe('Labels ban ends the restore window', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    query.mockResolvedValue([LABEL_EVENT]);
    api.verifyPubkeyBanned.mockResolvedValue(true);
    api.banPubkey.mockResolvedValue({ unconfirmed: null });
  });

  it('after a ban that followed a restore', async () => {
    const { result } = renderHook(() => useJustRestored(PUBKEY));
    await act(async () => { await markRestored(new QueryClient(), PUBKEY, undefined); });
    expect(result.current).toBe(true);

    await banFromLabels();

    await waitFor(() => expect(result.current).toBe(false));
  });

  // A refused ban did not hide the account: the reads reset (the failure
  // settled), and an earlier unsuspend's window stays.
  it('keeps the window when the ban was refused', async () => {
    api.banPubkey.mockRejectedValue(new Error('relay refused'));
    const { result } = renderHook(() => useJustRestored(PUBKEY));
    await act(async () => { await markRestored(new QueryClient(), PUBKEY, undefined); });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    client.setQueryData(['user-stats', 'wss://relay.test', PUBKEY], { postCount: 0 });

    await banFromLabels(client);

    await waitFor(() => expect(client.getQueryData(['user-stats', 'wss://relay.test', PUBKEY])).toBeUndefined());
    expect(result.current).toBe(true);
  });
});
