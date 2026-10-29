// ABOUTME: A poll that adds a CSAM-signal report to the open target and marks the feed stopped early, or that
// ABOUTME: drops the open target from the feed, hides its post media, avatar and recent-post media in the real pane.

import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { nip19 } from 'nostr-tools';
import type { NostrEvent } from '@nostrify/nostrify';
import TestApp from '@/test/TestApp';
import { TooltipProvider } from '@/components/ui/tooltip';
import { moderationStatusMock } from '@/test/moderationStatusMock';
import { Reports } from './Reports';

const RELAY_URL = 'wss://relay.example';
const AUTHOR = 'd'.repeat(64);
const EVENT = '3'.repeat(64);
const POST_IMG = 'https://example.invalid/post.png';
const RECENT_IMG = 'https://example.invalid/recent.png';
const AVATAR = 'https://example.invalid/avatar.png';

const REPORTED_POST: NostrEvent = {
  id: EVENT, pubkey: AUTHOR, created_at: 1751000000, kind: 1, tags: [], content: `pic ${POST_IMG}`, sig: 'b'.repeat(128),
};
const RECENT_POST: NostrEvent = { ...REPORTED_POST, id: '6'.repeat(64), content: `pic ${RECENT_IMG}` };

function report(id: string, createdAt: number, tags: string[][], content = '') {
  return { id, pubkey: '5'.repeat(64), created_at: createdAt, kind: 1984, tags, content, sig: 'f'.repeat(128) };
}
const SPAM_REPORT = report('c'.repeat(64), 1751000050, [['e', EVENT, 'spam'], ['p', AUTHOR, 'spam']]);
const CSAM_REPORT = report('a'.repeat(64), 1751000100, [['e', EVENT, 'other'], ['p', AUTHOR], ['report', 'csam']], 'synthetic csam-signal report');

// The pane's own reads, stood in so it renders the target's media, avatar and
// recent posts with no relay.
vi.mock('@/hooks/useReportContext', () => ({
  useReportContext: () => ({
    target: { type: 'event', value: EVENT },
    thread: { event: REPORTED_POST, ancestors: [], replies: [] },
    threadLoading: false,
    reportedUser: { profile: { picture: AVATAR }, pubkey: AUTHOR, isFunnelcakeUser: false },
    userStats: {
      postCount: 1, reportCount: 0, labelCount: 0, recentPosts: [RECENT_POST], existingLabels: [], previousReports: [],
      authoredContentIncomplete: false, labelsIncomplete: false, reportsIncomplete: false, reportsTruncated: false,
      labelsTruncated: false, relayIncomplete: false,
    },
    isLoading: false,
    error: null,
    relayHint: undefined,
    reportTags: [],
  }),
}));
vi.mock('@/hooks/useDecisionLog', () => ({
  useDecisionLog: () => ({
    hasDecisions: false, hasHandlingDecisions: false, latestHandlingDecision: undefined, isPendingReview: false,
    isAutoHideRestoreFailed: false, isAutoHideUnresolved: false, isDeleted: false, isAutoHidden: false,
    isAutoHideRestored: false, decisions: [], latestDecision: null, refetch: vi.fn(),
  }),
}));
vi.mock('@/hooks/useModerationStatus', () => ({
  useModerationStatus: () => moderationStatusMock({ isUserBanned: false, isEventGone: false }),
}));
vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ user: { pubkey: 'e'.repeat(64) }, getModeratorPubkey: async () => 'e'.repeat(64) }),
}));
vi.mock('@/hooks/useBannedEvent', () => ({ useBannedEvent: () => ({ data: null, isLoading: false }) }));
vi.mock('@/hooks/useUserSummary', () => ({ useUserSummary: () => ({ data: null, isLoading: false }) }));
vi.mock('@/hooks/useMediaStatus', () => ({ useMediaStatus: () => ({}) }));
vi.mock('@/hooks/useEventTitles', () => ({ useEventTitles: () => ({ titles: new Map(), isLoading: false }) }));
vi.mock('@/components/ThreadContext', () => ({ ThreadContext: () => null }));
vi.mock('@/components/AISummary', () => ({ AISummary: () => null }));
vi.mock('@/components/HiveAIReport', () => ({ HiveAIReport: () => null }));
vi.mock('@/components/AIDetectionReport', () => ({ AIDetectionReport: () => null }));
vi.mock('@/components/ThreadModal', () => ({ ThreadModal: () => null }));
vi.mock('@/components/EventActions', () => ({ EventActions: () => null }));
vi.mock('@/components/UserActions', () => ({ UserActions: () => null }));
vi.mock('@/components/BulkDeleteByKind', () => ({ BulkDeleteByKind: () => null }));
vi.mock('@/components/ReporterCard', () => ({ ReporterInline: () => null }));
vi.mock('@/components/LinkedTicketPanel', () => ({ LinkedTicketPanel: () => null }));
vi.mock('@/components/UserIdentifier', () => ({ UserIdentifier: () => null }));
vi.mock('@/components/RelatedReportsCard', () => ({ RelatedReportsCard: () => null }));
// Radix's AvatarImage renders an <img> only after a real load, which jsdom never
// does; mounting it is what starts the request, so a stand-in shows the mount.
vi.mock('@/components/ui/avatar', () => ({
  Avatar: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  AvatarImage: ({ src }: { src?: string }) => <img data-testid="avatar-img" src={src} />,
  AvatarFallback: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

const hasImg = (src: string) => document.querySelector(`img[src="${src}"]`) !== null;

let consoleError: MockInstance;
beforeEach(() => {
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  consoleError.mockRestore();
});

describe('a poll that adds a CSAM-signal report and stops early', () => {
  it("hides the open target's post media, avatar and recent-post media", async () => {
    // First read: the target's one spam report, read in full. Every later read:
    // a CSAM-signal report on the same post as well, and the walk stopped early.
    let feedReads = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes('/api/reports?needs_attention=1')) {
        feedReads += 1;
        return feedReads === 1
          ? jsonResponse({ success: true, events: [SPAM_REPORT], truncated: false })
          : jsonResponse({ success: true, events: [CSAM_REPORT, SPAM_REPORT], truncated: true, oldest_covered: 1751000000 });
      }
      if (url.includes('/api/resolution-label-targets')) {
        return jsonResponse({ success: true, targets: [], truncated: false, oldest_covered: null });
      }
      if (url.includes('/api/resolution-state')) return jsonResponse({ success: true, resolved: [], states: [] });
      if (url.includes('/api/relay-rpc')) return jsonResponse({ success: true, result: [] });
      return jsonResponse({ success: true });
    }));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });
    const user = userEvent.setup();
    // The app root provides tooltips; TestApp does not, and the pane uses them.
    render(<TestApp queryClient={queryClient}><TooltipProvider><Reports relayUrl={RELAY_URL} /></TooltipProvider></TestApp>);

    await user.click(await screen.findByText(nip19.noteEncode(EVENT)));
    await waitFor(() => expect(hasImg(POST_IMG)).toBe(true));
    expect(hasImg(AVATAR)).toBe(true);
    expect(hasImg(RECENT_IMG)).toBe(true);

    await act(async () => { await queryClient.refetchQueries({ queryKey: ['reports', RELAY_URL] }); });
    await waitFor(() => expect(feedReads).toBe(2));
    // The stopped-early banner says the feed is now partial.
    await screen.findByText(/stopped/i);

    expect(hasImg(POST_IMG)).toBe(false);
    expect(hasImg(AVATAR)).toBe(false);
    expect(hasImg(RECENT_IMG)).toBe(false);
  });
});

describe('a poll on which the open target has left the feed', () => {
  it("hides the open target's post media, avatar and recent-post media", async () => {
    // First read: the target's one spam report, read in full. Every later read:
    // the target is gone (handled elsewhere), and the feed read to its end.
    let feedReads = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes('/api/reports?needs_attention=1')) {
        feedReads += 1;
        return feedReads === 1
          ? jsonResponse({ success: true, events: [SPAM_REPORT], truncated: false })
          : jsonResponse({ success: true, events: [], truncated: false });
      }
      if (url.includes('/api/resolution-label-targets')) {
        return jsonResponse({ success: true, targets: [], truncated: false, oldest_covered: null });
      }
      if (url.includes('/api/resolution-state')) return jsonResponse({ success: true, resolved: [], states: [] });
      if (url.includes('/api/relay-rpc')) return jsonResponse({ success: true, result: [] });
      return jsonResponse({ success: true });
    }));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });
    const user = userEvent.setup();
    render(<TestApp queryClient={queryClient}><TooltipProvider><Reports relayUrl={RELAY_URL} /></TooltipProvider></TestApp>);

    await user.click(await screen.findByText(nip19.noteEncode(EVENT)));
    await waitFor(() => expect(hasImg(POST_IMG)).toBe(true));
    expect(hasImg(AVATAR)).toBe(true);
    expect(hasImg(RECENT_IMG)).toBe(true);

    await act(async () => { await queryClient.refetchQueries({ queryKey: ['reports', RELAY_URL] }); });
    await waitFor(() => expect(feedReads).toBe(2));
    // The row is gone; the pane stays open on the same report.
    await waitFor(() => expect(screen.queryByText(nip19.noteEncode(EVENT))).not.toBeInTheDocument());
    expect(screen.getByText('Media Content')).toBeInTheDocument();

    expect(hasImg(POST_IMG)).toBe(false);
    expect(hasImg(AVATAR)).toBe(false);
    expect(hasImg(RECENT_IMG)).toBe(false);
  });
});
