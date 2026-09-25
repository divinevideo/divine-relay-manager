// ABOUTME: Pins what EventDetail shows while the check after a moderator's action is running.
// ABOUTME: An Unban unconfirms the pre-Unban ban; a delete leaves a confirmed ban confirmed.

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NostrEvent } from '@nostrify/nostrify';
import { EventDetail } from './EventDetail';

// The real useModerationStatus, over mocked relay calls. Right after an Unban
// the ban list on screen is the pre-Unban copy, and the live check takes at
// least 1.5s here (EventDetail checks the account and the post). Until
// something answers after the Unban, that copy is last known, not confirmed.

const REPORTED_PUBKEY = 'd'.repeat(64);
const MOD_PUBKEY = 'e'.repeat(64);

const api = vi.hoisted(() => ({
  banPubkey: vi.fn(),
  deleteEvent: vi.fn(),
  unbanPubkey: vi.fn(),
  restoreEvent: vi.fn(),
  verifyPubkeyBanned: vi.fn(),
  verifyPubkeyUnbanned: vi.fn(),
  verifyEventDeleted: vi.fn(),
  logDecision: vi.fn(),
  listBannedPubkeys: vi.fn(),
  listBannedEvents: vi.fn(),
  listSuspendedPubkeys: vi.fn(),
}));

vi.mock('@/hooks/useAdminApi', () => ({
  useAdminApi: () => api,
  useApiUrl: () => 'https://api.a.example',
}));
vi.mock('@/hooks/useToast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({
    user: { pubkey: MOD_PUBKEY },
    getModeratorPubkey: async () => MOD_PUBKEY,
  }),
}));
vi.mock('@/hooks/useNostr', () => ({ useNostr: () => ({ nostr: { query: vi.fn().mockResolvedValue([]) } }) }));
vi.mock('@/hooks/useAuthor', () => ({ useAuthor: () => ({ data: undefined, isLoading: false }) }));
vi.mock('@/hooks/useUserStats', () => ({ useUserStats: () => ({ data: undefined, isLoading: false }) }));
vi.mock('@/hooks/useAgeReviewGuardRedirect', () => ({
  useAgeReviewGuardRedirect: () => ({ redirectIfGuarded: () => false }),
}));

vi.mock('@/components/HiveAIReport', () => ({ HiveAIReport: () => null }));
vi.mock('@/components/AIDetectionReport', () => ({ AIDetectionReport: () => null }));
vi.mock('@/components/SceneClassification', () => ({ SceneClassification: () => null }));
vi.mock('@/components/TranscriptAnalysis', () => ({ TranscriptAnalysis: () => null }));
vi.mock('@/components/ReporterCard', () => ({ ReporterList: () => null }));
vi.mock('@/components/MediaPreview', () => ({ MediaPreview: () => null }));
vi.mock('@/components/UserIdentifier', () => ({ UserIdentifier: () => null }));

const EVENT: NostrEvent = {
  id: 'c'.repeat(64),
  pubkey: REPORTED_PUBKEY,
  created_at: 1751000000,
  kind: 1,
  tags: [],
  content: 'reported content',
  sig: 'c'.repeat(128),
};

const BANNED = 'This user is banned from the relay.';
const LAST_KNOWN = 'Last known: banned. The latest check could not confirm it.';
const CHECKING = 'Last known: banned. Checking now.';
const hang = () => new Promise(() => {});

function renderDetail() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <EventDetail event={EVENT} />
    </QueryClientProvider>,
  );
}

describe('EventDetail after an action', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.listBannedPubkeys.mockResolvedValueOnce([{ pubkey: REPORTED_PUBKEY }]);
    api.listBannedEvents.mockResolvedValue([]);
    api.listSuspendedPubkeys.mockResolvedValue([]);
    api.unbanPubkey.mockResolvedValue(undefined);
    api.deleteEvent.mockResolvedValue(undefined);
    api.logDecision.mockResolvedValue(undefined);
  });

  it('shows the pre-Unban ban as being checked while the check after it runs', async () => {
    renderDetail();
    // Before the Unban, the list is current and says banned.
    expect(await screen.findByText(BANNED)).toBeInTheDocument();

    // The relay is slow: the re-read, the live check and the handler's own
    // verification are all still out.
    let answerLiveCheck: (banned: boolean | null) => void = () => {};
    api.listBannedPubkeys.mockImplementation(hang);
    api.verifyPubkeyBanned.mockImplementation(() => new Promise(resolve => { answerLiveCheck = resolve; }));
    api.verifyEventDeleted.mockResolvedValue(false);
    api.verifyPubkeyUnbanned.mockImplementation(hang);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Unban User$/ }));
    });
    await waitFor(() => expect(api.verifyPubkeyBanned).toHaveBeenCalledTimes(1));

    // Not confirmed, and not yet failed either: the check is still running.
    expect(screen.queryByText(BANNED)).not.toBeInTheDocument();
    expect(screen.getByText(CHECKING)).toBeInTheDocument();
    expect(screen.queryByText(LAST_KNOWN)).not.toBeInTheDocument();

    // The live check cannot answer, and the lists' re-read after it fails
    // (after its one retry). Only now has the check failed to confirm the ban.
    api.listBannedPubkeys.mockRejectedValue(new Error('relay unreachable'));
    await act(async () => {
      answerLiveCheck(null);
    });

    expect(await screen.findByText(LAST_KNOWN, {}, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.queryByText(CHECKING)).not.toBeInTheDocument();
    expect(screen.queryByText(BANNED)).not.toBeInTheDocument();
  });

  it('says the check could not confirm the ban once its re-read fails, while the suspended re-read is still out', async () => {
    renderDetail();
    expect(await screen.findByText(BANNED)).toBeInTheDocument();

    // The live check cannot answer and the banned re-read fails. The suspended
    // re-read hangs, so the account status as a whole is still loading, but
    // nothing on its way can settle the ban.
    api.listBannedPubkeys.mockRejectedValue(new Error('relay unreachable'));
    api.listSuspendedPubkeys.mockImplementation(hang);
    api.verifyPubkeyBanned.mockResolvedValue(null);
    api.verifyEventDeleted.mockResolvedValue(false);
    api.verifyPubkeyUnbanned.mockImplementation(hang);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Unban User$/ }));
    });

    expect(await screen.findByText(LAST_KNOWN, {}, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.queryByText(CHECKING)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /re-check/i })).toBeEnabled();
  });

  it('keeps a confirmed ban confirmed while the check after a delete runs', async () => {
    // A delete changes the post, not the account, so the ban on screen is not
    // made pre-action by it: no "last known" flicker on the banner.
    renderDetail();
    expect(await screen.findByText(BANNED)).toBeInTheDocument();

    api.listBannedPubkeys.mockImplementation(hang);
    api.verifyPubkeyBanned.mockImplementation(hang);
    api.verifyEventDeleted.mockImplementation(hang);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Ban Event$/ }));
    });
    const buttons = await screen.findAllByRole('button', { name: /^Ban Event$/ });
    await act(async () => {
      fireEvent.click(buttons[buttons.length - 1]);
    });
    await waitFor(() => expect(api.verifyPubkeyBanned).toHaveBeenCalledTimes(1));

    expect(screen.getByText(BANNED)).toBeInTheDocument();
    expect(screen.queryByText(LAST_KNOWN)).not.toBeInTheDocument();
    expect(screen.queryByText(CHECKING)).not.toBeInTheDocument();
  });
});
