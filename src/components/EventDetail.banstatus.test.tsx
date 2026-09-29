// ABOUTME: Pins how EventDetail shows a ban carried over from a copy that is not current.
// ABOUTME: A last-known ban must not read as confirmed, and Unban stays available.

import { act, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NostrEvent } from '@nostrify/nostrify';
import { EventDetail } from './EventDetail';

// useModerationStatus keeps a ban from the last good read when the latest
// refresh failed or has not answered since the latest check, and says so with
// isUserBannedStale. Right after an Unban that can be exactly wrong, so the
// pane shows it as last known, the way the report pane does.

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
}));

vi.mock('@/hooks/useAdminApi', () => ({ useAdminApi: () => api }));
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

const modStatus = vi.hoisted(() => ({
  isUserBanned: true as boolean | null,
  isUserBannedStale: false,
  isEventGone: false as boolean | null,
  isChecking: false,
  isUserBanChecking: false,
  isAccountStatusLoading: false,
  recheck: vi.fn(),
}));
vi.mock('@/hooks/useModerationStatus', async () => {
  const { moderationStatusMock } = await import('@/test/moderationStatusMock');
  return { useModerationStatus: () => moderationStatusMock({ ...modStatus }) };
});

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

const LAST_KNOWN = 'Last known: banned. The latest check could not confirm it.';
const CHECKING = 'Last known: banned. Checking now.';

describe('EventDetail ban status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    modStatus.isUserBanned = true;
    modStatus.isUserBannedStale = false;
    modStatus.isEventGone = false;
    modStatus.isChecking = false;
    modStatus.isUserBanChecking = false;
    modStatus.isAccountStatusLoading = false;
  });

  it('states a confirmed ban as confirmed', () => {
    renderDetail();

    expect(screen.getByText('This user is banned from the relay.')).toBeInTheDocument();
    expect(screen.queryByText(LAST_KNOWN)).not.toBeInTheDocument();
  });

  it('shows a ban carried over from a copy that is not current as last known, and keeps Unban', () => {
    modStatus.isUserBannedStale = true;

    renderDetail();

    expect(screen.getByText(LAST_KNOWN)).toBeInTheDocument();
    expect(screen.queryByText('This user is banned from the relay.')).not.toBeInTheDocument();
    // No destructive banner at all: with the post present, a banner raised on
    // the last-known ban would fall through to claiming the post is deleted.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText('This event has been deleted from the relay.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /unban user/i })).toBeInTheDocument();
  });

  it('offers Re-check on a last-known ban, the way the report pane does', async () => {
    // Re-check re-runs the account status check, so a relay that answers
    // replaces "last known" with a confirmed status. The banner's Re-verify
    // only reports a verification result and would leave the note in place.
    modStatus.isUserBannedStale = true;

    renderDetail();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /re-check/i }));
    });
    expect(modStatus.recheck).toHaveBeenCalledTimes(1);
  });

  it('disables Re-check while a check is running', () => {
    modStatus.isUserBannedStale = true;
    modStatus.isChecking = true;
    modStatus.isUserBanChecking = true;
    modStatus.isAccountStatusLoading = true;

    renderDetail();

    expect(screen.getByRole('button', { name: /checking/i })).toBeDisabled();
  });

  // After the live check answers, the banned list's re-read can still be out.
  // The note says the ban is being checked then, so the button must agree.
  it('keeps Re-check disabled while the ban is still being checked after the live check answered', () => {
    modStatus.isUserBannedStale = true;
    modStatus.isChecking = false;
    modStatus.isUserBanChecking = true;
    modStatus.isAccountStatusLoading = true;

    renderDetail();

    expect(screen.getByText(CHECKING)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /checking/i })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /re-check/i })).not.toBeInTheDocument();
  });

  // Only the suspended list is still out: nothing can settle the ban any more.
  it('says the check could not confirm a last-known ban while only the suspension is still loading', () => {
    modStatus.isUserBannedStale = true;
    modStatus.isUserBanChecking = false;
    modStatus.isAccountStatusLoading = true;

    renderDetail();

    expect(screen.getByText(LAST_KNOWN)).toBeInTheDocument();
    expect(screen.queryByText(CHECKING)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /re-check/i })).toBeEnabled();
  });

  it('does not fold a last-known ban into the deleted-event banner', async () => {
    modStatus.isUserBannedStale = true;
    modStatus.isEventGone = true;
    api.verifyEventDeleted.mockResolvedValue(true);

    renderDetail();

    expect(screen.getByText('This event has been deleted from the relay.')).toBeInTheDocument();
    expect(
      screen.queryByText('This user is banned and this event has been deleted from the relay.'),
    ).not.toBeInTheDocument();
    expect(screen.getByText(LAST_KNOWN)).toBeInTheDocument();

    // The banner is about the post, so its Re-verify checks the post.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /re-verify/i }));
    });
    expect(api.verifyEventDeleted).toHaveBeenCalledWith(EVENT.id);
    expect(api.verifyPubkeyBanned).not.toHaveBeenCalled();
  });
});
