// ABOUTME: After a restore from the report pane (Restore Event, the Undo-delete toast, Restore
// ABOUTME: Content) the body reads the post again instead of keeping its "banned" view (#445).

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { ReportDetail } from './ReportDetail';
import type { NostrEvent } from '@nostrify/nostrify';
import { moderationStatusMock } from '@/test/moderationStatusMock';
import { bannedEventQueryKey } from '@/lib/bannedEventKey';
import type { UserActionChange } from './UserActions';

const REPORTED_PUBKEY = 'd'.repeat(64);
const MOD_PUBKEY = 'e'.repeat(64);
const EVENT_ID = 'c'.repeat(64);
const OTHER_ID = '8'.repeat(64);
const API_URL = 'https://api.a.example';

// What the relay holds right now. `banned` is what getbannedevent returns,
// `post` what a normal read returns. Each is read only when its query runs, so
// a cached answer outlives a change here.
const relay = vi.hoisted(() => ({
  apiUrl: undefined as string | undefined,
  banned: undefined as NostrEvent | undefined,
  post: undefined as NostrEvent | undefined,
  bannedReads: 0,
  reads: 0,
  // When set, the next getbannedevent waits for it, answering as the relay did when it started.
  hold: undefined as Promise<void> | undefined,
}));
const decisionFlags = vi.hoisted(() => ({ isAutoHidden: false }));
const toasts = vi.hoisted(() => ({ calls: [] as Array<{ action?: ReactElement }> }));
const api = vi.hoisted(() => ({
  deleteEvent: vi.fn(),
  restoreEvent: vi.fn(),
  markAsReviewed: vi.fn(),
  logDecision: vi.fn(),
  deleteDecisions: vi.fn(),
  asModerator: vi.fn(),
  // getbannedevent: the relay returns the event while it is banned, and fails
  // (the hook reads that as null) when it is not.
  callRelayRpc: vi.fn(async (_method: string, params: string[]) => {
    relay.bannedReads += 1;
    const answer = relay.banned?.id === params[0] ? relay.banned : undefined;
    const held = relay.hold;
    relay.hold = undefined;
    await held;
    if (!answer) throw new Error('not banned');
    return answer;
  }),
}));
const recheck = vi.hoisted(() => ({ fn: vi.fn() }));

vi.mock('@/components/AccountTypeBadge', () => ({ AccountTypeLabel: () => null }));
vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()),
  useNavigate: () => vi.fn(),
}));
vi.mock('@/hooks/useAdminApi', () => ({
  useAdminApi: () => ({ ...api, asModerator: () => api }),
  useApiUrl: () => relay.apiUrl ?? API_URL,
}));
vi.mock('@/hooks/useToast', () => ({ useToast: () => ({ toast: (t: { action?: ReactElement }) => { toasts.calls.push(t); } }) }));
vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ user: { pubkey: MOD_PUBKEY }, getModeratorToken: () => 'moderator-login-token' }),
}));
vi.mock('@/hooks/useAppContext', () => ({
  useAppContext: () => ({ config: { relayUrl: 'wss://relay.example', apiUrl: relay.apiUrl ?? API_URL } }),
}));
vi.mock('@/hooks/useDecisionLog', () => ({
  useDecisionLog: () => ({
    hasDecisions: false,
    isPendingReview: decisionFlags.isAutoHidden,
    isDeleted: false,
    isAutoHidden: decisionFlags.isAutoHidden,
    isPending: false,
    error: null,
    isAutoHideRestored: false,
    isAutoHideRestoreFailed: false,
    isAutoHideUnresolved: false,
    decisions: [],
    latestDecision: null,
    refetch: vi.fn(),
  }),
}));
vi.mock('@/hooks/useModerationStatus', () => ({
  useModerationStatus: () => moderationStatusMock({ recheck: recheck.fn }),
}));
// The thread read, keyed and cached as useThread does (staleTime 60s).
vi.mock('@/hooks/useThread', () => ({
  useThread: (eventId: string | undefined, depth: number, apiUrl?: string, relayHint?: string) => useQuery({
    queryKey: ['thread', eventId, depth, apiUrl, relayHint],
    queryFn: async () => {
      relay.reads += 1;
      const post = relay.post?.id === eventId ? relay.post : null;
      return { event: post, ancestors: [], replies: [], repostedEvent: null, isRepost: false, fetchSource: null };
    },
    enabled: !!eventId,
    staleTime: 60_000,
  }),
}));
vi.mock('@/hooks/useUserSummary', () => ({ useUserSummary: () => ({ data: null, isLoading: false }) }));
vi.mock('@/hooks/useMediaStatus', () => ({ useMediaStatus: () => ({ results: [] }) }));
vi.mock('@/hooks/useAuthor', () => ({ useAuthor: () => ({ data: undefined, isLoading: false }) }));
vi.mock('@/hooks/useUserStats', () => ({ useUserStats: () => ({ data: undefined, isLoading: false, error: null }) }));

vi.mock('@/components/UserActions', () => ({
  UserActions: ({ onActionComplete }: { onActionComplete?: (c: UserActionChange) => void }) => (
    <>
      <button onClick={() => onActionComplete?.({ accountStatusChanged: false, action: 'delete-all' })}>Delete All Content</button>
      <button onClick={() => onActionComplete?.({ accountStatusChanged: false })}>Age Restrict All</button>
    </>
  ),
}));
// A recent post with a delete button, as UserProfileCard lists it.
vi.mock('@/components/UserProfileCard', () => ({
  UserProfileCard: ({ onDeleteEvent }: { onDeleteEvent?: (id: string) => void }) => (
    <>
      <button onClick={() => onDeleteEvent?.(EVENT_ID)}>Delete recent post</button>
      <button onClick={() => onDeleteEvent?.(OTHER_ID)}>Delete other post</button>
    </>
  ),
}));
// The post actions, as EventActions reports them: a restore or a ban names the
// post, and either completes.
vi.mock('@/components/EventActions', () => ({
  EventActions: ({ eventId, onActionComplete, onEventRestored, onEventBanned }: {
    eventId: string; onActionComplete?: () => void; onEventRestored?: (id: string) => void; onEventBanned?: (id: string) => void;
  }) => (
    <>
      <button onClick={() => { onEventRestored?.(eventId); onActionComplete?.(); }}>Restore Event</button>
      <button onClick={() => { onEventBanned?.(eventId); onActionComplete?.(); }}>Ban Event</button>
      {/* A ban that started on another post, finishing while this one is open. */}
      <button onClick={() => { onEventBanned?.(OTHER_ID); onActionComplete?.(); }}>Ban other post</button>
    </>
  ),
}));
vi.mock('@/components/AISummary', () => ({ AISummary: () => null }));
vi.mock('@/components/HiveAIReport', () => ({ HiveAIReport: () => null }));
vi.mock('@/components/AIDetectionReport', () => ({ AIDetectionReport: () => null }));
vi.mock('@/components/MediaPreview', () => ({ MediaPreview: () => null }));
vi.mock('@/components/ThreadModal', () => ({ ThreadModal: () => null }));
vi.mock('@/components/BulkDeleteByKind', () => ({
  BulkDeleteByKind: ({ onComplete }: { onComplete?: () => void }) => <button onClick={() => onComplete?.()}>Bulk delete by kind</button>,
}));
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
const BANNED_VIEW = 'Event is banned on relay';

// The pane open on a banned post: the thread finds nothing, the banned-event
// fallback returns the post, and both reads are cached. Then the relay lets the
// post go again (the restore) and the pane's own fallback read would find none.
let client: QueryClient;
async function openOnBannedPost() {
  relay.banned = POST;
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <TooltipProvider><ReportDetail report={REPORT} /></TooltipProvider>
    </QueryClientProvider>,
  );
  expect(await screen.findByText(BANNED_VIEW)).toBeInTheDocument();
  expect(relay.bannedReads).toBe(1);
  relay.banned = undefined;
  relay.post = POST;
  return client;
}

describe('ReportDetail after a restore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    relay.apiUrl = undefined;
    relay.banned = undefined;
    relay.post = undefined;
    relay.bannedReads = 0;
    relay.reads = 0;
    relay.hold = undefined;
    decisionFlags.isAutoHidden = false;
    toasts.calls = [];
    api.restoreEvent.mockResolvedValue({ recorded: true, reconciled: true });
    api.deleteEvent.mockResolvedValue(undefined);
  });
  afterEach(cleanup);

  // Each path must read the restored post again, not only re-run the live check.
  const paths = {
    'Restore Event': async () => { fireEvent.click(screen.getByRole('button', { name: 'Restore Event' })); },
    'Undo delete': async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Delete recent post' }));
      await waitFor(() => expect(toasts.calls.some(t => t.action)).toBe(true));
      const undo = render(toasts.calls.find(t => t.action)!.action!);
      fireEvent.click(undo.getByText('Undo'));
      await waitFor(() => expect(api.restoreEvent).toHaveBeenCalledWith(EVENT_ID, 'Deletion undone by moderator'));
    },
    'Restore Content': async () => {
      fireEvent.click(screen.getByRole('button', { name: /Restore Content/ }));
      await waitFor(() => expect(api.restoreEvent).toHaveBeenCalled());
    },
  } as const;

  it.each(Object.keys(paths) as Array<keyof typeof paths>)('%s: the body drops the banned view and shows the post', async (path) => {
    decisionFlags.isAutoHidden = path === 'Restore Content';
    await openOnBannedPost();
    await paths[path]();
    expect(await screen.findByText('the reported post')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText(BANNED_VIEW)).not.toBeInTheDocument());
  });

  // A restore whose thread read still misses the post must not leave the body
  // on the banned view: the fallback is read again and finds no ban. Swapping
  // the fresh fallback read for the thread read alone on any path leaves the
  // cached banned answer on screen.
  it.each(Object.keys(paths) as Array<keyof typeof paths>)('%s: reads the banned-event fallback again, not from its five-minute cache', async (path) => {
    decisionFlags.isAutoHidden = path === 'Restore Content';
    await openOnBannedPost();
    relay.post = undefined;
    await paths[path]();
    await waitFor(() => expect(relay.bannedReads).toBe(2));
    await waitFor(() => expect(relay.reads).toBe(2));
    await waitFor(() => expect(screen.queryByText(BANNED_VIEW)).not.toBeInTheDocument());
  });

  // A banned-event read still out when the restore finishes started before it.
  // Its answer ("banned") must not land as the fresh one.
  it('Restore Event: a banned-event read still out is replaced, not joined', async () => {
    let release!: () => void;
    relay.hold = new Promise(resolve => { release = resolve; });
    relay.banned = POST;
    client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <TooltipProvider><ReportDetail report={REPORT} /></TooltipProvider>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(relay.bannedReads).toBe(1));
    relay.banned = undefined;
    relay.post = POST;
    fireEvent.click(screen.getByRole('button', { name: 'Restore Event' }));
    await waitFor(() => expect(relay.bannedReads).toBe(2));
    await act(async () => { release(); });
    expect(await screen.findByText('the reported post')).toBeInTheDocument();
    await waitFor(() => expect(client.getQueryData(bannedEventQueryKey(API_URL, EVENT_ID))).toBeNull());
  });

  // The restore's fresh read cached "not banned" for five minutes. A re-ban
  // inside that window must not be served that answer.
  it('Restore Event then Ban: the banned view comes back when the post is read again', async () => {
    await openOnBannedPost();
    fireEvent.click(screen.getByRole('button', { name: 'Restore Event' }));
    expect(await screen.findByText('the reported post')).toBeInTheDocument();
    await waitFor(() => expect(relay.bannedReads).toBe(2));

    relay.banned = POST;
    relay.post = undefined;
    fireEvent.click(screen.getByRole('button', { name: 'Ban Event' }));
    // The post stays on screen at the ban; a later read of the thread finds nothing.
    expect(screen.getByText('the reported post')).toBeInTheDocument();
    await act(async () => { await client.invalidateQueries({ queryKey: ['thread'] }); });
    expect(await screen.findByText(BANNED_VIEW)).toBeInTheDocument();
    expect(screen.getByText('the reported post')).toBeInTheDocument();
  });

  // A ban names the post it banned, which may not be the one open when it finishes.
  it('Ban of another post marks that post\'s banned-event read stale, not the open one\'s', async () => {
    await openOnBannedPost();
    const otherBanned = bannedEventQueryKey(API_URL, OTHER_ID);
    client.setQueryData(otherBanned, null);
    fireEvent.click(screen.getByRole('button', { name: 'Ban other post' }));
    await waitFor(() => expect(client.getQueryState(otherBanned)?.isInvalidated).toBe(true));
    expect(client.getQueryState(bannedEventQueryKey(API_URL, EVENT_ID))?.isInvalidated).toBe(false);
    // The open post's banned view and its read stand: marking the whole root would fail this.
    expect(relay.bannedReads).toBe(1);
    expect(screen.getByText(BANNED_VIEW)).toBeInTheDocument();
  });

  // The restore's fresh read cached "not banned". Every way of banning a post,
  // not only EventActions' own, must stop that answer from standing.
  const otherBans = {
    'the recent-post Delete': () => fireEvent.click(screen.getByRole('button', { name: 'Delete recent post' })),
    'BulkDeleteByKind': () => fireEvent.click(screen.getByRole('button', { name: 'Bulk delete by kind' })),
    'UserActions Delete All Content': () => fireEvent.click(screen.getByRole('button', { name: 'Delete All Content' })),
  } as const;
  it.each(Object.keys(otherBans) as Array<keyof typeof otherBans>)('Restore Event then %s: the banned view comes back when the post is read again', async (name) => {
    await openOnBannedPost();
    fireEvent.click(screen.getByRole('button', { name: 'Restore Event' }));
    expect(await screen.findByText('the reported post')).toBeInTheDocument();
    await waitFor(() => expect(relay.bannedReads).toBe(2));

    relay.banned = POST;
    relay.post = undefined;
    otherBans[name]();
    await waitFor(() => expect(client.getQueryState(bannedEventQueryKey(API_URL, EVENT_ID))?.isInvalidated).toBe(true));
    await act(async () => { await client.invalidateQueries({ queryKey: ['thread'] }); });
    expect(await screen.findByText(BANNED_VIEW)).toBeInTheDocument();
  });

  // While the banned view shows, a read right after a Ban can be refused (a
  // suspended author, or suspension status unavailable) and would blank the
  // post and its media. The read is marked stale, not fetched.
  it('Ban: does not read the banned post again while its view is showing', async () => {
    await openOnBannedPost();
    fireEvent.click(screen.getByRole('button', { name: 'Ban Event' }));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
    expect(relay.bannedReads).toBe(1);
    expect(screen.getByText(BANNED_VIEW)).toBeInTheDocument();
    expect(screen.getByText('the reported post')).toBeInTheDocument();
  });

  // A restore whose thread read still misses leaves the body on "missing", with
  // the fresh "not banned" cached. A re-Ban reads it again at once: the cached
  // null is no banned view that a refused read could blank.
  it.each(['Ban Event', 'Delete All Content', 'Bulk delete by kind'])('Restore Event then %s: the banned view comes back even if the thread still misses the post', async (button) => {
    await openOnBannedPost();
    relay.post = undefined;
    fireEvent.click(screen.getByRole('button', { name: 'Restore Event' }));
    await waitFor(() => expect(relay.bannedReads).toBe(2));
    await waitFor(() => expect(screen.queryByText(BANNED_VIEW)).not.toBeInTheDocument());

    relay.banned = POST;
    fireEvent.click(screen.getByRole('button', { name: button }));
    expect(await screen.findByText(BANNED_VIEW)).toBeInTheDocument();
    expect(relay.bannedReads).toBe(3);
  });

  // The same, for a bulk job finishing: the read is marked stale, not fetched,
  // so a refused read cannot blank the post and its media.
  it.each(['Delete All Content', 'Bulk delete by kind'])('%s: does not read the banned post again while its view is showing', async (button) => {
    await openOnBannedPost();
    relay.post = undefined;
    fireEvent.click(screen.getByRole('button', { name: button }));
    await waitFor(() => expect(client.getQueryState(bannedEventQueryKey(API_URL, EVENT_ID))?.isInvalidated).toBe(true));
    expect(relay.bannedReads).toBe(1);
    expect(screen.getByText(BANNED_VIEW)).toBeInTheDocument();
    expect(screen.getByText('the reported post')).toBeInTheDocument();
  });

  // A first read still out when the Ban finishes started before it. It is
  // replaced, not joined, so its "not banned" does not land as the answer.
  it.each(['Ban Event', 'Delete All Content', 'Bulk delete by kind'])('%s replaces a first banned-event read still out', async (button) => {
    let release!: () => void;
    relay.hold = new Promise(resolve => { release = resolve; });
    client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <TooltipProvider><ReportDetail report={REPORT} /></TooltipProvider>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(relay.bannedReads).toBe(1));
    relay.banned = POST;
    fireEvent.click(screen.getByRole('button', { name: button }));
    await waitFor(() => expect(relay.bannedReads).toBe(2));
    await act(async () => { release(); });
    expect(await screen.findByText(BANNED_VIEW)).toBeInTheDocument();
  });

  // A re-ban that lands while the restore's own refresh is out: that refresh
  // started before the ban and answers "not banned", so it must not win.
  it.each(['Ban Event', 'Delete All Content', 'Bulk delete by kind'])('Restore Event then %s while the restore refresh is out: the banned view stays', async (button) => {
    await openOnBannedPost();
    relay.post = undefined;
    let release!: () => void;
    relay.hold = new Promise(resolve => { release = resolve; });
    fireEvent.click(screen.getByRole('button', { name: 'Restore Event' }));
    await waitFor(() => expect(relay.bannedReads).toBe(2));
    relay.banned = POST;
    fireEvent.click(screen.getByRole('button', { name: button }));
    await waitFor(() => expect(relay.bannedReads).toBe(3));
    await act(async () => { release(); });
    await waitFor(() => expect(client.getQueryState(bannedEventQueryKey(API_URL, EVENT_ID))).toMatchObject({
      data: POST,
      fetchStatus: 'idle',
      isInvalidated: false,
    }));
    expect(screen.getByText(BANNED_VIEW)).toBeInTheDocument();
  });

  it('finishes refreshing a restored post when a bulk delete of another kind completes', async () => {
    await openOnBannedPost();
    relay.post = undefined;
    let release!: () => void;
    relay.hold = new Promise(resolve => { release = resolve; });
    fireEvent.click(screen.getByRole('button', { name: 'Restore Event' }));
    await waitFor(() => expect(relay.bannedReads).toBe(2));

    // The bulk job did not touch this post, so the worker still reports no ban.
    fireEvent.click(screen.getByRole('button', { name: 'Bulk delete by kind' }));
    await waitFor(() => expect(relay.bannedReads).toBe(3));
    await act(async () => { release(); });
    await waitFor(() => expect(client.getQueryState(bannedEventQueryKey(API_URL, EVENT_ID))).toMatchObject({
      data: null,
      fetchStatus: 'idle',
    }));
    expect(screen.queryByText(BANNED_VIEW)).not.toBeInTheDocument();
  });

  it('Age Restrict All leaves the banned-event read fresh', async () => {
    await openOnBannedPost();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Age Restrict All' })); });
    expect(recheck.fn).toHaveBeenCalledTimes(1);
    expect(client.getQueryState(bannedEventQueryKey(API_URL, EVENT_ID))?.isInvalidated).toBe(false);
    expect(relay.bannedReads).toBe(1);
  });

  // An Undo restores a recent post, which can be another than the report's.
  it('Undo delete of another post drops that post\'s reads, not the report\'s thread', async () => {
    await openOnBannedPost();
    const otherBanned = bannedEventQueryKey(API_URL, OTHER_ID);
    const otherThread = ['thread', OTHER_ID, 3, API_URL, undefined];
    client.setQueryData(otherBanned, null);
    client.setQueryData(otherThread, { event: null });
    fireEvent.click(screen.getByRole('button', { name: 'Delete other post' }));
    await waitFor(() => expect(toasts.calls.some(t => t.action)).toBe(true));
    const undo = render(toasts.calls.find(t => t.action)!.action!);
    fireEvent.click(undo.getByText('Undo'));
    await waitFor(() => expect(api.restoreEvent).toHaveBeenCalledWith(OTHER_ID, 'Deletion undone by moderator'));
    await waitFor(() => expect(client.getQueryState(otherBanned)?.isInvalidated).toBe(true));
    await waitFor(() => expect(client.getQueryState(otherThread)?.isInvalidated).toBe(true));
    // The report's own thread read was not touched, nor its banned view.
    expect(client.getQueryState(['thread', EVENT_ID, 3, API_URL, undefined])?.isInvalidated).toBe(false);
    expect(relay.reads).toBe(1);
    expect(screen.getByText(BANNED_VIEW)).toBeInTheDocument();
  });

  it('keeps the banned-event read in a new environment when an earlier Undo finishes', async () => {
    let finishRestore!: () => void;
    api.restoreEvent.mockReturnValue(new Promise<void>(resolve => { finishRestore = resolve; })
      .then(() => ({ recorded: true, reconciled: true })));
    relay.banned = POST;
    client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const pane = () => (
      <QueryClientProvider client={client}>
        <TooltipProvider><ReportDetail report={REPORT} /></TooltipProvider>
      </QueryClientProvider>
    );
    const { rerender } = render(pane());
    expect(await screen.findByText(BANNED_VIEW)).toBeInTheDocument();
    await paths['Undo delete']();

    // As in RelayManager, clear the shared cache and reopen on a different relay.
    rerender(<></>);
    client.clear();
    relay.apiUrl = 'https://api.b.example';
    rerender(pane());
    expect(await screen.findByText(BANNED_VIEW)).toBeInTheDocument();
    expect(relay.bannedReads).toBe(2);

    await act(async () => { finishRestore(); });
    expect(relay.bannedReads).toBe(2);
    expect(screen.getByText(BANNED_VIEW)).toBeInTheDocument();
  });
});
