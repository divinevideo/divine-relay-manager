// ABOUTME: Report detail after this tab changes the reported account's status: the post panel
// ABOUTME: reads the post again with the live check, so the header and body agree.

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { endRestoreWindow, markRestored } from '@/lib/userStatsCache';
import { ReportDetail } from './ReportDetail';
import type { NostrEvent } from '@nostrify/nostrify';
import type { ComponentProps } from 'react';
import type { UserActions } from './UserActions';

// Issue #434. The thread read found the post before the account was
// suspended and still holds it. After an Unsuspend in this tab the live check
// runs again and finds the post withheld (the relay's read filter lags the
// suspended list), so the header said "Not Found on Relay" while the body kept
// showing the post from the earlier read, and never said why it was missing.

const REPORTED_PUBKEY = 'd'.repeat(64);
const OTHER_PUBKEY = '7'.repeat(64);
const MOD_PUBKEY = 'e'.repeat(64);
const EVENT_ID = 'c'.repeat(64);
const API_URL = 'https://api.a.example';

// What the relay returns for the post right now. The thread read below asks it
// only when its query runs, so a cached answer outlives a change here.
// `firstRead`, when set, holds the next read open until it settles, and that
// read answers with what it settles to. `bannedLookup`, when set, holds the
// banned-event fallback open the same way.
const relay = vi.hoisted(() => ({
  post: undefined as NostrEvent | undefined,
  firstRead: undefined as Promise<NostrEvent | undefined> | undefined,
  bannedLookup: undefined as Promise<void> | undefined,
  finishAction: undefined as Promise<void> | undefined,
  reads: 0,
}));

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
  getDecisions: vi.fn(),
}));

vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()),
  useNavigate: () => vi.fn(),
}));
vi.mock('@/hooks/useAdminApi', () => ({
  useAdminApi: () => api,
  useApiUrl: () => API_URL,
}));
vi.mock('@/hooks/useToast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ user: { pubkey: MOD_PUBKEY }, getModeratorToken: () => 'moderator-login-token' }),
}));
vi.mock('@/hooks/useAppContext', () => ({
  useAppContext: () => ({ config: { relayUrl: 'wss://relay.example', apiUrl: API_URL } }),
}));
// The banned-event fallback the pane reads once the thread finds no post: not
// banned one at a time, so null, at once. While `relay.bannedLookup` is set it
// is a query of its own that answers null when that settles.
vi.mock('@/hooks/useBannedEvent', () => ({
  useBannedEvent: (eventId: string | undefined, enabled: boolean) => {
    const held = relay.bannedLookup;
    const lookup = useQuery({
      queryKey: ['banned-event', eventId],
      queryFn: async () => { await held; return null; },
      enabled: !!held && enabled && !!eventId,
    });
    return held ? lookup : { data: null, isLoading: false };
  },
}));
vi.mock('@/hooks/useUserSummary', () => ({ useUserSummary: () => ({ data: null, isLoading: false }) }));
vi.mock('@/hooks/useMediaStatus', () => ({ useMediaStatus: () => ({ results: [] }) }));
vi.mock('@/hooks/useAuthor', () => ({ useAuthor: () => ({ data: undefined, isLoading: false }) }));
vi.mock('@/hooks/useUserStats', () => ({ useUserStats: () => ({ data: undefined, isLoading: false, error: null }) }));
// The thread read as useThread keys and caches it (['thread', eventId, depth,
// apiUrl, relayHint], staleTime 60s), answering from `relay` when it runs.
// useReportContext itself is real: which account the pane acts on comes from
// this read (its post's author) before the report's p tag.
vi.mock('@/hooks/useThread', () => ({
  useThread: (eventId: string | undefined, depth: number, apiUrl?: string, relayHint?: string) => useQuery({
    queryKey: ['thread', eventId, depth, apiUrl, relayHint],
    queryFn: async () => {
      relay.reads += 1;
      const held = relay.firstRead;
      relay.firstRead = undefined;
      const post = held ? await held : relay.post?.id === eventId ? relay.post : undefined;
      return { event: post ?? null, ancestors: [], replies: [], repostedEvent: null, isRepost: false, fetchSource: null };
    },
    enabled: !!eventId,
    staleTime: 60_000,
  }),
}));
// The account actions, reduced to what each tells the pane when it succeeds,
// as UserActions does: an Unsuspend opens the restore window first.
vi.mock('@/components/UserActions', () => ({
  UserActions: ({ pubkey, reportTarget, onActionComplete }: ComponentProps<typeof UserActions>) => {
    const queryClient = useQueryClient();
    const action = useMutation({
      mutationFn: async ({ pubkey: target }: { pubkey: string; reportTarget: typeof reportTarget }) => {
        await relay.finishAction;
        await markRestored(queryClient, target, undefined);
      },
      onSuccess: (_, target) => onActionComplete?.({ ...target, accountStatusChanged: true, action: 'unsuspend' }),
    });
    return (
      <button data-pubkey={pubkey} onClick={() => action.mutate({ pubkey, reportTarget })}>
        Unsuspend
      </button>
    );
  },
}));

vi.mock('@/components/UserProfileCard', () => ({ UserProfileCard: () => null }));
vi.mock('@/components/AISummary', () => ({ AISummary: () => null }));
vi.mock('@/components/HiveAIReport', () => ({ HiveAIReport: () => null }));
vi.mock('@/components/AIDetectionReport', () => ({ AIDetectionReport: () => null }));
vi.mock('@/components/MediaPreview', () => ({ MediaPreview: () => null }));
vi.mock('@/components/ThreadModal', () => ({ ThreadModal: () => null }));
vi.mock('@/components/EventActions', () => ({ EventActions: () => null }));
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
const POST: NostrEvent = { ...REPORT, id: EVENT_ID, pubkey: REPORTED_PUBKEY, kind: 1, tags: [], content: 'the reported post' };

const JUST_RESTORED = /The account was just unsuspended, and its posts can take a few minutes to reappear, if they are still stored\./;

describe('ReportDetail after an Unsuspend of a post read before the suspension', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    relay.post = undefined;
    relay.firstRead = undefined;
    relay.bannedLookup = undefined;
    relay.finishAction = undefined;
    relay.reads = 0;
    api.verifyPubkeyBanned.mockResolvedValue(false);
    api.verifyEventDeleted.mockResolvedValue(true);
    api.listBannedPubkeys.mockResolvedValue([]);
    api.listBannedEvents.mockResolvedValue([]);
    api.getDecisions.mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
    endRestoreWindow(REPORTED_PUBKEY, undefined);
  });

  it('reads the post again, so the panel says why it is missing rather than showing the earlier read', async () => {
    // Read before the suspension: the relay returned the post.
    relay.post = POST;
    api.listSuspendedPubkeys.mockResolvedValue([{ pubkey: REPORTED_PUBKEY }]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <TooltipProvider>
          <ReportDetail report={REPORT} />
        </TooltipProvider>
      </QueryClientProvider>,
    );
    expect(await screen.findByText('the reported post')).toBeInTheDocument();
    expect(screen.queryByText(JUST_RESTORED)).not.toBeInTheDocument();

    // Suspended since (in another tab): the relay withholds the post, but the
    // thread read on screen predates that. Then this tab unsuspends, and the
    // relay's read filter has not caught up yet.
    relay.post = undefined;
    api.listSuspendedPubkeys.mockResolvedValue([]);
    fireEvent.click(screen.getByRole('button', { name: 'Unsuspend' }));

    // The header: the live check after the action finds the post withheld.
    expect((await screen.findAllByText('Not Found on Relay', {}, { timeout: 4000 })).length).toBeGreaterThan(0);
    // The body agrees: it read the post again, and says why it is missing.
    expect(await screen.findByText(JUST_RESTORED, {}, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.queryByText('the reported post')).not.toBeInTheDocument();
    // One live check: the after-action one already found the post gone, so the
    // re-read's "not found" does not start the same check again.
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 100)); });
    expect(api.verifyEventDeleted).toHaveBeenCalledTimes(1);
  });

  // The action can finish while the report's first read is still out. That
  // read started before the action, so its answer must not land as the re-read.
  it('replaces a first read still out when the action finishes', async () => {
    let answerFirstRead!: (post: NostrEvent | undefined) => void;
    relay.firstRead = new Promise(resolve => { answerFirstRead = resolve; });
    api.listSuspendedPubkeys.mockResolvedValue([{ pubkey: REPORTED_PUBKEY }]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <TooltipProvider>
          <ReportDetail report={REPORT} />
        </TooltipProvider>
      </QueryClientProvider>,
    );

    api.listSuspendedPubkeys.mockResolvedValue([]);
    fireEvent.click(screen.getByRole('button', { name: 'Unsuspend' }));
    // The pane has run its after-action handling (the live check starts there).
    await waitFor(() => expect(api.verifyEventDeleted).toHaveBeenCalled());
    // The read from before the action answers late, with the post the relay
    // returned then.
    answerFirstRead(POST);

    expect(await screen.findByText(JUST_RESTORED, {}, { timeout: 4000 })).toBeInTheDocument();
    // The re-read was a read of its own, not the held one answering for it.
    expect(relay.reads).toBe(2);
  });

  // The re-read after the action finds no post, and the banned-event fallback
  // is still out, so the pane does not know yet whether the post is missing.
  // A live check that answers then has looked at the miss that follows.
  it('does not run the live check again when it answered while the banned-event fallback was loading', async () => {
    relay.post = POST;
    api.listSuspendedPubkeys.mockResolvedValue([{ pubkey: REPORTED_PUBKEY }]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <TooltipProvider>
          <ReportDetail report={REPORT} />
        </TooltipProvider>
      </QueryClientProvider>,
    );
    expect(await screen.findByText('the reported post')).toBeInTheDocument();

    let answerLookup!: () => void;
    relay.bannedLookup = new Promise(resolve => { answerLookup = resolve; });
    let answerCheck!: (gone: boolean) => void;
    api.verifyEventDeleted.mockImplementationOnce(() => new Promise(resolve => { answerCheck = resolve; }));
    relay.post = undefined;
    api.listSuspendedPubkeys.mockResolvedValue([]);
    fireEvent.click(screen.getByRole('button', { name: 'Unsuspend' }));

    // The re-read has landed with no post; the fallback is out.
    await waitFor(() => expect(relay.reads).toBe(2));
    await waitFor(() => expect(screen.queryByText('the reported post')).not.toBeInTheDocument());
    await waitFor(() => expect(api.verifyEventDeleted).toHaveBeenCalledTimes(1));
    // The live check finds the post on the relay before the fallback answers.
    await act(async () => { answerCheck(false); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
    await act(async () => { answerLookup(); });

    await act(async () => { await new Promise(resolve => setTimeout(resolve, 100)); });
    expect(api.verifyEventDeleted).toHaveBeenCalledTimes(1);
  });

  it('refreshes the original post if the moderator switches to a different account during an Unsuspend', async () => {
    let finish!: () => void;
    relay.finishAction = new Promise(resolve => { finish = resolve; });
    relay.post = POST;
    api.listSuspendedPubkeys.mockResolvedValue([{ pubkey: REPORTED_PUBKEY }]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const pane = (report: NostrEvent) => (
      <QueryClientProvider client={client}>
        <TooltipProvider><ReportDetail report={report} /></TooltipProvider>
      </QueryClientProvider>
    );
    const { rerender } = render(pane(REPORT));
    expect(await screen.findByText('the reported post')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Unsuspend' }));

    const otherPost = { ...POST, id: '8'.repeat(64), pubkey: OTHER_PUBKEY, content: 'the other post' };
    relay.post = otherPost;
    rerender(pane({ ...REPORT, id: '9'.repeat(64), tags: [['e', otherPost.id], ['p', OTHER_PUBKEY]] }));
    expect(await screen.findByText('the other post')).toBeInTheDocument();
    api.listSuspendedPubkeys.mockResolvedValue([]);
    api.verifyEventDeleted.mockImplementation(async (eventId: string) => eventId === EVENT_ID);
    finish();

    await waitFor(() => expect(client.getQueryState(['thread', EVENT_ID, 3, API_URL, undefined])?.isInvalidated).toBe(true));
    expect(relay.reads).toBe(2);
    rerender(pane(REPORT));
    expect(await screen.findByText(JUST_RESTORED)).toBeInTheDocument();
    expect(screen.queryByText('the reported post')).not.toBeInTheDocument();
  });

  // The report on screen when the action finishes is on another post by the
  // account acted on. Its read predates the action too.
  it('refreshes a post by the same account on screen when the action finishes after switching reports', async () => {
    let finish!: () => void;
    relay.finishAction = new Promise(resolve => { finish = resolve; });
    relay.post = POST;
    api.listSuspendedPubkeys.mockResolvedValue([{ pubkey: REPORTED_PUBKEY }]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const pane = (report: NostrEvent) => (
      <QueryClientProvider client={client}>
        <TooltipProvider><ReportDetail report={report} /></TooltipProvider>
      </QueryClientProvider>
    );
    const { rerender } = render(pane(REPORT));
    expect(await screen.findByText('the reported post')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Unsuspend' }));

    const samePost = { ...POST, id: '8'.repeat(64), content: 'another post by the account' };
    relay.post = samePost;
    rerender(pane({ ...REPORT, id: '9'.repeat(64), tags: [['e', samePost.id], ['p', REPORTED_PUBKEY]] }));
    expect(await screen.findByText('another post by the account')).toBeInTheDocument();
    // The relay withholds it now, until its read filter catches up.
    relay.post = undefined;
    api.listSuspendedPubkeys.mockResolvedValue([]);
    finish();

    expect(await screen.findByText(JUST_RESTORED, {}, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.queryByText('another post by the account')).not.toBeInTheDocument();
    // The first post's read, the second's, and the second's re-read.
    expect(relay.reads).toBe(3);
  });

  // The re-read finds no post, so the account comes from the report itself
  // unless the pane keeps the author it read. Keeping it matters here: the
  // just-restored line and the account actions follow that account.
  it.each([
    ['the p tag names another account', [['e', EVENT_ID], ['p', OTHER_PUBKEY]]],
    ['the report has no p tag', [['e', EVENT_ID]]],
  ])('keeps acting on the post\'s author when %s', async (_, tags) => {
    relay.post = POST;
    api.listSuspendedPubkeys.mockResolvedValue([{ pubkey: REPORTED_PUBKEY }]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <TooltipProvider>
          <ReportDetail report={{ ...REPORT, tags }} />
        </TooltipProvider>
      </QueryClientProvider>,
    );
    expect(await screen.findByText('the reported post')).toBeInTheDocument();

    relay.post = undefined;
    api.listSuspendedPubkeys.mockResolvedValue([]);
    fireEvent.click(screen.getByRole('button', { name: 'Unsuspend' }));

    expect(await screen.findByText(JUST_RESTORED, {}, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.queryByText('the reported post')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Unsuspend' })).toHaveAttribute('data-pubkey', REPORTED_PUBKEY);
  });
});
