// ABOUTME: Pins the three-way outcome of EventDetail's manual Re-verify control.
// ABOUTME: A check that could not run must read as inconclusive, not as "not banned".

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NostrEvent } from '@nostrify/nostrify';
import { EventDetail } from './EventDetail';

// The banner's Re-verify button is the one place a moderator asks the relay a
// direct question. Answering "User is NOT in banned list" when the relay was
// never reached states a fact nothing observed, so the unknown outcome gets its
// own branch rather than sharing the negative one.

const REPORTED_PUBKEY = 'd'.repeat(64);
const MOD_PUBKEY = 'e'.repeat(64);

const api = vi.hoisted(() => ({
  banPubkey: vi.fn(),
  deleteEvent: vi.fn(),
  unbanPubkey: vi.fn(),
  allowEvent: vi.fn(),
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
vi.mock('@/hooks/useNostr', () => ({ useNostr: () => ({ nostr: { query: vi.fn() } }) }));
vi.mock('@/hooks/useAuthor', () => ({ useAuthor: () => ({ data: undefined, isLoading: false }) }));
vi.mock('@/hooks/useUserStats', () => ({ useUserStats: () => ({ data: undefined, isLoading: false }) }));
vi.mock('@/hooks/useAgeReviewGuardRedirect', () => ({
  useAgeReviewGuardRedirect: () => ({ redirectIfGuarded: () => false }),
}));

// The banner only renders when the user reads as banned, which is what puts the
// Re-verify button on screen.
vi.mock('@/hooks/useModerationStatus', () => ({
  useModerationStatus: () => ({
    isUserBanned: true,
    isUserSuspended: false,
    isEventBanned: false,
    isEventGone: false,
    isLoading: false,
    isChecking: false,
    checkedAt: null,
    recheck: vi.fn(),
  }),
}));

// Heavy presentational children drag in relay sockets of their own and say
// nothing about the verification outcome.
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

async function clickReVerify() {
  const button = await screen.findByRole('button', { name: /re-verify/i });
  // The handler resolves the verification before setting state, so the click
  // has to flush inside act or the assertion races the update.
  await act(async () => {
    fireEvent.click(button);
  });
}

describe('EventDetail Re-verify', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports the ban as confirmed when the relay lists the pubkey', async () => {
    api.verifyPubkeyBanned.mockResolvedValue(true);

    renderDetail();
    await clickReVerify();

    await waitFor(() => {
      expect(screen.getByText('User ban verified - pubkey is in banned list')).toBeInTheDocument();
    });
  });

  it('reports the pubkey as absent when the relay answers without it', async () => {
    api.verifyPubkeyBanned.mockResolvedValue(false);

    renderDetail();
    await clickReVerify();

    await waitFor(() => {
      expect(screen.getByText('User is NOT in banned list')).toBeInTheDocument();
    });
  });

  it('reports inconclusive rather than absent when the check could not run', async () => {
    api.verifyPubkeyBanned.mockResolvedValue(null);

    renderDetail();
    await clickReVerify();

    await waitFor(() => {
      expect(screen.getByText('Verification failed - could not check status')).toBeInTheDocument();
    });
    expect(screen.queryByText('User is NOT in banned list')).not.toBeInTheDocument();
  });
});
