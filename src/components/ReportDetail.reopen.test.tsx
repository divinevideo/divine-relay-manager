import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReportDetail } from './ReportDetail';
import type { NostrEvent } from '@nostrify/nostrify';
import { tokensFor, withAsModerator } from '@/test/adminApiMock';

// Reopen used to assert a queue state rather than report an outcome: it told
// the moderator the report was "back in the pending queue". Whether that was
// true depended on relay-side resolution labels the worker may have failed to
// clear, and on relay bans reopen never touches at all. These tests pin the
// replacement copy, and the degraded branch, at the hop where a moderator
// actually reads it.

const TARGET_EVENT = 'c'.repeat(64);
const REPORTED_PUBKEY = 'd'.repeat(64);
const MOD_PUBKEY = 'e'.repeat(64);
// A second report, for the case where the moderator moves on while the
// never-expiring degraded toast is still on screen.
const OTHER_EVENT = '9'.repeat(64);
const OTHER_PUBKEY = '8'.repeat(64);

// Which target the mocked context currently resolves to. Mutable because
// selecting another report RE-RENDERS ReportDetail rather than remounting it
// (ErrorBoundary resetKeys clear a caught error; they do not remount children),
// so the panel's hooks hand back a new target under the same component
// instance. A fixed mock cannot express that.
const ctx = vi.hoisted(() => ({ targetType: 'event' as 'event' | 'pubkey', targetValue: 'c'.repeat(64), reportedPubkey: 'd'.repeat(64) }));

const api = vi.hoisted(() => ({
  deleteEvent: vi.fn(),
  restoreEvent: vi.fn(),
  markAsReviewed: vi.fn(),
  logDecision: vi.fn(),
  confirmAutoHide: vi.fn(),
  deleteDecisions: vi.fn(),
  getDecisions: vi.fn(),
}));
const toast = vi.hoisted(() => vi.fn());

// The account-type label has its own tests; here it would need the account-status query.
vi.mock('@/components/AccountTypeBadge', () => ({ AccountTypeLabel: () => null }));
vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()),
  useNavigate: () => vi.fn(),
}));
const MOD_TOKEN = 'moderator-login-token';
// The live token, read at call time, so a test can switch accounts mid-action.
const session = vi.hoisted(() => ({ token: undefined as string | undefined }));
const moderatorApi = withAsModerator(api);
vi.mock('@/hooks/useAdminApi', () => ({ useAdminApi: () => moderatorApi }));
vi.mock('@/hooks/useToast', () => ({ useToast: () => ({ toast }) }));
vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ user: { pubkey: MOD_PUBKEY }, getModeratorToken: () => session.token }),
}));
vi.mock('@/hooks/useAppContext', () => ({
  useAppContext: () => ({ config: { relayUrl: 'wss://relay.example' } }),
}));

// The report has handling decisions (so Reopen renders) and is neither banned
// nor gone.
const decisionLog = vi.hoisted(() => ({
  hasDecisions: true,
  hasHandlingDecisions: true,
  isPendingReview: false,
  isDeleted: false,
  isAutoHidden: false,
  isAutoHideRestored: false,
  isAutoHideRestoreFailed: false,
  decisions: [],
  refetch: vi.fn(),
}));
// Set by a test that needs the real hook over api.getDecisions: whether Reopen
// shows after a reopen is the hook's reading of the rows, so a canned result
// would only restate the answer.
const realDecisionLog = vi.hoisted(() => ({ on: false }));
vi.mock('@/hooks/useDecisionLog', async (orig) => {
  const actual = await orig<typeof import('@/hooks/useDecisionLog')>();
  return {
    useDecisionLog: (targetId: string | null | undefined) =>
      realDecisionLog.on ? actual.useDecisionLog(targetId) : decisionLog,
  };
});
const modStatus = vi.hoisted(() => ({
  recheck: vi.fn(),
  recheckAfterAction: vi.fn(),
  isUserBanned: false as boolean | null,
}));
vi.mock('@/hooks/useModerationStatus', async () => {
  const { moderationStatusMock } = await import('@/test/moderationStatusMock');
  return { useModerationStatus: () => moderationStatusMock({ ...modStatus }) };
});
vi.mock('@/hooks/useBannedEvent', () => ({
  useBannedEvent: () => ({ data: null, isLoading: false }),
}));
vi.mock('@/hooks/useUserSummary', () => ({
  useUserSummary: () => ({ data: null, isLoading: false }),
}));
vi.mock('@/hooks/useMediaStatus', () => ({ useMediaStatus: () => ({ results: [] }) }));
// Shaped against the real hook's return (src/hooks/useReportContext.ts). A
// partial mock here silently drives the component into its "event not found"
// branch, which still renders Reopen -- so the tests would pass while
// exercising a degraded path rather than the normal one.
const TARGET_EVENT_OBJ: NostrEvent = {
  id: TARGET_EVENT,
  pubkey: REPORTED_PUBKEY,
  created_at: 1751000100,
  kind: 1,
  tags: [],
  content: 'reported content',
  sig: 'c'.repeat(128),
};
vi.mock('@/hooks/useReportContext', () => ({
  useReportContext: () => ({
    target: { type: ctx.targetType, value: ctx.targetValue },
    thread: { event: TARGET_EVENT_OBJ, ancestors: [], replies: [] },
    threadLoading: false,
    reportedUser: { profile: undefined, pubkey: ctx.reportedPubkey, isFunnelcakeUser: false },
    userStats: undefined,
    isLoading: false,
    error: null,
    relayHint: undefined,
    reportTags: REPORT.tags,
  }),
}));

// Heavy presentational children are irrelevant to the reopen decision and drag
// in relay sockets of their own.
vi.mock('@/components/ThreadContext', () => ({ ThreadContext: () => null }));
// Only its delete-a-recent-post hook is exercised here.
vi.mock('@/components/UserProfileCard', () => ({
  UserProfileCard: ({ onDeleteEvent }: { onDeleteEvent?: (eventId: string) => void }) => (
    onDeleteEvent ? <button onClick={() => onDeleteEvent('7'.repeat(64))}>Delete recent post</button> : null
  ),
}));
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
  tags: [['e', TARGET_EVENT], ['p', REPORTED_PUBKEY]],
  content: 'spam',
  sig: 'b'.repeat(128),
};

// What the queue hands the pane about the post's author (#432): whether the
// queue's author rule applies (its author, its exact match on the ban list),
// or null while the queue's ban list has not been read. Read by every render,
// so a test can change it and rerender. Known not banned unless a test says
// otherwise, as the queue says for most posts.
let authorBanned: boolean | null | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  authorBanned = false;
  session.token = MOD_TOKEN;
  ctx.targetValue = TARGET_EVENT;
  ctx.targetType = 'event';
  ctx.reportedPubkey = REPORTED_PUBKEY;
  modStatus.isUserBanned = false;
  decisionLog.isPendingReview = false;
  decisionLog.isAutoHideRestoreFailed = false;
  realDecisionLog.on = false;
  api.deleteDecisions.mockResolvedValue({ deleted: 1 });
  api.logDecision.mockResolvedValue(undefined);
});

function renderDetail(onDismiss?: () => void) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const invalidate = vi.spyOn(qc, 'invalidateQueries');
  const tree = () => (
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <ReportDetail report={REPORT} onDismiss={onDismiss} authorBanned={authorBanned} />
      </TooltipProvider>
    </QueryClientProvider>
  );
  const { rerender } = render(tree());
  // Same component instance, fresh props/hook results -- what selecting another
  // report does to this panel.
  return { qc, invalidate, rerender: () => rerender(tree()) };
}

const clickReopen = () => fireEvent.click(screen.getByRole('button', { name: /reopen/i }));

describe('ReportDetail recent-post delete', () => {
  it('the delete and its audit write carry the token taken at the click, even after an account switch mid-delete (#178)', async () => {
    let release!: () => void;
    api.deleteEvent.mockReturnValue(new Promise((resolve) => { release = () => resolve({ success: true }); }));
    renderDetail();

    fireEvent.click(screen.getByRole('button', { name: 'Delete recent post' }));
    await waitFor(() => expect(api.deleteEvent).toHaveBeenCalledWith('7'.repeat(64), 'Deleted from report review'));
    session.token = 'other-account-token';
    release();

    await waitFor(() => expect(api.logDecision).toHaveBeenCalledWith(expect.objectContaining({ action: 'delete_event' })));
    expect(tokensFor(moderatorApi, 'deleteEvent')).toEqual([MOD_TOKEN]);
    expect(tokensFor(moderatorApi, 'logDecision')).toEqual([MOD_TOKEN]);
  });
});

describe('ReportDetail recent-post delete undo', () => {
  // The undo is its own action, so it carries the login of whoever clicks it.
  it('the toast Undo restores with the token taken at the undo click (#178)', async () => {
    api.deleteEvent.mockResolvedValue({ success: true });
    api.restoreEvent.mockResolvedValue({ success: true, recorded: true, reconciled: true });
    renderDetail();

    fireEvent.click(screen.getByRole('button', { name: 'Delete recent post' }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Event deleted' })));
    const { action } = toast.mock.calls.find(([arg]) => arg.title === 'Event deleted')![0] as {
      action: React.ReactElement<{ onClick: () => Promise<void> }>;
    };
    session.token = 'undo-token';
    await act(async () => { await action.props.onClick(); });

    expect(api.restoreEvent).toHaveBeenCalledWith('7'.repeat(64), 'Deletion undone by moderator');
    expect(tokensFor(moderatorApi, 'restoreEvent')).toEqual(['undo-token']);
  });
});

describe('ReportDetail reopen reporting', () => {
  it('confirms an auto-hide without repeating the relay mutation', async () => {
    decisionLog.isPendingReview = true;
    api.confirmAutoHide.mockResolvedValue({ success: true, recorded: true });
    renderDetail();

    fireEvent.click(screen.getByRole('button', { name: 'Confirm Hide' }));

    await waitFor(() => expect(api.confirmAutoHide).toHaveBeenCalledWith(expect.objectContaining({
      eventId: ctx.targetValue,
    })));
    expect(api.confirmAutoHide.mock.calls[0][0]).not.toHaveProperty('moderatorPubkey');
    expect(tokensFor(moderatorApi, 'confirmAutoHide')).toEqual([MOD_TOKEN]);
    expect(api.logDecision).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'auto_hide_confirmed' }));
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Auto-hide confirmed' }));
  });

  it('restores an auto-hide without writing detached state', async () => {
    decisionLog.isPendingReview = true;
    api.restoreEvent.mockResolvedValue({ success: true, recorded: true, reconciled: true });
    renderDetail();

    fireEvent.click(screen.getByRole('button', { name: 'Restore Content' }));

    await waitFor(() => expect(api.restoreEvent).toHaveBeenCalledWith(
      ctx.targetValue,
      'Auto-hide reversed by moderator',
    ));
    expect(tokensFor(moderatorApi, 'restoreEvent')).toEqual([MOD_TOKEN]);
    expect(api.logDecision).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'auto_hide_restored' }));
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Content restored' }));
  });

  it('runs a plain check once an auto-hide restore lands, leaving the account status as it was', async () => {
    // A restore changes the post, not the account's ban or suspension, so the
    // account status on screen is not made pre-action by it.
    decisionLog.isPendingReview = true;
    api.restoreEvent.mockResolvedValue({ success: true, recorded: true, reconciled: true });
    renderDetail();

    fireEvent.click(screen.getByRole('button', { name: 'Restore Content' }));

    await waitFor(() => expect(modStatus.recheck).toHaveBeenCalledTimes(1));
    expect(modStatus.recheckAfterAction).not.toHaveBeenCalled();
  });

  it('offers only restore when automatic restore compensation failed', () => {
    decisionLog.isPendingReview = true;
    decisionLog.isAutoHideRestoreFailed = true;
    renderDetail();

    expect(screen.getByRole('button', { name: 'Restore Content' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirm Hide' })).not.toBeInTheDocument();
    expect(screen.getByText('Auto-Hidden — Restore Failed')).toBeInTheDocument();
  });

  it('keeps the report open and raises a persistent warning when dismissal reconciliation fails', async () => {
    api.markAsReviewed.mockResolvedValue({
      success: true,
      recorded: true,
      reconciled: false,
      error: 'restore failed',
    });
    const onDismiss = vi.fn();
    renderDetail(onDismiss);

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss Report' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Dismiss Report' }));

    await waitFor(() => expect(api.markAsReviewed).toHaveBeenCalledWith(
      'event',
      ctx.targetValue,
      'dismissed',
      'Dismissed - no action needed',
    ));
    expect(tokensFor(moderatorApi, 'markAsReviewed')).toEqual([MOD_TOKEN]);
    const warning = toast.mock.calls.find(([arg]) => arg.title === 'Resolution saved; visibility needs attention')?.[0];
    expect(warning).toMatchObject({ variant: 'destructive', duration: Infinity });
    expect(warning.description).toMatch(/could not be restored/i);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('keeps the report open when visibility changed but the human-review mark failed', async () => {
    api.markAsReviewed.mockResolvedValue({
      success: true,
      recorded: false,
      reconciled: true,
    });
    const onDismiss = vi.fn();
    renderDetail(onDismiss);

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss Report' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Dismiss Report' }));

    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Resolution saved; visibility needs attention',
      variant: 'destructive',
      duration: Infinity,
    })));
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('closes a successfully dismissed pubkey report', async () => {
    ctx.targetType = 'pubkey';
    ctx.targetValue = REPORTED_PUBKEY;
    api.markAsReviewed.mockResolvedValue({ success: true, recorded: true, reconciled: true });
    const onDismiss = vi.fn();
    renderDetail(onDismiss);

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss Report' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Dismiss Report' }));

    await waitFor(() => expect(onDismiss).toHaveBeenCalledOnce());
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Marked as false positive' }));
  });

  it('refreshes both report feeds when a report is resolved', async () => {
    api.markAsReviewed.mockResolvedValue({ success: true, recorded: true, reconciled: true });
    const { invalidate } = renderDetail(vi.fn());

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss Report' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Dismiss Report' }));

    // The target leaves the needs-attention feed and belongs in resolved
    // history. Without the history refresh it shows in neither view.
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['reports-resolved'] }));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['reports'] });
  });

  // Even a fully successful reopen does not promise the report is back in the
  // queue: the toast cannot see the screen's resolution sources. Report what
  // was actually done instead of asserting a queue state. Nor does it say a
  // relay ban keeps the report hidden: under the dated rule a reopen puts the
  // target in the decision log, so a ban the log dates no longer hides it.
  it('reports what a clean reopen did, without promising the report is back in the queue', async () => {
    renderDetail();
    clickReopen();

    await waitFor(() => expect(toast).toHaveBeenCalled());
    const arg = toast.mock.calls[0][0];
    expect(arg.variant).not.toBe('destructive');
    const text = `${arg.title} ${arg.description}`;
    expect(text).not.toMatch(/back in the pending queue/i);
    expect(text).toMatch(/reports filed before now count as new again/i);
    expect(text).not.toMatch(/relay ban|stays hidden/i);
    // Longer than Radix's 5s default can be read in.
    expect(arg.duration).toBeGreaterThan(5000);
  });

  // The queue reads the worker-side projection of the decision log (#273), not
  // the raw reads, so a reopen that does not refresh THAT key leaves the target
  // hidden for a poll cycle. Asserting the exact key is the point: an
  // invalidation of a key the queue no longer reads passes a looser check and
  // refreshes nothing. A reopen changes no labels (#324), so it does not
  // refresh them.
  it('invalidates the resolution state the queue filters on, and not the labels a reopen leaves alone', async () => {
    const { invalidate } = renderDetail();
    clickReopen();

    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['resolution-state'] });
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ['resolution-label-targets'] });
    // A reopen moves the target out of resolved history and back into the
    // needs-attention feed. Both are cached.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['reports'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['reports-resolved'] });
  });

  // decisionLog.refetch() refreshes only the read this panel is observing.
  // Other cached decision reads for the target -- the queue's deep-link
  // history pane (Reports.tsx), or this panel's own read from an earlier
  // selection of the same target -- keep the pre-reopen rows and would show
  // the target as handled the next time they mount. Asserted on the cache
  // entry, not the call's exact key, so narrowing the invalidation to this
  // target still passes.
  it('marks cached decision reads for the target stale, not only the one on screen', async () => {
    const { qc } = renderDetail();
    // Nothing in this panel observes this entry (useDecisionLog is mocked
    // here), as with a cached read whose component has unmounted.
    qc.setQueryData(['decisions', TARGET_EVENT], []);
    expect(qc.getQueryState(['decisions', TARGET_EVENT])?.isInvalidated).toBe(false);

    clickReopen();

    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(toast.mock.calls[0][0].variant).not.toBe('destructive');
    expect(qc.getQueryState(['decisions', TARGET_EVENT])?.isInvalidated).toBe(true);
  });

  // A failed call does not prove nothing was written: the reopen row can land
  // and the response still be lost. The panel may then be showing a handled
  // target the server reads as reopened, so an error toast alone leaves the
  // moderator looking at stale state.
  it('refreshes the cached decision state even when the reopen call fails', async () => {
    api.deleteDecisions.mockRejectedValueOnce(new Error('network error'));
    const { invalidate } = renderDetail();
    clickReopen();

    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(toast.mock.calls[0][0].variant).toBe('destructive');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['decisions'] });
    // The queue's projections drive whether the target is hidden, so they go
    // stale on such a failure exactly as the decision log does.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['resolution-state'] });
    // A reopen changes no labels, so a failed one does not refresh them either.
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ['resolution-label-targets'] });
    // A reopen moves the target out of resolved history and back into the
    // needs-attention feed. Both are cached.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['reports'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['reports-resolved'] });
  });

  // The tooltip makes the same promise the toast does, and is the copy a
  // moderator reads BEFORE deciding to reopen.
  it('does not promise the queue in the reopen tooltip either', async () => {
    renderDetail();
    fireEvent.focus(screen.getByRole('button', { name: /reopen/i }));

    const tip = await screen.findByRole('tooltip');
    expect(tip.textContent).not.toMatch(/back in the pending queue/i);
    expect(tip.textContent).toMatch(/reports filed before now count as new again/i);
    expect(tip.textContent).not.toMatch(/relay ban|stays hidden/i);
  });
});

// Reopen keeps the target's history (#324): the worker records a dated
// `reopened` row and only handling after it counts.
describe('ReportDetail reopen keeps history', () => {
  // A post's Reopen reopens only the post (#421). Each call writes a dated
  // `reopened` row (#324), so also reopening the author's account brought every
  // handled report on that account back to the queue when the moderator meant
  // one post. Why the post's own row is enough is in reopenMutation. The target
  // type is asserted too: it is easy to drop in a wrapper, and without it the
  // worker runs a label filter that cannot match.
  it("reopens only the post, not its author's account (#421)", async () => {
    renderDetail();
    clickReopen();

    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(api.deleteDecisions).toHaveBeenCalledTimes(1);
    expect(api.deleteDecisions).toHaveBeenCalledWith(TARGET_EVENT, 'event');
    // By id, whatever type it is sent with, so an untyped author call is caught too.
    expect(api.deleteDecisions.mock.calls.map(([id]) => id)).not.toContain(REPORTED_PUBKEY);
  });

  // The post-only reopen above depends on this. Once the queue applies the
  // author's relay ban, the ban answers the post's reports filed before it, and
  // the post's own reopen row cannot bring those back, so Reopen must not be
  // offered.
  it("does not offer Reopen on a post whose author the queue knows is banned", () => {
    authorBanned = true;
    renderDetail();

    expect(screen.queryByRole('button', { name: /reopen/i })).not.toBeInTheDocument();
  });

  // #432, whose post: the pane's own ban check reads the thread event's
  // author, the queue reads the report's p tag. When the p tag names a banned
  // account that is not the event's author, the queue keeps the report
  // handled, so a Reopen would "succeed" and bring nothing back.
  it("follows the queue's author, not the event's, when the queue applies a ban the pane's check does not see (#432)", () => {
    modStatus.isUserBanned = false;
    authorBanned = true;
    renderDetail();

    expect(screen.queryByRole('button', { name: /reopen/i })).not.toBeInTheDocument();
  });

  // #432, ban-list case: the pane's check ignores case, the relay and the
  // queue do not. An uppercase entry never banned the lowercase account, the
  // queue does not apply it, and a Reopen brings the report back, so Reopen is
  // offered though the pane's own check calls the author banned.
  it("offers Reopen when the queue does not apply a ban that the pane's check matched (#432)", () => {
    modStatus.isUserBanned = true;
    authorBanned = false;
    renderDetail();

    expect(screen.getByRole('button', { name: /reopen/i })).toBeInTheDocument();
  });

  // The accepted edge: while the queue's ban list has not been read, Reopen is
  // still offered (see reopenMutation).
  it("still offers Reopen while the queue has not read the ban list", () => {
    authorBanned = null;
    renderDetail();

    expect(screen.getByRole('button', { name: /reopen/i })).toBeInTheDocument();
  });

  // #432, message: Reopen in that window may run on a banned author's post,
  // whose earlier reports the ban keeps handled. The toast must not promise
  // they count as new again.
  it("does not promise earlier reports count as new again while the author's ban is unknown (#432)", async () => {
    authorBanned = null;
    renderDetail();
    clickReopen();

    await waitFor(() => expect(toast).toHaveBeenCalled());
    const arg = toast.mock.calls[0][0];
    expect(arg.variant).not.toBe('destructive');
    expect(arg.description).toMatch(/history is kept/i);
    expect(arg.description).toMatch(/unless the post's author is banned/i);
  });

  it("does not make that promise in the tooltip either while the author's ban is unknown (#432)", async () => {
    authorBanned = null;
    renderDetail();
    fireEvent.focus(screen.getByRole('button', { name: /reopen/i }));

    const tip = await screen.findByRole('tooltip');
    expect(tip.textContent).toMatch(/unless the post's author is banned/i);
  });

  // Once the queue knows the author is not banned, the promise holds as it is.
  it('makes the plain promise once the queue knows the author is not banned', async () => {
    authorBanned = false;
    renderDetail();
    clickReopen();

    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(toast.mock.calls[0][0].description).toBe(
      'Its history is kept, and reports filed before now count as new again.');
  });

  // The author rule is for posts, so an account report's promise never hangs
  // on it, whatever the queue says about its ban list.
  it("makes the plain promise on an account report while the queue has no ban list", async () => {
    ctx.targetType = 'pubkey';
    ctx.targetValue = REPORTED_PUBKEY;
    authorBanned = null;
    renderDetail();
    clickReopen();

    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(toast.mock.calls[0][0].description).toBe(
      'Its history is kept, and reports filed before now count as new again.');
  });

  // Omitted, the pane assumes nothing about the author's ban.
  it('qualifies the promise when the queue says nothing about the author', async () => {
    authorBanned = undefined;
    renderDetail();
    clickReopen();

    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(toast.mock.calls[0][0].description).toMatch(/unless the post's author is banned/i);
  });

  // The toast reports what was known at the click: a moderator who moves to
  // another report while the reopen is out must not get that report's copy.
  it('words the toast by what was known at the click, not after moving to another report (#432)', async () => {
    let release!: () => void;
    api.deleteDecisions.mockReturnValue(new Promise((resolve) => {
      release = () => resolve({ deleted: 1 });
    }));
    authorBanned = null;
    const { rerender } = renderDetail();
    clickReopen();
    await waitFor(() => expect(api.deleteDecisions).toHaveBeenCalled());

    ctx.targetValue = OTHER_EVENT;
    ctx.reportedPubkey = OTHER_PUBKEY;
    authorBanned = false;
    rerender();
    await act(async () => { release(); });

    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(toast.mock.calls[0][0].description).toMatch(/unless the post's author is banned/i);
  });

  // The queue's author rule is for posts. An account report still follows the
  // account's own ban, as before.
  it("does not offer Reopen on an account report whose account is banned", () => {
    ctx.targetType = 'pubkey';
    ctx.targetValue = REPORTED_PUBKEY;
    modStatus.isUserBanned = true;
    authorBanned = false;
    renderDetail();

    expect(screen.queryByRole('button', { name: /reopen/i })).not.toBeInTheDocument();
  });

  it("reopens an account report's account, once", async () => {
    ctx.targetType = 'pubkey';
    ctx.targetValue = REPORTED_PUBKEY;
    renderDetail();
    clickReopen();

    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(api.deleteDecisions).toHaveBeenCalledTimes(1);
    expect(api.deleteDecisions).toHaveBeenCalledWith(REPORTED_PUBKEY, 'pubkey');
  });

  it('says the history is kept rather than cleared', async () => {
    renderDetail();
    clickReopen();

    await waitFor(() => expect(toast).toHaveBeenCalled());
    const arg = toast.mock.calls[0][0];
    const text = `${arg.title} ${arg.description}`;
    expect(text).not.toMatch(/cleared/i);
    expect(text).toMatch(/history is kept/i);
  });

  it('says the history is kept in the tooltip too', async () => {
    renderDetail();
    fireEvent.focus(screen.getByRole('button', { name: /reopen/i }));

    const tip = await screen.findByRole('tooltip');
    expect(tip.textContent).not.toMatch(/clears/i);
    expect(tip.textContent).toMatch(/history is kept/i);
  });

  // The rows stay after a reopen, so the button has to go by what came after
  // the reopen, or it would offer to reopen a report that already is. Since
  // #421 a post's reopen leaves the author's account alone, so the author's
  // handling is still in force here; it must not bring the button back, since
  // it covers the post only while the author is banned.
  it("hides Reopen once the post is reopened with nothing handled since, while the author's own handling stands", async () => {
    realDecisionLog.on = true;
    api.getDecisions.mockImplementation(async (targetId: string) => targetId === TARGET_EVENT
      ? [
          { id: 3, action: 'reopened', moderator_pubkey: null, created_at: '2026-11-09 00:03:20' },
          { id: 1, action: 'delete_event', moderator_pubkey: MOD_PUBKEY, created_at: '2026-11-09 00:01:40' },
        ]
      : [
          { id: 2, action: 'reviewed', moderator_pubkey: MOD_PUBKEY, created_at: '2026-11-09 00:01:40' },
        ]);
    renderDetail();

    await waitFor(() => expect(api.getDecisions).toHaveBeenCalledWith(REPORTED_PUBKEY));
    // The history card renders once the reads land, so the button's absence is
    // read after the decisions arrived, not before.
    await screen.findByText(/\(2 actions\)/);
    expect(screen.queryByRole('button', { name: /reopen/i })).not.toBeInTheDocument();
    // Nor does the card call the target handled.
    expect(screen.queryByText(/Already Handled/)).not.toBeInTheDocument();
  });

  it('offers Reopen again once the target is handled after the reopen', async () => {
    realDecisionLog.on = true;
    api.getDecisions.mockImplementation(async (targetId: string) => targetId === TARGET_EVENT
      ? [
          { id: 5, action: 'reviewed', moderator_pubkey: MOD_PUBKEY, created_at: '2026-11-09 00:05:00' },
          { id: 3, action: 'reopened', moderator_pubkey: null, created_at: '2026-11-09 00:03:20' },
          { id: 1, action: 'delete_event', moderator_pubkey: MOD_PUBKEY, created_at: '2026-11-09 00:01:40' },
        ]
      : []);
    renderDetail();

    expect(await screen.findByRole('button', { name: /reopen/i })).toBeInTheDocument();
  });
});
