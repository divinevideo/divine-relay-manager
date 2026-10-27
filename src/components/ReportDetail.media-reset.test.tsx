// ABOUTME: A revealed media viewer must not carry over to the next report the pane opens.
// ABOUTME: Real MediaPreview and UserProfileCard, synthetic reports and image URLs only.
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReportDetail } from './ReportDetail';
import type { NostrEvent } from '@nostrify/nostrify';
import { moderationStatusMock } from '@/test/moderationStatusMock';

const AUTHOR = 'd'.repeat(64);
const E1 = '1'.repeat(64);
const E2 = '2'.repeat(64);
const IMG1 = 'https://example.invalid/one.png';
const IMG2 = 'https://example.invalid/two.png';
const POST_IMG = 'https://example.invalid/recent.png';

const ev = (id: string, img: string): NostrEvent => ({
  id, pubkey: AUTHOR, created_at: 1751000000, kind: 1, tags: [], content: `pic ${img}`, sig: 'b'.repeat(128),
});
const EVENTS: Record<string, NostrEvent> = { [E1]: ev(E1, IMG1), [E2]: ev(E2, IMG2) };
const RECENT_POST: NostrEvent = { ...ev('3'.repeat(64), POST_IMG) };
// Two reposts, each with an original post carrying its own image.
const E4 = '4'.repeat(64);
const E5 = '5'.repeat(64);
const ORIGINAL_IMG1 = 'https://example.invalid/original-one.png';
const ORIGINAL_IMG2 = 'https://example.invalid/original-two.png';
EVENTS[E4] = { ...ev(E4, 'https://example.invalid/wrapper-one.png'), kind: 6 };
EVENTS[E5] = { ...ev(E5, 'https://example.invalid/wrapper-two.png'), kind: 6 };
const ORIGINALS: Record<string, NostrEvent> = {
  [E4]: ev('6'.repeat(64), ORIGINAL_IMG1),
  [E5]: ev('7'.repeat(64), ORIGINAL_IMG2),
};

vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()),
  useNavigate: () => vi.fn(),
}));
vi.mock('@/hooks/useAdminApi', () => ({
  useAdminApi: () => ({ deleteEvent: vi.fn(), restoreEvent: vi.fn(), markAsReviewed: vi.fn(), logDecision: vi.fn(), deleteDecisions: vi.fn() }),
  useApiUrl: () => 'https://api.example.invalid',
}));
vi.mock('@/hooks/useToast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ user: { pubkey: 'e'.repeat(64) }, getModeratorPubkey: async () => 'e'.repeat(64) }),
}));
vi.mock('@/hooks/useAppContext', () => ({ useAppContext: () => ({ config: { relayUrl: 'wss://relay.example' } }) }));
vi.mock('@/hooks/useDecisionLog', () => ({
  useDecisionLog: () => ({
    hasDecisions: false, hasHandlingDecisions: false, latestHandlingDecision: undefined, isPendingReview: false,
    isAutoHideRestoreFailed: false, isAutoHideUnresolved: false, isDeleted: false, isAutoHidden: false,
    isAutoHideRestored: false, decisions: [], latestDecision: null, refetch: vi.fn(),
  }),
}));
const statusValue = vi.hoisted(() => ({ value: {} as unknown }));
vi.mock('@/hooks/useModerationStatus', () => ({ useModerationStatus: () => statusValue.value }));
vi.mock('@/hooks/useBannedEvent', () => ({ useBannedEvent: () => ({ data: null, isLoading: false }) }));
vi.mock('@/hooks/useUserSummary', () => ({ useUserSummary: () => ({ data: null, isLoading: false }) }));
vi.mock('@/hooks/useMediaStatus', () => ({ useMediaStatus: () => ({}) }));
vi.mock('@/hooks/useEventTitles', () => ({ useEventTitles: () => ({ titles: new Map(), isLoading: false }) }));
vi.mock('@/hooks/useReportContext', () => ({
  useReportContext: (report: NostrEvent) => {
    const eTag = report.tags.find(t => t[0] === 'e')?.[1] as string;
    return {
      target: { type: 'event', value: eTag },
      // The thread is always loaded: a report opened earlier stays cached, which
      // is what keeps the pane's viewers mounted from one report to the next.
      thread: {
        event: EVENTS[eTag], ancestors: [], replies: [],
        ...(ORIGINALS[eTag] ? { isRepost: true, repostedEvent: ORIGINALS[eTag] } : {}),
      },
      threadLoading: false,
      reportedUser: { profile: undefined, pubkey: AUTHOR, isFunnelcakeUser: false },
      userStats: {
        postCount: 1, reportCount: 0, labelCount: 0, recentPosts: [RECENT_POST], existingLabels: [], previousReports: [],
        authoredContentIncomplete: false, labelsIncomplete: false, reportsIncomplete: false, reportsTruncated: false,
        labelsTruncated: false, relayIncomplete: false,
      },
      reporter: { profile: undefined, pubkey: 'a'.repeat(64), reportCount: 0, isFunnelcakeUser: false },
      isLoading: false,
      error: null,
      relayHint: undefined,
      reportTags: [],
    };
  },
}));
vi.mock('@/components/ThreadContext', () => ({ ThreadContext: () => <div data-testid="thread" /> }));
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

let n = 0;
function report(eventId: string, tags: string[][], content: string): NostrEvent {
  n += 1;
  return { id: n.toString(16).padStart(64, '0'), pubkey: 'a'.repeat(64), created_at: 1751000000 + n, kind: 1984, tags: [['e', eventId, ...tags[0]], ['p', AUTHOR], ...tags.slice(1)], content, sig: 'b'.repeat(128) };
}
// Hidden-by-default "A": an ordinary spam report whose set may be partial (a
// history selection, or a truncated feed).
const A_PARTIAL_SPAM = (e: string) => report(e, [['spam']], 'spam');
const NONSENSITIVE = (e: string) => report(e, [['spam']], 'spam');
const CSAM = (e: string) => report(e, [['other'], ['report', 'csam']], 'synthetic csam-signal report');

const qc = () => new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
function tree(client: QueryClient, r: NostrEvent, partial: boolean) {
  return (
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <ReportDetail report={r} allReportsForTarget={[r]} targetReportsMayBePartial={partial} />
      </TooltipProvider>
    </QueryClientProvider>
  );
}
const hasImg = (src: string) => document.querySelector(`img[src="${src}"]`) !== null;

function mediaCard() {
  // The Media Content card's own Show/Hide button (exact "Show"/"Hide").
  return screen.getAllByRole('button', { name: /^(Show|Hide)$/ });
}

beforeEach(() => {
  statusValue.value = moderationStatusMock({ isUserBanned: false, isEventGone: false });
});


describe('a media reveal on one report does not carry to the next', () => {
  // A is a hidden-by-default report (its set may be partial) that the moderator
  // revealed; B is a CSAM-signal report. Both threads are cached, so the pane
  // does not unmount between them.
  it('hides B on a different event', () => {
    const client = qc();
    const { rerender } = render(tree(client, A_PARTIAL_SPAM(E1), true));
    expect(hasImg(IMG1)).toBe(false);
    fireEvent.click(mediaCard()[0]);
    expect(hasImg(IMG1)).toBe(true);

    rerender(tree(client, CSAM(E2), false));
    expect(hasImg(IMG2)).toBe(false);
  });

  it('hides B on the same event', () => {
    const client = qc();
    const { rerender } = render(tree(client, A_PARTIAL_SPAM(E1), true));
    fireEvent.click(mediaCard()[0]);
    expect(hasImg(IMG1)).toBe(true);

    rerender(tree(client, CSAM(E1), false));
    expect(hasImg(IMG1)).toBe(false);
  });

  it('hides the recent-post media in the profile card on B', () => {
    const client = qc();
    const { rerender } = render(tree(client, A_PARTIAL_SPAM(E1), true));
    expect(hasImg(POST_IMG)).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: /show 1 media/i }));
    expect(hasImg(POST_IMG)).toBe(true);

    rerender(tree(client, CSAM(E2), false));
    expect(hasImg(POST_IMG)).toBe(false);
  });
});

describe('a revealed repost original does not carry to the next repost', () => {
  it('hides the next repost original', () => {
    const client = qc();
    const { rerender } = render(tree(client, A_PARTIAL_SPAM(E4), true));
    expect(hasImg(ORIGINAL_IMG1)).toBe(false);
    for (const button of mediaCard()) fireEvent.click(button);
    expect(hasImg(ORIGINAL_IMG1)).toBe(true);

    rerender(tree(client, CSAM(E5), false));
    expect(hasImg(ORIGINAL_IMG2)).toBe(false);
  });
});

describe('opening a CSAM-signal report after a non-sensitive one', () => {
  // The image element must never be created, not just hidden after the first
  // commit: setting its src starts the request.
  it('never sets the new report\'s image src', () => {
    const client = qc();
    const { rerender } = render(tree(client, NONSENSITIVE(E1), false));
    expect(hasImg(IMG1)).toBe(true);

    const setAttr = vi.spyOn(HTMLImageElement.prototype, 'setAttribute');
    rerender(tree(client, CSAM(E2), false));
    const srcs = setAttr.mock.calls.filter(c => c[0] === 'src').map(c => String(c[1]));
    setAttr.mockRestore();

    expect(srcs).not.toContain(IMG2);
    expect(hasImg(IMG2)).toBe(false);
  });
});

