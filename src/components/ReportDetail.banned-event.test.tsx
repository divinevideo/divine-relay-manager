// ABOUTME: Verifies how report moderation actions update cached banned posts (#445).

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { ReportDetail } from './ReportDetail';
import type { NostrEvent } from '@nostrify/nostrify';
import { moderationStatusMock } from '@/test/moderationStatusMock';
import { bannedEventQueryKey, isBannedEventReadTainted, suspendBannedEventReads } from '@/lib/bannedEventKey';
import type { UserActionChange } from './UserActions';

const REPORTED_PUBKEY = 'd'.repeat(64);
const MOD_PUBKEY = 'e'.repeat(64);
const EVENT_ID = 'c'.repeat(64);
const OTHER_ID = '8'.repeat(64);
const API_URL = 'https://api.a.example';
const OTHER_API = 'https://api.b.example';

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

// The latest completion callback the pane gave UserActions: a Suspend that
// lands after the pane was closed runs the closed pane's callback.
const completion = vi.hoisted(() => ({
  latest: undefined as undefined | ((c: UserActionChange) => void),
  // The report target the pane gave UserActions at the latest render, and the
  // one captured when a Suspend was started (it finishes later).
  target: undefined as undefined | { eventId?: string; selection?: number },
  started: undefined as undefined | { eventId?: string; selection?: number },
}));
vi.mock('@/components/UserActions', () => ({
  UserActions: ({ onActionComplete, reportTarget }: { onActionComplete?: (c: UserActionChange) => void; reportTarget?: { eventId?: string; selection?: number } }) => (completion.latest = onActionComplete, completion.target = reportTarget, (
    <>
      <button onClick={() => onActionComplete?.({ accountStatusChanged: true, action: 'suspend', pubkey: '6'.repeat(64), reportTarget })}>Suspend p-tag account</button>
      <button onClick={() => onActionComplete?.({ accountStatusChanged: true, action: 'suspend', pubkey: REPORTED_PUBKEY, reportTarget: { eventId: EVENT_ID } })}>Suspend from the first report</button>
      <button onClick={() => { completion.started = reportTarget; }}>Start suspend</button>
      <button onClick={() => onActionComplete?.({ accountStatusChanged: true, action: 'suspend', pubkey: REPORTED_PUBKEY, reportTarget: completion.started })}>Finish suspend</button>
      <button onClick={() => onActionComplete?.({ accountStatusChanged: true, action: 'unban', pubkey: REPORTED_PUBKEY, reportTarget, suspensionEnded: true })}>Unban ending suspension</button>
      <button onClick={() => onActionComplete?.({ accountStatusChanged: false, action: 'delete-all' })}>Delete All Content</button>
      <button onClick={() => onActionComplete?.({ accountStatusChanged: false })}>Age Restrict All</button>
      <button onClick={() => onActionComplete?.({ accountStatusChanged: true, action: 'suspend', pubkey: REPORTED_PUBKEY, reportTarget })}>Suspend</button>
      <button onClick={() => onActionComplete?.({ accountStatusChanged: true, action: 'suspend', pubkey: '7'.repeat(64), reportTarget: { eventId: OTHER_ID } })}>Suspend other author</button>
      <button onClick={() => onActionComplete?.({ accountStatusChanged: true, action: 'unsuspend', pubkey: REPORTED_PUBKEY, reportTarget })}>Unsuspend</button>
      <button onClick={() => onActionComplete?.({ accountStatusChanged: true, action: 'unban', pubkey: REPORTED_PUBKEY, reportTarget })}>Unban</button>
    </>
  )),
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
// Record each render so tests can check media before target-change effects run.
const actionsRenders = vi.hoisted(() => ({ calls: [] as Array<{ eventId: string; media: string[] }> }));
vi.mock('@/components/EventActions', () => ({
  EventActions: ({ eventId, mediaHashes, onActionComplete, onEventRestored, onEventBanned }: {
    eventId: string; mediaHashes: string[]; onActionComplete?: () => void; onEventRestored?: (id: string) => void; onEventBanned?: (id: string) => void;
  }) => (actionsRenders.calls.push({ eventId, media: mediaHashes }), (
    <>
      <button onClick={() => { onEventRestored?.(eventId); onActionComplete?.(); }}>Restore Event</button>
      <button onClick={() => { onEventBanned?.(eventId); onActionComplete?.(); }}>Ban Event</button>
      {/* A ban that started on another post, finishing while this one is open. */}
      <button onClick={() => { onEventBanned?.(OTHER_ID); onActionComplete?.(); }}>Ban other post</button>
    </>
  )),
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
const POST_TEXT = 'the reported post';
const POST: NostrEvent = { ...REPORT, id: EVENT_ID, pubkey: REPORTED_PUBKEY, kind: 1, tags: [], content: POST_TEXT };
const BANNED_VIEW = 'Event is banned on relay';

let client: QueryClient;
const OTHER_POST: NostrEvent = { ...POST, id: OTHER_ID, content: 'the other post' };
const REPORT_B: NostrEvent = { ...REPORT, id: '9'.repeat(64), tags: [['e', OTHER_ID], ['p', REPORTED_PUBKEY]] };

const pane = (report: NostrEvent) => (
  <QueryClientProvider client={client}>
    <TooltipProvider><ReportDetail report={report} /></TooltipProvider>
  </QueryClientProvider>
);

beforeEach(() => {
  vi.clearAllMocks();
  relay.banned = undefined;
  relay.post = undefined;
  relay.bannedReads = 0;
  relay.reads = 0;
  relay.hold = undefined;
  relay.apiUrl = undefined;
  actionsRenders.calls = [];
  decisionFlags.isAutoHidden = false;
  toasts.calls = [];
  api.restoreEvent.mockResolvedValue({ recorded: true, reconciled: true });
  api.deleteEvent.mockResolvedValue(undefined);
});
afterEach(cleanup);

// Seed the cached post while the thread cannot find it. Subsequent worker
// reads return no content unless a test provides a new answer.
async function openBanned(report: NostrEvent = REPORT) {
  relay.banned = POST;
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const view = render(pane(report));
  expect(await screen.findByText(BANNED_VIEW)).toBeInTheDocument();
  relay.banned = undefined;
  return view;
}

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

// Set the relay state the pane will see after a restore. Its current view
// still shows the initial banned post until the action triggers a fresh read.
async function openOnBannedPost() {
  await openBanned();
  expect(relay.bannedReads).toBe(1);
  relay.post = POST;
}

describe('ReportDetail after a restore', () => {
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

describe('ReportDetail banned-post reads and a Suspend', () => {
  // The pane open at the moment of the Suspend keeps the post and its media,
  // so Block Media and Age Restrict still have their files.
  it('the open pane keeps the post after a Suspend, even when a later read is refused', async () => {
    await openBanned();
    fireEvent.click(screen.getByRole('button', { name: 'Suspend' }));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
    expect(screen.getByText(POST_TEXT)).toBeInTheDocument();
    expect(relay.bannedReads).toBe(1);
    // A refetch of the read (a window focus, say) is refused and must not blank it.
    await act(async () => { await client.invalidateQueries({ queryKey: ['banned-event'] }); });
    await waitFor(() => expect(relay.bannedReads).toBe(2));
    expect(screen.getByText(POST_TEXT)).toBeInTheDocument();
  });

  // Reopened after leaving, the post shows only through the audited viewer: a
  // read cached before the Suspend must not render while the fresh read is out.
  it('does not show a read cached before the Suspend when the report is reopened', async () => {
    await openBanned();
    fireEvent.click(screen.getByRole('button', { name: 'Suspend' }));
    cleanup();

    let release!: () => void;
    relay.hold = new Promise(resolve => { release = resolve; });
    render(pane(REPORT));
    await waitFor(() => expect(relay.bannedReads).toBe(2));
    expect(screen.queryByText(POST_TEXT)).not.toBeInTheDocument();
    await act(async () => { release(); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
    expect(screen.queryByText(POST_TEXT)).not.toBeInTheDocument();
  });

  it('does not show a pre-Suspend read of another post by the account, or the open post once the pane has moved on', async () => {
    const { rerender } = await openBanned();
    client.setQueryData(bannedEventQueryKey(API_URL, OTHER_ID), OTHER_POST);
    fireEvent.click(screen.getByRole('button', { name: 'Suspend' }));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(screen.getByText(POST_TEXT)).toBeInTheDocument();

    let release!: () => void;
    relay.hold = new Promise(resolve => { release = resolve; });
    rerender(pane(REPORT_B));
    // Straight away, before the effect that drops the kept post has run: the
    // first post must not show on the second report.
    expect(screen.queryByText(POST_TEXT)).not.toBeInTheDocument();
    await waitFor(() => expect(relay.bannedReads).toBe(2));
    expect(screen.queryByText('the other post')).not.toBeInTheDocument();
    await act(async () => { release(); });

    // Back on the first report: no longer retained.
    rerender(pane(REPORT));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
    expect(screen.queryByText(POST_TEXT)).not.toBeInTheDocument();
  });

  // The first report's post and media files must not reach the second report
  // even for the one render before the effect that drops them runs.
  it('never renders the kept post\'s media on another post', async () => {
    const hash = '5'.repeat(64);
    const video: NostrEvent = { ...POST, tags: [['imeta', `url https://media.example/${hash}.mp4`, `x ${hash}`, 'm video/mp4']] };
    relay.banned = video;
    client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const { rerender } = render(pane(REPORT));
    expect(await screen.findByText(BANNED_VIEW)).toBeInTheDocument();
    relay.banned = undefined;
    fireEvent.click(screen.getByRole('button', { name: 'Suspend' }));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(actionsRenders.calls.some(c => c.eventId === EVENT_ID && c.media.includes(hash))).toBe(true);

    actionsRenders.calls = [];
    rerender(pane(REPORT_B));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
    expect(actionsRenders.calls.filter(c => c.eventId === OTHER_ID).length).toBeGreaterThan(0);
    expect(actionsRenders.calls.filter(c => c.eventId === OTHER_ID && c.media.includes(hash))).toEqual([]);
  });

  // The Suspend names the report it was taken from. Finishing while another
  // report is open, it does not keep that report's post on screen.
  it('does not keep the post of a report the Suspend was not taken from', async () => {
    relay.banned = OTHER_POST;
    client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(pane(REPORT_B));
    expect(await screen.findByText('the other post')).toBeInTheDocument();
    relay.banned = undefined;
    // This Suspend names the first report (EVENT_ID) as its origin.
    fireEvent.click(screen.getByRole('button', { name: 'Suspend from the first report' }));
    await waitFor(() => expect(relay.bannedReads).toBe(2));
    await waitFor(() => expect(screen.queryByText('the other post')).not.toBeInTheDocument());
  });

  // The post is no longer banned once restored, so a kept post must not keep
  // the pane saying it is.
  it.each(Object.keys(paths) as Array<keyof typeof paths>)('%s after a Suspend: the kept post and the banned banner go', async (path) => {
    decisionFlags.isAutoHidden = path === 'Restore Content';
    await openBanned();
    fireEvent.click(screen.getByRole('button', { name: 'Suspend' }));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(screen.getByText(POST_TEXT)).toBeInTheDocument();
    await paths[path]();
    await waitFor(() => expect(screen.queryByText(BANNED_VIEW)).not.toBeInTheDocument());
    expect(screen.queryByText(POST_TEXT)).not.toBeInTheDocument();
  });

  // The live read works again once the author is unsuspended: the kept post
  // goes and the author's reads are read again. An unban can leave a running
  // suspension in place, so it does neither.
  it('Unsuspend: drops the kept post and reads the author\'s post again', async () => {
    await openBanned();
    fireEvent.click(screen.getByRole('button', { name: 'Suspend' }));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(relay.bannedReads).toBe(1);
    relay.banned = POST;
    fireEvent.click(screen.getByRole('button', { name: 'Unsuspend' }));
    await waitFor(() => expect(relay.bannedReads).toBe(2));
    expect(await screen.findByText(BANNED_VIEW)).toBeInTheDocument();
    // The live read (not the kept snapshot) is what shows: it can change.
    relay.banned = undefined;
    await act(async () => { await client.invalidateQueries({ queryKey: ['banned-event'] }); });
    await waitFor(() => expect(screen.queryByText(POST_TEXT)).not.toBeInTheDocument());
  });

  it('Unban: keeps the post and does not read again', async () => {
    await openBanned();
    fireEvent.click(screen.getByRole('button', { name: 'Suspend' }));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    fireEvent.click(screen.getByRole('button', { name: 'Unban' }));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
    expect(relay.bannedReads).toBe(1);
    expect(screen.getByText(POST_TEXT)).toBeInTheDocument();
  });

  // Only the suspended author's posts are tainted.
  it('does not taint a banned post by another author', async () => {
    await openBanned();
    const stranger: NostrEvent = { ...OTHER_POST, pubkey: '7'.repeat(64) };
    client.setQueryData(bannedEventQueryKey(API_URL, OTHER_ID), stranger);
    fireEvent.click(screen.getByRole('button', { name: 'Suspend' }));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
    expect(isBannedEventReadTainted(client, API_URL, OTHER_ID)).toBe(false);
    expect(isBannedEventReadTainted(client, API_URL, EVENT_ID)).toBe(true);
    expect(client.getQueryState(bannedEventQueryKey(API_URL, OTHER_ID))?.isInvalidated).toBe(false);
  });

  // The pane keeps only what it shows. A cached banned read behind a post the
  // thread shows is not on screen, and must not appear later as a kept post.
  it('keeps nothing when the pane was showing the thread\'s post, not a banned one', async () => {
    relay.post = POST;
    client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    client.setQueryData(bannedEventQueryKey(API_URL, EVENT_ID), POST);
    render(pane(REPORT));
    expect(await screen.findByText(POST_TEXT)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Suspend' }));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    // The thread read now misses the post (the relay withholds it).
    relay.post = undefined;
    await act(async () => { await client.invalidateQueries({ queryKey: ['thread'] }); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
    expect(screen.queryByText(POST_TEXT)).not.toBeInTheDocument();
  });

  // Only the suspended author's reads still out are cancelled, and re-read. A
  // refresh already running for another author's banned post (a restore's, say)
  // is left to finish: cancelled and never re-run, the pane would keep saying
  // the restored post is banned.
  it('a Suspend of another author leaves this post\'s refresh to finish', async () => {
    await openBanned();
    let release!: () => void;
    relay.hold = new Promise(resolve => { release = resolve; });
    fireEvent.click(screen.getByRole('button', { name: 'Restore Event' }));
    await waitFor(() => expect(relay.bannedReads).toBe(2));
    fireEvent.click(screen.getByRole('button', { name: 'Suspend other author' }));
    await act(async () => { release(); });
    await waitFor(() => expect(screen.queryByText(BANNED_VIEW)).not.toBeInTheDocument());
    expect(relay.bannedReads).toBe(2);
  });

  // A read still out at the Suspend started before it: it is cancelled, not
  // allowed to land with the post.
  it('cancels a banned-event read still out when the account is suspended', async () => {
    let release!: () => void;
    relay.hold = new Promise(resolve => { release = resolve; });
    relay.banned = POST;
    client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(pane(REPORT));
    await waitFor(() => expect(relay.bannedReads).toBe(1));
    relay.banned = undefined;
    fireEvent.click(screen.getByRole('button', { name: 'Suspend' }));
    await waitFor(() => expect(relay.bannedReads).toBe(2));
    await act(async () => { release(); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
    expect(screen.queryByText(POST_TEXT)).not.toBeInTheDocument();
  });

  // A Suspend that lands after the pane was closed and the report reopened runs
  // the closed pane's callback. It must not hold the post back from the refetch:
  // the closed pane keeps nothing, and the new pane would wait on "Checking".
  it('a Suspend finishing after the pane was closed and reopened still reads the post fresh', async () => {
    const { unmount } = await openBanned();
    const staleCompletion = completion.latest!;
    const closedTarget = completion.target;
    unmount();
    render(pane(REPORT));
    await waitFor(() => expect(screen.getByText(BANNED_VIEW)).toBeInTheDocument());
    act(() => { staleCompletion({ accountStatusChanged: true, action: 'suspend', pubkey: REPORTED_PUBKEY, reportTarget: closedTarget }); });
    await waitFor(() => expect(relay.bannedReads).toBe(2));
    await waitFor(() => expect(client.getQueryState(bannedEventQueryKey(API_URL, EVENT_ID))?.fetchStatus).toBe('idle'));
    expect(screen.queryByText(/Checking moderation status/)).not.toBeInTheDocument();
    expect(screen.queryByText(POST_TEXT)).not.toBeInTheDocument();
  });

  // The kept post must be the suspended account's. A report whose p tag names
  // someone else suspends that account, which keeps nothing of the real author.
  it('keeps nothing when the account suspended is not the post\'s author', async () => {
    await openBanned({ ...REPORT, tags: [['e', EVENT_ID], ['p', '6'.repeat(64)]] });
    fireEvent.click(screen.getByRole('button', { name: 'Suspend p-tag account' }));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    // The real author is suspended elsewhere: the read is refused, and the post goes.
    act(() => { suspendBannedEventReads(client, API_URL, REPORTED_PUBKEY); });
    await waitFor(() => expect(relay.bannedReads).toBe(2));
    await waitFor(() => expect(screen.queryByText(POST_TEXT)).not.toBeInTheDocument());
  });

  // The pane stays mounted across selections on the desktop layout, so a Suspend
  // pending while the moderator selects another post keeps nothing when it lands,
  // even if they came back to the same post: that is a new selection.
  it('a Suspend pending while another post is selected keeps nothing, without the pane unmounting', async () => {
    const { rerender } = await openBanned();
    fireEvent.click(screen.getByRole('button', { name: 'Start suspend' }));
    rerender(pane(REPORT_B));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
    rerender(pane(REPORT));
    await waitFor(() => expect(screen.getByText(BANNED_VIEW)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Finish suspend' }));
    await waitFor(() => expect(relay.bannedReads).toBeGreaterThan(1));
    await waitFor(() => expect(screen.queryByText(POST_TEXT)).not.toBeInTheDocument());
  });

  it('a Suspend finishing on the same continuously selected post keeps it, across reports on that post', async () => {
    const { rerender } = await openBanned();
    fireEvent.click(screen.getByRole('button', { name: 'Start suspend' }));
    rerender(pane({ ...REPORT, id: 'e1'.repeat(32) })); // another report, same post
    await waitFor(() => expect(screen.getByText(BANNED_VIEW)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Finish suspend' }));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
    expect(screen.getByText(POST_TEXT)).toBeInTheDocument();
  });

  // An unban that ended the suspension lets the live read work again, as an
  // Unsuspend does; one that left it running changes nothing.
  it('Unban that ended the suspension: drops the kept post and reads again', async () => {
    await openBanned();
    fireEvent.click(screen.getByRole('button', { name: 'Suspend' }));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(relay.bannedReads).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: 'Unban ending suspension' }));
    await waitFor(() => expect(relay.bannedReads).toBe(2));
    await waitFor(() => expect(screen.queryByText(POST_TEXT)).not.toBeInTheDocument());
  });

  // A Suspend by a host the pane does not hear from (the Users tab, age review)
  // taints the cached read without any state of this pane changing: the pane
  // hides the post at once, not after the refetch answers.
  it('hides an open pane\'s banned post at once when another host suspends the author', async () => {
    await openBanned();
    let release!: () => void;
    relay.hold = new Promise(resolve => { release = resolve; });
    act(() => { suspendBannedEventReads(client, API_URL, REPORTED_PUBKEY); });
    await waitFor(() => expect(relay.bannedReads).toBe(2));
    expect(screen.queryByText(POST_TEXT)).not.toBeInTheDocument();
    await act(async () => { release(); });
  });

  // A reopen straight after a post Ban must find the read stale: the mark is
  // made at once, not after the cancel of a read still out has settled.
  it('Ban Event: marks the banned-event read stale at once', async () => {
    await openBanned();
    fireEvent.click(screen.getByRole('button', { name: 'Ban Event' }));
    expect(client.getQueryState(bannedEventQueryKey(API_URL, EVENT_ID))?.isInvalidated).toBe(true);
  });

  // Each marking is scoped to this pane's environment.
  const otherEnvKey = bannedEventQueryKey(OTHER_API, EVENT_ID);
  it.each([
    ['Ban Event'],
    ['Delete All Content'],
    ['Bulk delete by kind'],
    ['Suspend'],
  ])('%s leaves another environment\'s banned-event read alone', async (button) => {
    await openBanned();
    client.setQueryData(otherEnvKey, POST);
    fireEvent.click(screen.getByRole('button', { name: button }));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
    expect(client.getQueryState(otherEnvKey)?.isInvalidated).toBe(false);
    expect(client.getQueryData(otherEnvKey)).toEqual(POST);
    expect(isBannedEventReadTainted(client, OTHER_API, EVENT_ID)).toBe(false);
  });
});
