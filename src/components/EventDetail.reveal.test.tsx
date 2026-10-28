// ABOUTME: Tests the event page's real media preview when the moderator reveals media
// ABOUTME: before the event's reports arrive: a sensitive verdict re-hides it, a clean one does not

import { act, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NostrEvent } from '@nostrify/nostrify';
import { EventDetail } from './EventDetail';

const REPORTED_PUBKEY = 'd'.repeat(64);
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
  useApiUrl: () => 'https://api.example.invalid',
}));
vi.mock('@/hooks/useToast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ user: { pubkey: MOD_PUBKEY }, getModeratorPubkey: async () => MOD_PUBKEY }),
}));
// Every related-reports read waits until the test answers it.
const pending = vi.hoisted(() => ({ answers: [] as ((events: unknown[]) => void)[] }));
vi.mock('@/hooks/useNostr', () => ({
  useNostr: () => ({
    nostr: { query: () => new Promise<unknown[]>((resolve) => { pending.answers.push(resolve); }) },
  }),
}));
vi.mock('@/hooks/useAuthor', () => ({ useAuthor: () => ({ data: undefined, isLoading: false }) }));
vi.mock('@/hooks/useUserStats', () => ({ useUserStats: () => ({ data: undefined, isLoading: false }) }));
vi.mock('@/hooks/useAgeReviewGuardRedirect', () => ({
  useAgeReviewGuardRedirect: () => ({ redirectIfGuarded: () => false }),
}));
vi.mock('@/hooks/useModerationStatus', async () => {
  const { moderationStatusMock } = await import('@/test/moderationStatusMock');
  return { useModerationStatus: () => moderationStatusMock({ isUserBanned: false, isEventGone: false }) };
});
vi.mock('@/components/HiveAIReport', () => ({ HiveAIReport: () => null }));
vi.mock('@/components/AIDetectionReport', () => ({ AIDetectionReport: () => null }));
vi.mock('@/components/SceneClassification', () => ({ SceneClassification: () => null }));
vi.mock('@/components/TranscriptAnalysis', () => ({ TranscriptAnalysis: () => null }));
vi.mock('@/components/ReporterCard', () => ({ ReporterList: () => null }));
vi.mock('@/components/UserIdentifier', () => ({ UserIdentifier: () => null }));

const EVENT: NostrEvent = {
  id: 'c'.repeat(64),
  pubkey: REPORTED_PUBKEY,
  created_at: 1751000000,
  kind: 1,
  tags: [],
  content: 'clip https://example.invalid/clip.mp4',
  sig: 'c'.repeat(128),
};

function makeReport(tags: string[][], content: string): NostrEvent {
  return { id: 'f'.repeat(64), pubkey: 'a'.repeat(64), created_at: 1751000100, kind: 1984, tags, content, sig: 'b'.repeat(128) };
}
const OLD_BUILD_CSAM = makeReport(
  [['e', EVENT.id, 'illegal'], ['p', REPORTED_PUBKEY, 'illegal'], ['client', 'diVine']],
  'CONTENT REPORT - NIP-56\nReason: csam\nDetails: x\n',
);
const SPAM = makeReport([['e', EVENT.id, 'spam'], ['p', REPORTED_PUBKEY, 'spam']], 'buy now');

function renderDetail() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <EventDetail event={EVENT} />
    </QueryClientProvider>,
  );
}

async function answerReads(events: unknown[]) {
  await act(async () => { pending.answers.forEach(answer => answer(events)); });
  await screen.findByText('1 Related Report');
}

const hasVideo = (c: HTMLElement) => c.querySelector('video') !== null;

beforeEach(() => {
  pending.answers = [];
});

describe('EventDetail media revealed before its reports arrive', () => {
  it('hides it again when the reports turn out to be sensitive', async () => {
    const { container } = renderDetail();
    fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    expect(hasVideo(container)).toBe(true);

    await answerReads([OLD_BUILD_CSAM]);

    expect(hasVideo(container)).toBe(false);
  });

  it('keeps showing it when the reports turn out clean', async () => {
    const { container } = renderDetail();
    fireEvent.click(screen.getByRole('button', { name: 'Show' }));

    await answerReads([SPAM]);

    expect(hasVideo(container)).toBe(true);
  });

  it('keeps it hidden when the moderator hid it again before the reports turned out clean', async () => {
    const { container } = renderDetail();
    fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    fireEvent.click(screen.getByRole('button', { name: 'Hide' }));

    await answerReads([SPAM]);

    expect(hasVideo(container)).toBe(false);
  });
});
