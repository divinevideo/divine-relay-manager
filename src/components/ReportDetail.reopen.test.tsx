import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReportDetail } from './ReportDetail';
import type { NostrEvent } from '@nostrify/nostrify';

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
}));
const toast = vi.hoisted(() => vi.fn());

vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()),
  useNavigate: () => vi.fn(),
}));
vi.mock('@/hooks/useAdminApi', () => ({ useAdminApi: () => api }));
vi.mock('@/hooks/useToast', () => ({ useToast: () => ({ toast }) }));
vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ user: { pubkey: MOD_PUBKEY }, getModeratorPubkey: async () => MOD_PUBKEY }),
}));
vi.mock('@/hooks/useAppContext', () => ({
  useAppContext: () => ({ config: { relayUrl: 'wss://relay.example' } }),
}));

// The report has decisions (so Reopen renders) and is neither banned nor gone.
const decisionLog = vi.hoisted(() => ({
  hasDecisions: true,
  isPendingReview: false,
  isDeleted: false,
  isAutoHidden: false,
  isAutoHideRestored: false,
  decisions: [],
  latestDecision: null,
  refetch: vi.fn(),
}));
vi.mock('@/hooks/useDecisionLog', () => ({ useDecisionLog: () => decisionLog }));
vi.mock('@/hooks/useModerationStatus', () => ({
  useModerationStatus: () => ({ isUserBanned: false, isEventGone: false }),
}));
vi.mock('@/hooks/useBannedEvent', () => ({
  useBannedEvent: () => ({ data: null, isLoading: false }),
}));
vi.mock('@/hooks/useUserSummary', () => ({
  useUserSummary: () => ({ data: null, isLoading: false }),
}));
vi.mock('@/hooks/useMediaStatus', () => ({ useMediaStatus: () => ({}) }));
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
    reporter: { profile: undefined, pubkey: 'a'.repeat(64), reportCount: 0, isFunnelcakeUser: false },
    isLoading: false,
    error: null,
    relayHint: undefined,
    reportTags: REPORT.tags,
  }),
}));

// Heavy presentational children are irrelevant to the reopen decision and drag
// in relay sockets of their own.
vi.mock('@/components/ThreadContext', () => ({ ThreadContext: () => null }));
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
  tags: [['e', TARGET_EVENT], ['p', REPORTED_PUBKEY]],
  content: 'spam',
  sig: 'b'.repeat(128),
};

beforeEach(() => {
  vi.clearAllMocks();
  ctx.targetValue = TARGET_EVENT;
  ctx.targetType = 'event';
  ctx.reportedPubkey = REPORTED_PUBKEY;
  decisionLog.isPendingReview = false;
  api.deleteDecisions.mockResolvedValue({ deleted: 2, labelCleanupFailed: false });
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
        <ReportDetail report={REPORT} onDismiss={onDismiss} />
      </TooltipProvider>
    </QueryClientProvider>
  );
  const { rerender } = render(tree());
  // Same component instance, fresh props/hook results -- what selecting another
  // report does to this panel.
  return { invalidate, rerender: () => rerender(tree()) };
}

const clickReopen = () => fireEvent.click(screen.getByRole('button', { name: /reopen/i }));

describe('ReportDetail reopen reporting', () => {
  it('confirms an auto-hide without repeating the relay mutation', async () => {
    decisionLog.isPendingReview = true;
    api.confirmAutoHide.mockResolvedValue({ success: true, recorded: true });
    renderDetail();

    fireEvent.click(screen.getByRole('button', { name: 'Confirm Hide' }));

    await waitFor(() => expect(api.confirmAutoHide).toHaveBeenCalledWith(expect.objectContaining({
      eventId: ctx.targetValue,
    })));
    expect(api.logDecision).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'auto_hide_confirmed' }));
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Auto-hide confirmed' }));
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

    await waitFor(() => expect(api.markAsReviewed).toHaveBeenCalled());
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

  // Even a fully successful reopen cannot promise the report is back in the
  // queue: resolvedTargets also hides targets via relay bans and deletions,
  // which reopen never touches, so a ban-resolved report stays hidden. Report
  // what was actually done instead of asserting a queue state.
  it('reports what a clean reopen did, without promising the report is back in the queue', async () => {
    renderDetail();
    clickReopen();

    await waitFor(() => expect(toast).toHaveBeenCalled());
    const arg = toast.mock.calls[0][0];
    expect(arg.variant).not.toBe('destructive');
    const text = `${arg.title} ${arg.description}`;
    expect(text).not.toMatch(/back in the pending queue/i);
    // The tooltip carries the ban/deletion caveat, but it is read before the
    // click. The toast is what a moderator sees after it, so it carries the
    // caveat too rather than reading as an unqualified success.
    expect(text).toMatch(/stays hidden until that is lifted/i);
    // Which makes it too long for Radix's 5s default to be read in.
    expect(arg.duration).toBeGreaterThan(5000);
  });

  // The label survived, so resolvedTargets still hides the target and the
  // report does NOT come back. Claiming it did is the exact failure this flag
  // exists to prevent.
  it('warns that the report may stay hidden when label cleanup failed', async () => {
    api.deleteDecisions.mockResolvedValue({ deleted: 2, labelCleanupFailed: true });
    renderDetail();
    clickReopen();

    await waitFor(() => expect(toast).toHaveBeenCalled());
    const arg = toast.mock.calls[0][0];
    expect(arg.variant).toBe('destructive');
    const text = `${arg.title} ${arg.description}`;
    expect(text).toMatch(/may stay hidden/i);
    // One of the three causes is our own page cap, where the relay did exactly
    // what it was asked. Naming the relay as the culprit would send a moderator
    // chasing a relay problem that is not there.
    expect(text).not.toMatch(/the relay did not/i);
    // The decisions ARE deleted on this path, so hasDecisions goes false and
    // the Reopen button unmounts. Telling a moderator to retry without giving
    // them the means is a dead end, so the retry rides on the toast -- and it
    // must not expire on a timer, since nothing else can reach this action
    // afterwards. Single-use even so: ToastAction is a ToastClose, so the click
    // that fires the retry also dismisses the toast, and only a retry that
    // comes back still-degraded raises a replacement. These tests render the
    // action outside a ToastProvider, so that dismissal does not run here.
    expect(arg.action).toBeDefined();
    expect(arg.duration).toBe(Infinity);
  });

  it('offers a working retry from the degraded toast, since the button is gone', async () => {
    api.deleteDecisions.mockResolvedValue({ deleted: 2, labelCleanupFailed: true });
    renderDetail();
    clickReopen();

    await waitFor(() => expect(toast).toHaveBeenCalled());
    const callsBefore = api.deleteDecisions.mock.calls.length;

    // Render the toast's action in isolation and click it: it must re-run the
    // reopen rather than merely dismiss. Scoped to its own container, since the
    // panel behind it already has buttons of its own.
    const { container } = render(toast.mock.calls[0][0].action);
    fireEvent.click(within(container).getByRole('button'));

    await waitFor(() =>
      expect(api.deleteDecisions.mock.calls.length).toBeGreaterThan(callsBefore)
    );
  });

  // The degraded toast never expires and TOAST_LIMIT is 1, so it is still on
  // screen after the moderator moves to another report. mutate() rebuilds the
  // mutation from the observer's LATEST options, so a mutationFn that read the
  // target off `context` instead of off its own variables would send this retry
  // at the report now selected -- deleting the decisions of a report nobody
  // asked to reopen, and then reporting it as a clean reopen.
  it('retries the target it was raised for, not the report selected afterwards', async () => {
    api.deleteDecisions.mockResolvedValue({ deleted: 2, labelCleanupFailed: true });
    const { rerender } = renderDetail();
    clickReopen();

    await waitFor(() => expect(toast).toHaveBeenCalled());
    const action = toast.mock.calls[0][0].action;

    ctx.targetValue = OTHER_EVENT;
    ctx.reportedPubkey = OTHER_PUBKEY;
    rerender();
    api.deleteDecisions.mockClear();

    const { container } = render(action);
    fireEvent.click(within(container).getByRole('button'));

    await waitFor(() => expect(api.deleteDecisions).toHaveBeenCalled());
    expect(api.deleteDecisions).toHaveBeenNthCalledWith(1, TARGET_EVENT, 'event');
    expect(api.deleteDecisions).toHaveBeenNthCalledWith(2, REPORTED_PUBKEY, 'pubkey');
    expect(api.deleteDecisions).not.toHaveBeenCalledWith(OTHER_EVENT, 'event');
    expect(api.deleteDecisions).not.toHaveBeenCalledWith(OTHER_PUBKEY, 'pubkey');
  });

  // The other half of the same OR. With only the pubkey-side case below,
  // returning `secondary.labelCleanupFailed` alone passes the whole suite --
  // and then a failed cleanup on the event target reports a clean reopen,
  // which is every pubkey-target report too, since those never make a second
  // call for `secondary` to be assigned from.
  it('reports incomplete cleanup when only the event target failed', async () => {
    api.deleteDecisions
      .mockResolvedValueOnce({ deleted: 1, labelCleanupFailed: true })
      .mockResolvedValueOnce({ deleted: 1, labelCleanupFailed: false });
    renderDetail();
    clickReopen();

    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(toast.mock.calls[0][0].variant).toBe('destructive');
  });

  // An event report reopens two targets. A failure on the second must not be
  // masked by a clean first result.
  it('reports incomplete cleanup when only the pubkey target failed', async () => {
    api.deleteDecisions
      .mockResolvedValueOnce({ deleted: 1, labelCleanupFailed: false })
      .mockResolvedValueOnce({ deleted: 1, labelCleanupFailed: true });
    renderDetail();
    clickReopen();

    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(toast.mock.calls[0][0].variant).toBe('destructive');
  });

  // resolvedTargets is built from the resolution-label query, so a reopen that
  // does not refresh it leaves the target hidden for a poll cycle even when the
  // cleanup fully succeeded.
  it('invalidates the resolution-label cache the queue filters on', async () => {
    const { invalidate } = renderDetail();
    clickReopen();

    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['resolution-labels'] });
  });

  // The two deleteDecisions calls are sequential and the first commits
  // server-side before the second runs. When the second throws, the panel is
  // showing decisions the server no longer has, so an error toast alone leaves
  // the moderator looking at stale state.
  it('refreshes the cached decision state even when the reopen fails part-way', async () => {
    api.deleteDecisions
      .mockResolvedValueOnce({ deleted: 1, labelCleanupFailed: false })
      .mockRejectedValueOnce(new Error('worker 500'));
    const { invalidate } = renderDetail();
    clickReopen();

    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(toast.mock.calls[0][0].variant).toBe('destructive');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['decisions'] });
    // The labels drive whether the target is hidden, so they go stale on a
    // part-way failure exactly as the decisions do.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['resolution-labels'] });
  });

  // Each target's type is known here, so the worker never has to run the label
  // filter that cannot match it. Passing it is easy to drop silently in a
  // wrapper, so it is asserted at the call the component actually makes.
  it('names each target type so neither cleanup runs a dead filter', async () => {
    renderDetail();
    clickReopen();

    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(api.deleteDecisions).toHaveBeenNthCalledWith(1, TARGET_EVENT, 'event');
    expect(api.deleteDecisions).toHaveBeenNthCalledWith(2, REPORTED_PUBKEY, 'pubkey');
  });

  // The tooltip makes the same promise the toast does, and is the copy a
  // moderator reads BEFORE deciding to reopen.
  it('does not promise the queue in the reopen tooltip either', async () => {
    renderDetail();
    fireEvent.focus(screen.getByRole('button', { name: /reopen/i }));

    const tip = await screen.findByRole('tooltip');
    expect(tip.textContent).not.toMatch(/back in the pending queue/i);
    expect(tip.textContent).toMatch(/stays hidden until that is lifted/i);
  });
});
