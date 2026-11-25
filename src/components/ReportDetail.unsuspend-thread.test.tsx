// ABOUTME: Report detail after this tab changes the reported account's status: after an Unsuspend
// ABOUTME: or Unban the post panel reads the post again; after a Ban or Suspend it keeps its read.

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { endRestoreWindow, markRestored } from '@/lib/userStatsCache';
import { GONE_NO_CAUSE_LINE } from '@/lib/suspendedContent';
import { bannedEventQueryKey } from '@/lib/bannedEventKey';
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
// `nextRead`, when set, holds the next read open until it settles, and that
// read answers with what it settles to. `bannedLookup`, when set, holds the
// banned-event fallback open the same way. While `bannedServes` is set, the
// fallback answers `banned`, kept for useBannedEvent's five minutes.
const relay = vi.hoisted(() => ({
  banned: undefined as NostrEvent | undefined,
  bannedServes: false,
  bannedReads: 0,
  apiUrl: undefined as string | undefined,
  post: undefined as NostrEvent | undefined,
  nextRead: undefined as Promise<NostrEvent | undefined> | undefined,
  bannedLookup: undefined as Promise<void> | undefined,
  finishAction: undefined as Promise<void> | undefined,
  reads: 0,
}));
// The account action the mocked UserActions takes.
const account = vi.hoisted(() => ({ action: 'unsuspend' as 'suspend' | 'unsuspend' | 'ban' | 'unban' }));

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
  useApiUrl: () => relay.apiUrl ?? API_URL,
}));
vi.mock('@/hooks/useToast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ user: { pubkey: MOD_PUBKEY }, getModeratorToken: () => 'moderator-login-token' }),
}));
vi.mock('@/hooks/useAppContext', () => ({
  useAppContext: () => ({ config: { relayUrl: 'wss://relay.example', apiUrl: relay.apiUrl ?? API_URL } }),
}));
// The banned-event fallback the pane reads once the thread finds no post: not
// banned one at a time, so null, at once. While `relay.bannedLookup` is set it
// is a query of its own that answers null when that settles.
vi.mock('@/hooks/useBannedEvent', () => ({
  useBannedEvent: (eventId: string | undefined, enabled: boolean) => {
    const held = relay.bannedLookup;
    const live = !!held || relay.bannedServes;
    const lookup = useQuery({
      queryKey: bannedEventQueryKey(relay.apiUrl ?? API_URL, eventId),
      queryFn: async () => {
        await held;
        relay.bannedReads += 1;
        return relay.banned?.id === eventId ? relay.banned : null;
      },
      enabled: live && enabled && !!eventId,
      staleTime: 5 * 60 * 1000,
    });
    return live ? lookup : { data: null, isLoading: false };
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
      const held = relay.nextRead;
      relay.nextRead = undefined;
      const post = held ? await held : relay.post?.id === eventId ? relay.post : undefined;
      return { event: post ?? null, ancestors: [], replies: [], repostedEvent: null, isRepost: false, fetchSource: null };
    },
    enabled: !!eventId,
    staleTime: 60_000,
  }),
}));
// The account actions, reduced to what each tells the pane when it succeeds,
// as UserActions does: an Unsuspend opens the restore window first.
const ACTION_LABELS = { suspend: 'Suspend', unsuspend: 'Unsuspend', ban: 'Ban', unban: 'Unban' } as const;
vi.mock('@/components/UserActions', () => ({
  UserActions: ({ pubkey, reportTarget, statusPending, onActionComplete }: ComponentProps<typeof UserActions>) => {
    const queryClient = useQueryClient();
    const kind = account.action;
    const action = useMutation({
      mutationFn: async ({ pubkey: target }: { pubkey: string; reportTarget: typeof reportTarget }) => {
        await relay.finishAction;
        if (kind === 'unsuspend') await markRestored(queryClient, target, undefined);
      },
      onSuccess: (_, target) => onActionComplete?.({ ...target, accountStatusChanged: true, action: kind }),
    });
    return (
      <button data-pubkey={pubkey} data-status-pending={statusPending} onClick={() => action.mutate({ pubkey, reportTarget })}>
        {ACTION_LABELS[kind]}
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
// The files the post's media actions (Block Media, Age Restrict, Unblock) act on.
vi.mock('@/components/EventActions', () => ({
  EventActions: ({ mediaHashes }: { mediaHashes: string[] }) => <div data-testid="event-actions" data-media={mediaHashes.join(',')} />,
}));
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

const VIDEO_HASH = '5'.repeat(64);
const VIDEO_POST: NostrEvent = {
  ...POST,
  tags: [['imeta', `url https://media.example/${VIDEO_HASH}.mp4`, `x ${VIDEO_HASH}`, 'm video/mp4']],
};

const JUST_RESTORED = /The account was just unsuspended, and its posts can take a few minutes to reappear, if they are still stored\./;

describe('ReportDetail after an account action on a post read before it', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    relay.apiUrl = undefined;
    relay.post = undefined;
    relay.nextRead = undefined;
    relay.bannedLookup = undefined;
    relay.banned = undefined;
    relay.bannedServes = false;
    relay.bannedReads = 0;
    relay.finishAction = undefined;
    relay.reads = 0;
    account.action = 'unsuspend';
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
    relay.nextRead = new Promise(resolve => { answerFirstRead = resolve; });
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

  it('does not repeat a live check that answers while the thread is refreshing a cached post', async () => {
    relay.post = POST;
    api.listSuspendedPubkeys.mockResolvedValue([{ pubkey: REPORTED_PUBKEY }]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <TooltipProvider><ReportDetail report={REPORT} /></TooltipProvider>
      </QueryClientProvider>,
    );
    expect(await screen.findByText('the reported post')).toBeInTheDocument();

    let answerRead!: (post: NostrEvent | undefined) => void;
    relay.nextRead = new Promise(resolve => { answerRead = resolve; });
    let answerCheck!: (gone: boolean) => void;
    api.verifyEventDeleted.mockImplementation(() => new Promise(resolve => { answerCheck = resolve; }));
    api.listSuspendedPubkeys.mockResolvedValue([]);
    const unsuspend = screen.getByRole('button', { name: 'Unsuspend' });
    fireEvent.click(unsuspend);

    await waitFor(() => expect(relay.reads).toBe(2));
    await waitFor(() => expect(api.verifyEventDeleted).toHaveBeenCalledTimes(1));
    expect(unsuspend).toHaveAttribute('data-status-pending', 'true');
    expect(screen.getByText('the reported post')).toBeInTheDocument();

    await act(async () => { answerCheck(false); });
    await waitFor(() => expect(unsuspend).toHaveAttribute('data-status-pending', 'false'));
    await act(async () => { answerRead(undefined); });

    await waitFor(() => expect(screen.queryByText('the reported post')).not.toBeInTheDocument());
    expect(api.verifyEventDeleted).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/Event is still on the relay/)).toBeInTheDocument();
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

  it('keeps the thread read for another environment when an Unsuspend finishes after a switch', async () => {
    let finish!: () => void;
    relay.finishAction = new Promise(resolve => { finish = resolve; });
    relay.post = POST;
    api.listSuspendedPubkeys.mockResolvedValue([{ pubkey: REPORTED_PUBKEY }]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const pane = (environment: string) => (
      <QueryClientProvider client={client}>
        <TooltipProvider><ReportDetail key={environment} report={REPORT} /></TooltipProvider>
      </QueryClientProvider>
    );
    const { rerender } = render(pane(API_URL));
    expect(await screen.findByText('the reported post')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Unsuspend' }));
    await waitFor(() => expect(client.isMutating()).toBe(1));

    // As in RelayManager, clear the shared cache and remount the report pane
    // for the new environment. The same signed event can be on both relays.
    const otherApi = 'https://api.b.example';
    relay.apiUrl = otherApi;
    rerender(<></>);
    client.clear();
    rerender(pane(otherApi));
    await waitFor(() => expect(client.getQueryData(['thread', EVENT_ID, 3, otherApi, undefined])).toMatchObject({ event: POST }));
    expect(relay.reads).toBe(2);

    await act(async () => { finish(); });
    await waitFor(() => expect(api.verifyEventDeleted).toHaveBeenCalledWith(EVENT_ID));
    expect(relay.reads).toBe(2);
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
  // A Ban purges the account's posts and a Suspend withholds them, so a re-read
  // would find no post, and the media actions would lose the files they act on.
  // The pane keeps the read from before the action instead; the header says why
  // the post is gone.
  it.each(['ban', 'suspend'] as const)('keeps the earlier read and its media actions after a %s', async (kind) => {
    account.action = kind;
    relay.post = VIDEO_POST;
    api.verifyEventDeleted.mockResolvedValue(false);
    api.listSuspendedPubkeys.mockResolvedValue([]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <TooltipProvider><ReportDetail report={REPORT} /></TooltipProvider>
      </QueryClientProvider>,
    );
    expect(await screen.findByText('the reported post')).toBeInTheDocument();
    expect(screen.getByTestId('event-actions')).toHaveAttribute('data-media', VIDEO_HASH);

    relay.post = undefined;
    api.verifyEventDeleted.mockResolvedValue(true);
    fireEvent.click(screen.getByRole('button', { name: ACTION_LABELS[kind] }));

    // The after-action live check has answered: the post is gone from the relay.
    // A re-read would have started with that check, so once nothing is reading
    // any more, none ran.
    expect((await screen.findAllByText('Not Found on Relay', {}, { timeout: 4000 })).length).toBeGreaterThan(0);
    await waitFor(() => expect(client.isFetching() + client.isMutating()).toBe(0));
    expect(relay.reads).toBe(1);
    expect(screen.getByText('the reported post')).toBeInTheDocument();
    expect(screen.getByTestId('event-actions')).toHaveAttribute('data-media', VIDEO_HASH);
  });

  // Issue #445: the banned-event read is kept for five minutes. After a Suspend
  // the worker refuses that read for the author. The pane keeps the post and
  // its media files on screen at the moment of the Suspend, but a reopened
  // report reads it afresh, so the refusal is what shows. After a Ban
  // moderators may still view the post, so its cached read stands.
  it.each(['suspend', 'ban'] as const)('after a %s, keeps the banned-event read on screen and handles it on reopen', async (kind) => {
    account.action = kind;
    relay.bannedServes = true;
    relay.banned = VIDEO_POST;
    api.listSuspendedPubkeys.mockResolvedValue([]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const pane = () => (
      <QueryClientProvider client={client}>
        <TooltipProvider><ReportDetail report={REPORT} /></TooltipProvider>
      </QueryClientProvider>
    );
    const { unmount } = render(pane());
    expect(await screen.findByText('the reported post')).toBeInTheDocument();
    expect(screen.getByText('Event is banned on relay')).toBeInTheDocument();
    expect(relay.bannedReads).toBe(1);

    // From now on a fresh read answers nothing: after a Suspend that is the
    // worker's refusal; after a Ban it only shows whether a fresh read ran.
    relay.banned = undefined;
    fireEvent.click(screen.getByRole('button', { name: ACTION_LABELS[kind] }));
    await waitFor(() => expect(client.isFetching() + client.isMutating()).toBe(0), { timeout: 4000 });
    // Nothing changes on screen at the action.
    expect(screen.getByText('the reported post')).toBeInTheDocument();
    expect(screen.getByTestId('event-actions')).toHaveAttribute('data-media', VIDEO_HASH);
    expect(relay.bannedReads).toBe(1);
    unmount();

    render(pane());
    await waitFor(() => expect(client.isFetching() + client.isMutating()).toBe(0), { timeout: 4000 });
    if (kind === 'suspend') {
      expect(relay.bannedReads).toBe(2);
      expect(screen.queryByText('the reported post')).not.toBeInTheDocument();
      expect(screen.queryByText('Event is banned on relay')).not.toBeInTheDocument();
    } else {
      expect(relay.bannedReads).toBe(1);
      expect(screen.getByText('the reported post')).toBeInTheDocument();
    }
  });

  // An Unban lifts what hid the post, so the pane reads it again, as after an
  // Unsuspend. Here the ban had purged it, and an Unban opens no restore
  // window, so the body says the relay returned nothing, as the header does.
  it('reads the post again after an Unban', async () => {
    account.action = 'unban';
    relay.post = POST;
    api.listSuspendedPubkeys.mockResolvedValue([]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <TooltipProvider><ReportDetail report={REPORT} /></TooltipProvider>
      </QueryClientProvider>,
    );
    expect(await screen.findByText('the reported post')).toBeInTheDocument();

    relay.post = undefined;
    fireEvent.click(screen.getByRole('button', { name: 'Unban' }));

    expect((await screen.findAllByText('Not Found on Relay', {}, { timeout: 4000 })).length).toBeGreaterThan(0);
    expect(await screen.findByText(GONE_NO_CAUSE_LINE, {}, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.queryByText('the reported post')).not.toBeInTheDocument();
    // One live check: the after-action one, not a second for the re-read's miss.
    await waitFor(() => expect(client.isFetching() + client.isMutating()).toBe(0));
    expect(relay.reads).toBe(2);
    expect(api.verifyEventDeleted).toHaveBeenCalledTimes(1);
  });
});
