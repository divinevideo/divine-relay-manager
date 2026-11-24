// ABOUTME: After a Suspend, the open report keeps the banned post it shows, and no banned-event read cached
// ABOUTME: before it renders outside the audited viewer once the pane moves on (#445); re-bans mid-restore.

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { ReportDetail } from './ReportDetail';
import type { NostrEvent } from '@nostrify/nostrify';
import { moderationStatusMock } from '@/test/moderationStatusMock';
import { bannedEventQueryKey, isBannedEventReadTainted } from '@/lib/bannedEventKey';
import type { UserActionChange } from './UserActions';

const REPORTED_PUBKEY = 'd'.repeat(64);
const MOD_PUBKEY = 'e'.repeat(64);
const EVENT_ID = 'c'.repeat(64);
const OTHER_ID = '8'.repeat(64);
const OTHER_API = 'https://api.b.example';
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
      <button onClick={() => onActionComplete?.({ accountStatusChanged: true, action: 'suspend', pubkey: REPORTED_PUBKEY, reportTarget: { eventId: EVENT_ID } })}>Suspend</button>
      <button onClick={() => onActionComplete?.({ accountStatusChanged: true, action: 'suspend', pubkey: '7'.repeat(64), reportTarget: { eventId: OTHER_ID } })}>Suspend other author</button>
      <button onClick={() => onActionComplete?.({ accountStatusChanged: true, action: 'unsuspend', pubkey: REPORTED_PUBKEY, reportTarget: { eventId: EVENT_ID } })}>Unsuspend</button>
      <button onClick={() => onActionComplete?.({ accountStatusChanged: true, action: 'unban', pubkey: REPORTED_PUBKEY, reportTarget: { eventId: EVENT_ID } })}>Unban</button>
    </>
  ),
}));
// A recent post with a delete button, as UserProfileCard lists it.
vi.mock('@/components/UserProfileCard', () => ({
  UserProfileCard: ({ onDeleteEvent }: { onDeleteEvent?: (id: string) => void }) => (
    <>
      <button onClick={() => onDeleteEvent?.(EVENT_ID)}>Delete recent post</button>
    </>
  ),
}));
// The post actions, as EventActions reports them: a restore or a ban names the
// post, and either completes.
// Every render's target and media files, to see a render between a switch and
// the effect that runs after it.
const actionsRenders = vi.hoisted(() => ({ calls: [] as Array<{ eventId: string; media: string[] }> }));
vi.mock('@/components/EventActions', () => ({
  EventActions: ({ eventId, mediaHashes, onActionComplete, onEventRestored, onEventBanned }: {
    eventId: string; mediaHashes: string[]; onActionComplete?: () => void; onEventRestored?: (id: string) => void; onEventBanned?: (id: string) => void;
  }) => (actionsRenders.calls.push({ eventId, media: mediaHashes }), (
    <>
      <button onClick={() => { onEventRestored?.(eventId); onActionComplete?.(); }}>Restore Event</button>
      <button onClick={() => { onEventBanned?.(eventId); onActionComplete?.(); }}>Ban Event</button>
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
const POST: NostrEvent = { ...REPORT, id: EVENT_ID, pubkey: REPORTED_PUBKEY, kind: 1, tags: [], content: 'the reported post' };
const BANNED_VIEW = 'Event is banned on relay';

let client: QueryClient;
const OTHER_POST: NostrEvent = { ...POST, id: OTHER_ID, content: 'the other post' };
const REPORT_B: NostrEvent = { ...REPORT, id: '9'.repeat(64), tags: [['e', OTHER_ID], ['p', REPORTED_PUBKEY]] };
const POST_TEXT = 'the reported post';

const pane = (report: NostrEvent) => (
  <QueryClientProvider client={client}>
    <TooltipProvider><ReportDetail report={report} /></TooltipProvider>
  </QueryClientProvider>
);

describe('ReportDetail banned-post reads and a Suspend', () => {
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

  // Open on the banned post with the thread missing it; from now on the
  // worker refuses a fresh getbannedevent (a suspended author's), which the
  // hook reads as null.
  async function openBanned(report: NostrEvent = REPORT) {
    relay.banned = POST;
    client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const view = render(pane(report));
    expect(await screen.findByText(BANNED_VIEW)).toBeInTheDocument();
    relay.banned = undefined;
    return view;
  }

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
    // The mocked Suspend reports the first report (EVENT_ID) as its origin.
    fireEvent.click(screen.getByRole('button', { name: 'Suspend' }));
    await waitFor(() => expect(relay.bannedReads).toBe(2));
    await waitFor(() => expect(screen.queryByText('the other post')).not.toBeInTheDocument());
  });

  // The post is no longer banned once restored, so a kept post must not keep
  // the pane saying it is.
  const restores = {
    'Restore Event': async () => { fireEvent.click(screen.getByRole('button', { name: 'Restore Event' })); },
    'Undo delete': async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Delete recent post' }));
      await waitFor(() => expect(toasts.calls.some(t => t.action)).toBe(true));
      const undo = render(toasts.calls.find(t => t.action)!.action!);
      fireEvent.click(undo.getByText('Undo'));
    },
    'Restore Content': async () => { fireEvent.click(screen.getByRole('button', { name: /Restore Content/ })); },
  } as const;
  it.each(Object.keys(restores) as Array<keyof typeof restores>)('%s after a Suspend: the kept post and the banned banner go', async (path) => {
    decisionFlags.isAutoHidden = path === 'Restore Content';
    await openBanned();
    fireEvent.click(screen.getByRole('button', { name: 'Suspend' }));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(screen.getByText(POST_TEXT)).toBeInTheDocument();
    await restores[path]();
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
