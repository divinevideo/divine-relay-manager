// ABOUTME: Pins that EventDetail hides media by default when a related report is an old-build
// ABOUTME: CSAM report (NIP-56 'illegal' plus a Reason line), not just a CSAM-tagged one.

import { render, screen, waitFor } from '@testing-library/react';
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
const reports = vi.hoisted(() => ({ value: [] as unknown[] }));
vi.mock('@/hooks/useNostr', () => ({ useNostr: () => ({ nostr: { query: vi.fn(async () => reports.value) } }) }));
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
// Stand-in that exposes showByDefault, so no media is ever loaded or fetched.
vi.mock('@/components/MediaPreview', () => ({
  MediaPreview: ({ showByDefault }: { showByDefault?: boolean }) => (
    <div data-testid="media" data-show={String(showByDefault)} />
  ),
}));
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
const OLD_BUILD = makeReport(
  [['e', EVENT.id, 'illegal'], ['p', REPORTED_PUBKEY, 'illegal'], ['client', 'diVine']],
  'CONTENT REPORT - NIP-56\nReason: csam\nDetails: x\n',
);
const PLAIN_ILLEGAL = makeReport([['e', EVENT.id, 'illegal'], ['p', REPORTED_PUBKEY, 'illegal']], 'bad');

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

describe('EventDetail media gating by related reports', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    modStatus.isUserBanned = false;
    modStatus.isUserBannedStale = false;
    modStatus.isEventGone = false;
  });

  it('hides media by default when a related report is an old-build CSAM report', async () => {
    reports.value = [OLD_BUILD];
    renderDetail();
    await screen.findByText('1 Related Report');
    await waitFor(() => expect(screen.getByTestId('media').dataset.show).toBe('false'));
  });

  it('keeps media shown for a bare illegal report (control)', async () => {
    reports.value = [PLAIN_ILLEGAL];
    renderDetail();
    await screen.findByText('1 Related Report');
    expect(screen.getByTestId('media').dataset.show).toBe('true');
  });
});
