// ABOUTME: Covers the ban wiring of the Labels tab
// ABOUTME: A ban that may have landed must not read as a destructive failure

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Labels } from './Labels';
import { BanNotConfirmedError } from '@/lib/adminApi';
import { banSuccessNote } from '@/lib/banFeedback';

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

async function banFromLabels() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
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
    api.banPubkey.mockRejectedValue(new BanNotConfirmedError('timed out'));

    await banFromLabels();

    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Ban not confirmed' })),
    );
    expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({ variant: 'destructive' }));
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
