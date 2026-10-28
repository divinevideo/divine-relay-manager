// ABOUTME: The event pane's Tags tab groups tags by name, including names that
// ABOUTME: match inherited object keys

import { fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import type { NostrEvent } from '@nostrify/nostrify';
import { EventDetail } from './EventDetail';

const AUTHOR_PUBKEY = 'd'.repeat(64);
const MOD_PUBKEY = 'e'.repeat(64);

vi.mock('@/hooks/useAdminApi', () => ({
  useAdminApi: () => ({
    banPubkey: vi.fn(),
    deleteEvent: vi.fn(),
    unbanPubkey: vi.fn(),
    restoreEvent: vi.fn(),
    verifyPubkeyBanned: vi.fn(),
    verifyPubkeyUnbanned: vi.fn(),
    verifyEventDeleted: vi.fn(),
    logDecision: vi.fn(),
  }),
}));
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
vi.mock('@/hooks/useModerationStatus', async () => {
  const { moderationStatusMock } = await import('@/test/moderationStatusMock');
  return { useModerationStatus: () => moderationStatusMock() };
});

// Presentational children with relay reads of their own; the tags table does
// not use them.
vi.mock('@/components/HiveAIReport', () => ({ HiveAIReport: () => null }));
vi.mock('@/components/AIDetectionReport', () => ({ AIDetectionReport: () => null }));
vi.mock('@/components/SceneClassification', () => ({ SceneClassification: () => null }));
vi.mock('@/components/TranscriptAnalysis', () => ({ TranscriptAnalysis: () => null }));
vi.mock('@/components/ReporterCard', () => ({ ReporterList: () => null }));
vi.mock('@/components/MediaPreview', () => ({ MediaPreview: () => null }));
vi.mock('@/components/UserIdentifier', () => ({ UserIdentifier: () => null }));

const TAG_NAMES = ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', 't'];

const EVENT: NostrEvent = {
  id: 'c'.repeat(64),
  pubkey: AUTHOR_PUBKEY,
  created_at: 1751000000,
  kind: 1,
  tags: TAG_NAMES.map(name => [name, 'value']),
  content: 'event content',
  sig: 'c'.repeat(128),
};

describe('EventDetail tags', () => {
  it('groups tags whose names match inherited object keys', () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <EventDetail event={EVENT} />
      </QueryClientProvider>,
    );

    // Radix tabs switch on mouse down.
    fireEvent.mouseDown(screen.getByRole('tab', { name: /Tags/ }), { button: 0 });

    // One group per name, each counting its one tag.
    const panel = screen.getByRole('tabpanel', { name: /Tags/ });
    for (const name of TAG_NAMES) {
      expect(within(panel).getByText((_, el) => el?.tagName === 'DIV' && el.textContent === `${name}(1)`))
        .toBeInTheDocument();
    }
  });
});
