// ABOUTME: Report detail right after this tab unsuspends the reported account: a post the
// ABOUTME: relay still withholds must not read as "never stored here", and the window's end re-checks.

import { act, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { endRestoreWindow, markRestored, RESTORE_SETTLE_MS } from '@/lib/userStatsCache';
import { ReportDetail } from './ReportDetail';
import type { NostrEvent } from '@nostrify/nostrify';

// Issue #376. Funnelcake drops an unsuspended account from the suspended list at
// once, but its read filter keeps hiding the account's posts until its next
// refresh. Nothing else explains the missing post then, so without the restore
// window it reads as "never stored here".

const REPORTED_PUBKEY = 'd'.repeat(64);
const MOD_PUBKEY = 'e'.repeat(64);
const EVENT_ID = 'c'.repeat(64);

const api = vi.hoisted(() => ({
  deleteEvent: vi.fn(),
  restoreEvent: vi.fn(),
  markAsReviewed: vi.fn(),
  logDecision: vi.fn(),
  deleteDecisions: vi.fn(),
  verifyPubkeyBanned: vi.fn(),
  verifyEventDeleted: vi.fn(),
  listBannedPubkeys: vi.fn(),
  listBannedEvents: vi.fn(),
  listSuspendedPubkeys: vi.fn(),
  // The real useDecisionLog reads through this.
  getDecisions: vi.fn(),
}));

vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()),
  useNavigate: () => vi.fn(),
}));
vi.mock('@/hooks/useAdminApi', () => ({
  useAdminApi: () => api,
  useApiUrl: () => 'https://api.a.example',
}));
vi.mock('@/hooks/useToast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ user: { pubkey: MOD_PUBKEY }, getModeratorToken: () => 'moderator-login-token' }),
}));
vi.mock('@/hooks/useAppContext', () => ({
  useAppContext: () => ({ config: { relayUrl: 'wss://relay.example' } }),
}));
vi.mock('@/hooks/useBannedEvent', () => ({ useBannedEvent: () => ({ data: null, isLoading: false }) }));
vi.mock('@/hooks/useUserSummary', () => ({ useUserSummary: () => ({ data: null, isLoading: false }) }));
vi.mock('@/hooks/useMediaStatus', () => ({ useMediaStatus: () => ({ results: [] }) }));
vi.mock('@/hooks/useAuthor', () => ({ useAuthor: () => ({ data: undefined, isLoading: false }) }));
vi.mock('@/hooks/useReportContext', () => ({
  useReportContext: (report: NostrEvent) => ({
    target: { type: 'event', value: report.tags.find(t => t[0] === 'e')![1] },
    thread: { event: undefined, ancestors: [], replies: [] },
    threadLoading: false,
    reportedUser: { profile: undefined, pubkey: report.tags.find(t => t[0] === 'p')![1], isFunnelcakeUser: false },
    userStats: undefined,
    isLoading: false,
    error: null,
    relayHint: undefined,
    reportTags: report.tags,
  }),
}));

vi.mock('@/components/UserProfileCard', () => ({ UserProfileCard: () => null }));
vi.mock('@/components/AISummary', () => ({ AISummary: () => null }));
vi.mock('@/components/HiveAIReport', () => ({ HiveAIReport: () => null }));
vi.mock('@/components/AIDetectionReport', () => ({ AIDetectionReport: () => null }));
vi.mock('@/components/MediaPreview', () => ({ MediaPreview: () => null }));
vi.mock('@/components/ThreadModal', () => ({ ThreadModal: () => null }));
vi.mock('@/components/EventActions', () => ({ EventActions: () => null }));
vi.mock('@/components/UserActions', () => ({ UserActions: () => null }));
vi.mock('@/components/BulkDeleteByKind', () => ({ BulkDeleteByKind: () => null }));
vi.mock('@/components/ReporterCard', () => ({ ReporterInline: () => null }));
vi.mock('@/components/UserIdentifier', () => ({ UserIdentifier: () => null }));

const REPORT: NostrEvent = {
  id: 'f'.repeat(64),
  pubkey: 'a'.repeat(64),
  created_at: 1751000000,
  kind: 1984,
  tags: [['e', EVENT_ID], ['p', REPORTED_PUBKEY]],
  content: 'spam',
  sig: 'b'.repeat(128),
};

// Another report, on another account's post.
const OTHER_PUBKEY = '9'.repeat(64);
const OTHER_EVENT_ID = '8'.repeat(64);
const OTHER_REPORT: NostrEvent = { ...REPORT, id: '7'.repeat(64), tags: [['e', OTHER_EVENT_ID], ['p', OTHER_PUBKEY]] };

// Another report on the same account, about another of its posts.
const SAME_ACCOUNT_EVENT_ID = '6'.repeat(64);
const SAME_ACCOUNT_REPORT: NostrEvent = { ...REPORT, id: '5'.repeat(64), tags: [['e', SAME_ACCOUNT_EVENT_ID], ['p', REPORTED_PUBKEY]] };

const qc = () => new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
const tree = (client: QueryClient, report: NostrEvent) => (
  <QueryClientProvider client={client}>
    <TooltipProvider>
      <ReportDetail report={report} />
    </TooltipProvider>
  </QueryClientProvider>
);


const JUST_RESTORED = /The account was just unsuspended, and its posts can take a few minutes to reappear/;
const NEVER_STORED = /never stored here/;
const liveChecksOf = (eventId: string) => api.verifyEventDeleted.mock.calls.filter(c => c[0] === eventId).length;

describe('ReportDetail missing post just after an unsuspend', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // The post is gone from the relay's answer, and every list says nothing
    // explains it: the account is off the suspended list already.
    api.verifyEventDeleted.mockResolvedValue(true);
    api.verifyPubkeyBanned.mockResolvedValue(false);
    api.listBannedPubkeys.mockResolvedValue([]);
    api.listBannedEvents.mockResolvedValue([]);
    api.listSuspendedPubkeys.mockResolvedValue([]);
    api.getDecisions.mockResolvedValue([]);
  });

  afterEach(() => {
    // Restore windows are module state; one left open would leak into the next test.
    for (const pubkey of [REPORTED_PUBKEY, OTHER_PUBKEY]) endRestoreWindow(pubkey, undefined);
    vi.useRealTimers();
  });

  it('says the post may still be withheld rather than never stored', async () => {
    const client = qc();
    await act(async () => { await markRestored(client, REPORTED_PUBKEY, undefined); });
    render(tree(client, REPORT));

    expect(await screen.findByText(JUST_RESTORED, {}, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.queryByText(NEVER_STORED)).not.toBeInTheDocument();
  });

  it('re-checks the post once when the window closes', async () => {
    const client = qc();
    await act(async () => { await markRestored(client, REPORTED_PUBKEY, undefined); });
    render(tree(client, REPORT));
    expect(await screen.findByText(JUST_RESTORED, {}, { timeout: 4000 })).toBeInTheDocument();
    const before = liveChecksOf(EVENT_ID);

    await act(async () => { await vi.advanceTimersByTimeAsync(RESTORE_SETTLE_MS + 1000); });

    expect(liveChecksOf(EVENT_ID)).toBe(before + 1);
    // Still gone after the window: now nothing explains it.
    expect(await screen.findByText(NEVER_STORED, {}, { timeout: 4000 })).toBeInTheDocument();

    // Once, not on every render after it.
    await act(async () => { await vi.advanceTimersByTimeAsync(RESTORE_SETTLE_MS); });
    expect(liveChecksOf(EVENT_ID)).toBe(before + 1);
  });

  // No window was open: only a window that closes owes a re-check.
  it('does not re-check a report opened with no restore window', async () => {
    render(tree(qc(), REPORT));
    expect(await screen.findByText(NEVER_STORED, {}, { timeout: 4000 })).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(RESTORE_SETTLE_MS + 1000); });

    // Only the check the report runs on open.
    expect(liveChecksOf(EVENT_ID)).toBe(1);
  });

  // The window belongs to the account, so it can close while another of its
  // reports is open. The re-check is for the post on screen then, not the one
  // that was open when the window started.
  it('re-checks the report open when the window closes, not the one open when it started', async () => {
    const client = qc();
    await act(async () => { await markRestored(client, REPORTED_PUBKEY, undefined); });
    const view = render(tree(client, REPORT));
    expect(await screen.findByText(JUST_RESTORED, {}, { timeout: 4000 })).toBeInTheDocument();

    view.rerender(tree(client, SAME_ACCOUNT_REPORT));
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    const firstPost = liveChecksOf(EVENT_ID);
    const secondPost = liveChecksOf(SAME_ACCOUNT_EVENT_ID);
    expect(secondPost).toBe(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(RESTORE_SETTLE_MS + 1000); });

    expect(liveChecksOf(SAME_ACCOUNT_EVENT_ID)).toBe(secondPost + 1);
    expect(liveChecksOf(EVENT_ID)).toBe(firstPost);
  });

  // The thread read cached the post as missing (useThread, staleTime 60s). A
  // post the relay returns again once its filter catches up must be read again,
  // or it never shows despite "can take a few minutes to reappear".
  it('marks the cached thread read stale when the window closes', async () => {
    const client = qc();
    const threadKey = ['thread', EVENT_ID, 3, undefined, undefined];
    // Nothing observes it here (useReportContext is mocked), and the default
    // five-minute gcTime is shorter than the window: keep it to inspect.
    client.setQueryDefaults(['thread'], { gcTime: Infinity });
    client.setQueryData(threadKey, { ancestors: [], event: null, replies: [], repostedEvent: null, isRepost: false, fetchSource: null });
    await act(async () => { await markRestored(client, REPORTED_PUBKEY, undefined); });
    render(tree(client, REPORT));
    expect(await screen.findByText(JUST_RESTORED, {}, { timeout: 4000 })).toBeInTheDocument();
    expect(client.getQueryState(threadKey)?.isInvalidated).toBe(false);

    await act(async () => { await vi.advanceTimersByTimeAsync(RESTORE_SETTLE_MS + 1000); });

    expect(client.getQueryState(threadKey)?.isInvalidated).toBe(true);
  });

  // Opening another report changes the account, not the window: that report's
  // own check runs on open, and no re-check is owed for it.
  it('does not re-check when the moderator opens another account\'s report', async () => {
    const client = qc();
    await act(async () => { await markRestored(client, REPORTED_PUBKEY, undefined); });
    const view = render(tree(client, REPORT));
    expect(await screen.findByText(JUST_RESTORED, {}, { timeout: 4000 })).toBeInTheDocument();

    view.rerender(tree(client, OTHER_REPORT));
    expect(await screen.findByText(NEVER_STORED, {}, { timeout: 4000 })).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(RESTORE_SETTLE_MS + 1000); });

    // Only the check the new report runs on open.
    expect(liveChecksOf(OTHER_EVENT_ID)).toBe(1);
  });
});
