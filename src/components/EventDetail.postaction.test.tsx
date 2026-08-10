// ABOUTME: Pins the post-action ban verification copy in EventDetail.
// ABOUTME: An unreachable relay must not report a banned-list lookup that never ran.

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NostrEvent } from '@nostrify/nostrify';
import { EventDetail } from './EventDetail';

// The re-verify control was fixed separately (EventDetail.reverify.test.tsx).
// This is the other hop in the same file: the verification that runs straight
// after a ban. Its negative copy is "Warning: User may not be banned - not
// found in banned list", whose trailing clause states the ban list was fetched
// and did not contain the pubkey — precisely what does not happen when the
// check itself failed.

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
vi.mock('@/hooks/useNostr', () => ({ useNostr: () => ({ nostr: { query: vi.fn().mockResolvedValue([]) } }) }));
vi.mock('@/hooks/useAuthor', () => ({ useAuthor: () => ({ data: undefined, isLoading: false }) }));
vi.mock('@/hooks/useUserStats', () => ({ useUserStats: () => ({ data: undefined, isLoading: false }) }));
vi.mock('@/hooks/useAgeReviewGuardRedirect', () => ({
  useAgeReviewGuardRedirect: () => ({ redirectIfGuarded: () => false }),
}));

// Drives which enforcement affordance renders: "Ban User" vs "Unban User".
const modStatus = vi.hoisted(() => ({ isUserBanned: false as boolean | null }));
vi.mock('@/hooks/useModerationStatus', () => ({
  useModerationStatus: () => ({
    isUserBanned: modStatus.isUserBanned,
    isUserSuspended: false,
    isEventBanned: false,
    isEventGone: false,
    isLoading: false,
    isChecking: false,
    checkedAt: null,
    recheck: vi.fn(),
  }),
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

/** Open the confirm dialog and press its action button. */
async function banTheUser() {
  const trigger = await screen.findByRole('button', { name: /^Ban User$/ });
  await act(async () => {
    fireEvent.click(trigger);
  });
  const buttons = await screen.findAllByRole('button', { name: /^Ban User$/ });
  await act(async () => {
    // The dialog's action button is the one added by opening it.
    fireEvent.click(buttons[buttons.length - 1]);
  });
}

describe('EventDetail post-ban verification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    modStatus.isUserBanned = false;
    api.banPubkey.mockResolvedValue(undefined);
  });

  it('confirms the ban when the relay lists the pubkey', async () => {
    api.verifyPubkeyBanned.mockResolvedValue(true);

    renderDetail();
    await banTheUser();

    await waitFor(() => {
      expect(screen.getByText('User ban verified - pubkey is in banned list')).toBeInTheDocument();
    });
  });

  it('warns about the ban list when the relay answered without the pubkey', async () => {
    api.verifyPubkeyBanned.mockResolvedValue(false);

    renderDetail();
    await banTheUser();

    await waitFor(() => {
      expect(
        screen.getByText('Warning: User may not be banned - not found in banned list'),
      ).toBeInTheDocument();
    });
  });

  it('reports inconclusive rather than citing the banned list when the check could not run', async () => {
    api.verifyPubkeyBanned.mockResolvedValue(null);

    renderDetail();
    await banTheUser();

    await waitFor(() => {
      expect(screen.getByText('Verification failed - could not check status')).toBeInTheDocument();
    });
    expect(
      screen.queryByText('Warning: User may not be banned - not found in banned list'),
    ).not.toBeInTheDocument();
  });
});

/** Open the ban-event dialog and press its action button. */
async function banTheEvent() {
  const trigger = await screen.findByRole('button', { name: /^Ban Event$/ });
  await act(async () => {
    fireEvent.click(trigger);
  });
  const buttons = await screen.findAllByRole('button', { name: /^Ban Event$/ });
  await act(async () => {
    fireEvent.click(buttons[buttons.length - 1]);
  });
}

describe('EventDetail post-delete verification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    modStatus.isUserBanned = false;
    api.deleteEvent.mockResolvedValue(undefined);
  });

  it('confirms the deletion when the relay no longer serves the event', async () => {
    api.verifyEventDeleted.mockResolvedValue(true);

    renderDetail();
    await banTheEvent();

    await waitFor(() => {
      expect(
        screen.getByText('Event deletion verified - no longer accessible on relay'),
      ).toBeInTheDocument();
    });
  });

  it('warns when the relay answered and the event is still there', async () => {
    api.verifyEventDeleted.mockResolvedValue(false);

    renderDetail();
    await banTheEvent();

    await waitFor(() => {
      expect(screen.getByText('Warning: Event may still be accessible on relay')).toBeInTheDocument();
    });
  });

  it('reports inconclusive when the check could not run', async () => {
    api.verifyEventDeleted.mockResolvedValue(null);

    renderDetail();
    await banTheEvent();

    await waitFor(() => {
      expect(screen.getByText('Verification failed - could not check status')).toBeInTheDocument();
    });
    expect(
      screen.queryByText('Warning: Event may still be accessible on relay'),
    ).not.toBeInTheDocument();
  });
});

describe('EventDetail post-unban verification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Banned, so the row offers "Unban User".
    modStatus.isUserBanned = true;
    api.unbanPubkey.mockResolvedValue(undefined);
  });

  async function unbanTheUser() {
    const button = await screen.findByRole('button', { name: /^Unban User$/ });
    await act(async () => {
      fireEvent.click(button);
    });
  }

  it('confirms the unban when the relay no longer lists the pubkey', async () => {
    api.verifyPubkeyUnbanned.mockResolvedValue(true);

    renderDetail();
    await unbanTheUser();

    await waitFor(() => {
      expect(screen.getByText('Unban verified - user is no longer in banned list')).toBeInTheDocument();
    });
  });

  it('warns when the relay answered and the pubkey is still listed', async () => {
    api.verifyPubkeyUnbanned.mockResolvedValue(false);

    renderDetail();
    await unbanTheUser();

    await waitFor(() => {
      expect(screen.getByText('Warning: User may still be banned')).toBeInTheDocument();
    });
  });

  it('reports inconclusive when the check could not run', async () => {
    api.verifyPubkeyUnbanned.mockResolvedValue(null);

    renderDetail();
    await unbanTheUser();

    await waitFor(() => {
      expect(screen.getByText('Verification failed - could not check status')).toBeInTheDocument();
    });
    expect(screen.queryByText('Warning: User may still be banned')).not.toBeInTheDocument();
  });
});
