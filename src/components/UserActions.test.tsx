import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UserActions } from './UserActions';
import { ApiError, BanNotConfirmedError } from '@/lib/adminApi';
import { banFailureToast, banSuccessNote } from '@/lib/banFeedback';
import { tokensFor, withAsModerator } from '@/test/adminApiMock';
import { markRestored, RESTORE_SETTLE_MS, useJustRestored } from '@/lib/userStatsCache';
import { bannedEventQueryKey, isBannedEventReadTainted } from '@/lib/bannedEventKey';
import type { NostrEvent } from '@nostrify/nostrify';
import { AppContext, type AppContextType } from '@/contexts/AppContext';
import { TIMED_SUSPENSIONS_KEY } from '@/hooks/useTimedSuspensions';
import { formatSuspensionEnd } from '../../shared/suspension';

// Stable mocks so async-flow tests can control enqueue + status polling and
// assert on the same fn instances.
const api = vi.hoisted(() => ({
  bulkModerate: vi.fn(),
  getBulkJobStatus: vi.fn(),
  getBulkJobNotes: vi.fn(),
  moderateMedia: vi.fn(),
  banPubkey: vi.fn(),
  unbanPubkey: vi.fn(),
  suspendPubkey: vi.fn(),
  unsuspendPubkey: vi.fn(),
  changeSuspensionEnd: vi.fn(),
  listTimedSuspensions: vi.fn(),
  getActiveAgeReviewCase: vi.fn(),
  logDecision: vi.fn(),
}));
const toast = vi.hoisted(() => vi.fn());

const navigate = vi.hoisted(() => vi.fn());
vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()),
  useNavigate: () => navigate,
}));

const moderatorApi = withAsModerator(api);
// useApiUrl: the timed-suspensions read keys its cache by environment.
vi.mock('@/hooks/useAdminApi', () => ({ useAdminApi: () => moderatorApi, useApiUrl: () => 'https://api.test' }));
vi.mock('@/hooks/useToast', () => ({ useToast: () => ({ toast }) }));
// Logged-in moderator, so actions carry attribution (#178). The live token is
// read at call time, so a test can switch accounts mid-action.
const MOD_PUBKEY = 'e'.repeat(64);
const MOD_TOKEN = 'moderator-login-token';
const session = vi.hoisted(() => ({ token: undefined as string | undefined }));
vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ user: { pubkey: MOD_PUBKEY }, getModeratorToken: () => session.token }),
}));

const PUBKEY = 'a'.repeat(64);

// A minute-aligned end three days from now. A real-clock literal would turn
// into "End time passed" once that date went by (F2).
function threeDaysOut(): string {
  return new Date(Math.ceil((Date.now() + 3 * 86_400_000) / 60_000) * 60_000).toISOString();
}

// Suspend opens a dialog for the length; these fill it in and confirm. The
// dialog is open while the action runs, so the page behind it is aria-hidden.
function confirmSuspendDialog(length: string | null = '3', unit: 'days' | 'hours' = 'days') {
  const dialog = screen.getByRole('dialog');
  if (length === null) {
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'No end date' }));
  } else {
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Unit' }), { target: { value: unit } });
    fireEvent.change(within(dialog).getByLabelText('Length'), { target: { value: length } });
  }
  fireEvent.click(within(dialog).getByRole('button', { name: 'Suspend' }));
}
function suspendThroughDialog(length: string | null = '3', unit: 'days' | 'hours' = 'days') {
  fireEvent.click(screen.getByRole('button', { name: /^Suspend User/i }));
  confirmSuspendDialog(length, unit);
}

function doneJob(action: 'age-gate-all' | 'delete-all', over: Partial<Record<string, unknown>> = {}) {
  return {
    jobId: 'job-1', pubkey: PUBKEY, action, status: 'done',
    eventsProcessed: 3, mediaProcessed: 2, failures: [], createdAt: 't', updatedAt: 't', ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  session.token = MOD_TOKEN;
  api.bulkModerate.mockResolvedValue({ success: true, jobId: 'job-1' });
  api.getBulkJobStatus.mockResolvedValue(doneJob('age-gate-all'));
  api.getBulkJobNotes.mockResolvedValue({ notes: [], next: null });
  api.moderateMedia.mockResolvedValue({ success: true });
  api.banPubkey.mockResolvedValue({ unconfirmed: null });
  // An unban answers with what became of a timed suspension; 'none' is a worker
  // that reported none (the account had no timer, or the worker predates them).
  api.unbanPubkey.mockResolvedValue({ suspension: { state: 'none' } });
  api.suspendPubkey.mockResolvedValue({ endsAt: threeDaysOut(), recorded: true, decisionRecorded: true });
  api.unsuspendPubkey.mockResolvedValue({ success: true });
  api.changeSuspensionEnd.mockResolvedValue({ endsAt: threeDaysOut(), decisionRecorded: true });
  api.listTimedSuspensions.mockResolvedValue({ suspensions: [], autoLift: true });
  api.getActiveAgeReviewCase.mockResolvedValue({ success: true, case: null });
  api.logDecision.mockResolvedValue(undefined);
});

function renderWithProvider(ui: React.ReactElement, qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })) {
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>{ui}</TooltipProvider>
    </QueryClientProvider>
  );
}

describe('UserActions', () => {
  it('renders suspend, ban, bulk age-restrict, and bulk delete for active user', () => {
    renderWithProvider(<UserActions pubkey={PUBKEY} />);
    expect(screen.getByRole('button', { name: /Suspend User/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Ban User/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Age Restrict All/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Delete All Content/i })).toBeInTheDocument();
  });

  it('shows the Age Review hand-off (not Suspend) for an NS-underageUser report', () => {
    renderWithProvider(<UserActions pubkey={PUBKEY} context="report" reportCategory="NS-underageUser" />);
    expect(screen.getByRole('button', { name: /Handle in Age Review/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Suspend User/i })).not.toBeInTheDocument();
    // Ban stays available as the severe-action escape hatch.
    expect(screen.getByRole('button', { name: /Ban User/i })).toBeInTheDocument();
  });

  it('hides the bulk content actions for an NS-underageUser report (enforcement runs through the case)', () => {
    renderWithProvider(<UserActions pubkey={PUBKEY} context="report" reportCategory="NS-underageUser" />);
    expect(screen.queryByRole('button', { name: /Age Restrict All/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Delete All Content/i })).not.toBeInTheDocument();
    // The hand-off and the Ban escape hatch remain.
    expect(screen.getByRole('button', { name: /Handle in Age Review/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Ban User/i })).toBeInTheDocument();
  });

  it('keeps the bulk content actions for a non-underage report', () => {
    renderWithProvider(<UserActions pubkey={PUBKEY} context="report" reportCategory="NS-spam" />);
    expect(screen.getByRole('button', { name: /Age Restrict All/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Delete All Content/i })).toBeInTheDocument();
  });

  it('Age Restrict All age-gates the account (age-gate-all), not the age-review withhold (#290)', async () => {
    renderWithProvider(<UserActions pubkey={PUBKEY} />);
    fireEvent.click(screen.getByRole('button', { name: /Age Restrict All/i }));
    await waitFor(() => expect(api.bulkModerate).toHaveBeenCalled());
    expect(api.bulkModerate).toHaveBeenCalledWith(PUBKEY, 'age-gate-all', expect.any(String));
  });

  it('Age Restrict All tooltip names the 18+ gate and the per-video undo (#290)', async () => {
    // The old "Age-restrict ... Can be reversed." was vague enough to hide the
    // hide-vs-gate mix-up, and promised an undo-all that does not exist.
    renderWithProvider(<UserActions pubkey={PUBKEY} />);
    fireEvent.focus(screen.getByRole('button', { name: /Age Restrict All/i }));
    const tips = await screen.findAllByText(
      "Put all of this user's videos behind the 18+ gate. Undo one video at a time with Remove Restriction.",
    );
    expect(tips.length).toBeGreaterThan(0);
  });

  it('routes to Age Review when a bulk action is guard-blocked (age_review_active)', async () => {
    api.bulkModerate.mockRejectedValue(new ApiError('under age review', 409, 'Conflict', 'age_review_active'));
    renderWithProvider(<UserActions pubkey={PUBKEY} />);
    fireEvent.click(screen.getByRole('button', { name: /Age Restrict All/i }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(`/age-review?pubkey=${PUBKEY}`));
    // Routed, not surfaced as a failure.
    expect(toast).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Bulk action failed' }),
    );
  });

  it('shows "try again" and stays put when the age-review check could not run (503)', async () => {
    // No case to route to: the worker could not look one up, so the moderator
    // gets the server's actionable message instead of a hand-off (#290).
    const message = 'Could not check age-review status. Try again.';
    api.bulkModerate.mockRejectedValue(new ApiError(message, 503, 'Service Unavailable', 'age_review_check_failed'));
    renderWithProvider(<UserActions pubkey={PUBKEY} />);
    fireEvent.click(screen.getByRole('button', { name: /Age Restrict All/i }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Bulk action failed', description: message, variant: 'destructive' }),
    ));
    expect(navigate).not.toHaveBeenCalled();
  });

  it('routes a guard-blocked Delete All (confirm-dialog path) to Age Review too', async () => {
    // Same enqueue.onError as the direct path, but through ConfirmDialog's
    // startAsync: the rejection must not surface as a failure or crash the
    // dialog — the moderator lands on the case.
    api.bulkModerate.mockRejectedValue(new ApiError('under age review', 409, 'Conflict', 'age_review_active'));
    renderWithProvider(<UserActions pubkey={PUBKEY} />);
    fireEvent.click(screen.getByRole('button', { name: /Delete All Content/i }));
    const dialog = screen.getByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm Delete' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(`/age-review?pubkey=${PUBKEY}`));
    expect(toast).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Bulk action failed' }),
    );
  });

  it('navigates to the age-review flow when the hand-off is clicked', () => {
    renderWithProvider(<UserActions pubkey={PUBKEY} context="report" reportCategory="NS-underageUser" />);
    fireEvent.click(screen.getByRole('button', { name: /Handle in Age Review/i }));
    expect(navigate).toHaveBeenCalledWith(`/age-review?pubkey=${PUBKEY}`);
  });

  it('keeps the generic Suspend for a non-underage report', () => {
    renderWithProvider(<UserActions pubkey={PUBKEY} context="report" reportCategory="NS-spam" />);
    expect(screen.getByRole('button', { name: /Suspend User/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Handle in Age Review/i })).not.toBeInTheDocument();
  });

  it('routes to Age Review when a bare suspend is guard-blocked (age_review_active)', async () => {
    api.suspendPubkey.mockRejectedValue(new ApiError('under age review', 409, 'Conflict', 'age_review_active'));
    renderWithProvider(<UserActions pubkey={PUBKEY} />);
    suspendThroughDialog();
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(`/age-review?pubkey=${PUBKEY}`));
  });

  it('routes to Age Review when an unban is guard-blocked (age_review_active)', async () => {
    // Unban lifts the Keycast hold as well as the ban, so the worker refuses it on
    // an open case. Without this the moderator gets a raw destructive toast rather
    // than the case, which is the drift this pattern exists to prevent.
    api.unbanPubkey.mockRejectedValue(new ApiError('under age review', 409, 'Conflict', 'age_review_active'));
    renderWithProvider(<UserActions pubkey={PUBKEY} isBanned />);
    fireEvent.click(screen.getByRole('button', { name: /Unban User/i }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(`/age-review?pubkey=${PUBKEY}`));
  });

  it('routes to Age Review when an unsuspend is guard-blocked (age_review_active)', async () => {
    // The other reversal, and the last unpinned redirect in this file. Suspend
    // and unban are covered above; without this one, deleting the unsuspend
    // redirect leaves the whole suite green.
    api.unsuspendPubkey.mockRejectedValue(new ApiError('under age review', 409, 'Conflict', 'age_review_active'));
    renderWithProvider(<UserActions pubkey={PUBKEY} isSuspended />);
    fireEvent.click(screen.getByRole('button', { name: /Unsuspend User/i }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(`/age-review?pubkey=${PUBKEY}`));
  });

  it.each([
    { action: 'unsuspend_user', call: 'unsuspendPubkey', props: { isSuspended: true }, button: /Unsuspend User/i, confirm: false },
    { action: 'ban_user', call: 'banPubkey', props: {}, button: /Ban User/i, confirm: true },
    { action: 'unban_user', call: 'unbanPubkey', props: { isBanned: true }, button: /Unban User/i, confirm: false },
  ] as const)('sends $call and its audit write through asModerator(token) (#178)', async ({ action, call, props, button, confirm }) => {
    renderWithProvider(<UserActions pubkey={PUBKEY} {...props} />);
    fireEvent.click(screen.getByRole('button', { name: button }));
    if (confirm) fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Ban User' }));
    await waitFor(() => expect(api[call]).toHaveBeenCalled());
    await waitFor(() =>
      expect(api.logDecision).toHaveBeenCalledWith(expect.objectContaining({ action })),
    );
    expect(tokensFor(moderatorApi, call)).toEqual([MOD_TOKEN]);
    expect(tokensFor(moderatorApi, 'logDecision')).toEqual([MOD_TOKEN]);
  });

  // The worker writes the suspend's decision row itself now (it knows the end
  // date), so the browser writes none: a second row would double the history.
  it('sends suspendPubkey through asModerator(token) and writes no suspend_user row of its own (#178)', async () => {
    renderWithProvider(<UserActions pubkey={PUBKEY} />);
    suspendThroughDialog();
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: expect.stringMatching(/^User suspended/) })));
    expect(tokensFor(moderatorApi, 'suspendPubkey')).toEqual([MOD_TOKEN]);
    expect(api.logDecision).not.toHaveBeenCalled();
  });

  it('a bulk job and its completion audit carry the token taken at the click, not one switched in mid-job (#178)', async () => {
    api.getBulkJobStatus.mockResolvedValue(doneJob('age-gate-all'));
    renderWithProvider(<UserActions pubkey={PUBKEY} />);

    fireEvent.click(screen.getByRole('button', { name: /Age Restrict All/i }));
    session.token = 'other-account-token';

    await waitFor(() =>
      expect(api.logDecision).toHaveBeenCalledWith(expect.objectContaining({ action: 'bulk_age_restrict' })),
    );
    expect(tokensFor(moderatorApi, 'bulkModerate')).toEqual([MOD_TOKEN]);
    expect(tokensFor(moderatorApi, 'logDecision')).toEqual([MOD_TOKEN]);
  });

  // ReportDetail keeps this component mounted when the moderator opens another
  // report, so the pubkey prop can change while an action is in flight. The
  // completion must name the account the action was taken on, not the one on
  // screen when it finished.
  it.each([
    { action: 'suspend', props: {}, button: /Suspend User/i, call: api.suspendPubkey },
    { action: 'unsuspend', props: { isSuspended: true }, button: /Unsuspend User/i, call: api.unsuspendPubkey },
    { action: 'ban', props: {}, button: /Ban User/i, call: api.banPubkey },
    { action: 'unban', props: { isBanned: true }, button: /Unban User/i, call: api.unbanPubkey },
  ] as const)('reports the original account and post when a $action finishes after switching reports', async ({ action, props, button, call }) => {
    const OTHER = 'b'.repeat(64);
    const original = { eventId: 'c'.repeat(64) };
    const next = { ...original, eventId: 'd'.repeat(64) };
    let finish!: (value: unknown) => void;
    call.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const onActionComplete = vi.fn();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const ui = (pubkey: string, reportTarget: typeof original) => (
      <QueryClientProvider client={qc}>
        <TooltipProvider>
          <UserActions pubkey={pubkey} {...props} reportTarget={reportTarget} onActionComplete={onActionComplete} />
        </TooltipProvider>
      </QueryClientProvider>
    );
    const { rerender } = render(ui(PUBKEY, original));

    fireEvent.click(screen.getByRole('button', { name: button }));
    if (action === 'ban') {
      const dialog = await screen.findByRole('alertdialog');
      fireEvent.click(within(dialog).getByRole('button', { name: 'Ban User' }));
    }
    if (action === 'suspend') confirmSuspendDialog();
    const args = {
      suspend: [expect.any(String), { value: 3, unit: 'days' }],
      ban: [expect.any(String)],
      unsuspend: [],
      unban: [],
    }[action];
    await waitFor(() => expect(call).toHaveBeenCalledWith(PUBKEY, ...args));

    rerender(ui(OTHER, next));
    finish(action === 'ban' ? { unconfirmed: null }
      : action === 'suspend' ? { endsAt: threeDaysOut(), recorded: true, decisionRecorded: true }
      : action === 'unban' ? { suspension: { state: 'none' } }
      : { success: true });

    await waitFor(() => expect(onActionComplete).toHaveBeenCalledTimes(1));
    expect(onActionComplete).toHaveBeenCalledWith({ accountStatusChanged: true, pubkey: PUBKEY, action, reportTarget: original });
    // The decision log names the acted-on account too. A suspend writes no
    // row from the browser: the worker records it for the account it was sent.
    if (action !== 'suspend') {
      await waitFor(() => expect(api.logDecision).toHaveBeenCalledWith(expect.objectContaining({ targetId: PUBKEY })));
    }
    expect(api.logDecision).not.toHaveBeenCalledWith(expect.objectContaining({ targetId: OTHER }));
  });

  // A refusal because the account is under age review routes to that account's
  // case. After a switch mid-action it must still be the acted-on account.
  it.each([
    { action: 'suspend', props: {}, button: /Suspend User/i, call: api.suspendPubkey },
    { action: 'unsuspend', props: { isSuspended: true }, button: /Unsuspend User/i, call: api.unsuspendPubkey },
    { action: 'unban', props: { isBanned: true }, button: /Unban User/i, call: api.unbanPubkey },
  ] as const)('routes a refused $action to the acted-on account\'s age review, even after the pubkey changes mid-action', async ({ props, button, call }) => {
    const OTHER = 'b'.repeat(64);
    let refuse!: (error: Error) => void;
    call.mockImplementationOnce(() => new Promise((_resolve, reject) => { refuse = reject; }));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const ui = (pubkey: string) => (
      <QueryClientProvider client={qc}>
        <TooltipProvider><UserActions pubkey={pubkey} {...props} /></TooltipProvider>
      </QueryClientProvider>
    );
    const { rerender } = render(ui(PUBKEY));

    fireEvent.click(screen.getByRole('button', { name: button }));
    if (call === api.suspendPubkey) confirmSuspendDialog();
    await waitFor(() => expect(call).toHaveBeenCalled());

    rerender(ui(OTHER));
    refuse(new ApiError('under age review', 409, 'Conflict', 'age_review_active'));

    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    expect(navigate).toHaveBeenCalledWith(`/age-review?pubkey=${PUBKEY}`);
  });

  it('routes a refused bulk enqueue to the enqueued account\'s age review, even after the pubkey changes', async () => {
    const OTHER = 'b'.repeat(64);
    let refuse!: (error: Error) => void;
    api.bulkModerate.mockImplementationOnce(() => new Promise((_resolve, reject) => { refuse = reject; }));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const ui = (pubkey: string) => (
      <QueryClientProvider client={qc}>
        <TooltipProvider><UserActions pubkey={pubkey} /></TooltipProvider>
      </QueryClientProvider>
    );
    const { rerender } = render(ui(PUBKEY));

    fireEvent.click(screen.getByRole('button', { name: /Age Restrict All/i }));
    await waitFor(() => expect(api.bulkModerate).toHaveBeenCalled());

    rerender(ui(OTHER));
    refuse(new ApiError('under age review', 409, 'Conflict', 'age_review_active'));

    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    expect(navigate).toHaveBeenCalledWith(`/age-review?pubkey=${PUBKEY}`);
  });

  it('warns about evidence when banning an account with an open age-review case', async () => {
    api.getActiveAgeReviewCase.mockResolvedValue({ success: true, case: { id: 'case-1' } });
    renderWithProvider(<UserActions pubkey={PUBKEY} />);
    fireEvent.click(screen.getByRole('button', { name: /Ban User/i }));
    expect(await screen.findByText(/under age review/i)).toBeInTheDocument();
  });

  it('renders unsuspend and ban when user is suspended', () => {
    renderWithProvider(<UserActions pubkey={PUBKEY} isSuspended={true} />);
    expect(screen.getByRole('button', { name: /Unsuspend User/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Ban User/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Suspend User/i })).not.toBeInTheDocument();
  });

  it('renders unban when user is banned', () => {
    renderWithProvider(<UserActions pubkey={PUBKEY} isBanned={true} />);
    expect(screen.getByRole('button', { name: /Unban User/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Ban User/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Suspend User/i })).not.toBeInTheDocument();
  });

  it('hides bulk actions in age-review context', () => {
    renderWithProvider(<UserActions pubkey={PUBKEY} context="age-review" />);
    expect(screen.getByRole('button', { name: /Suspend User/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Ban User/i })).toBeInTheDocument();
    expect(screen.queryByText(/Age Restrict All/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Delete All Content/i)).not.toBeInTheDocument();
  });

  it('tells the moderator how many files were left as they were (#291)', async () => {
    api.getBulkJobStatus.mockResolvedValue(doneJob('age-gate-all', { mediaSkipped: 3 }));
    renderWithProvider(<UserActions pubkey={PUBKEY} />);
    fireEvent.click(screen.getByRole('button', { name: /Age Restrict All/i }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      title: expect.stringMatching(/Age-restricted 2 media file\(s\)/i),
      description: '3 file(s) left as they were (already restricted, blocked or deleted).',
    })));
  });

  it('Delete All says files it left alone were already blocked or deleted', async () => {
    api.getBulkJobStatus.mockResolvedValue(doneJob('delete-all', { mediaSkipped: 2 }));
    renderWithProvider(<UserActions pubkey={PUBKEY} />);
    fireEvent.click(screen.getByRole('button', { name: /Delete All Content/i }));
    const dialog = screen.getByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm Delete' }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      title: expect.stringMatching(/Deleted 2 media file\(s\)/i),
      description: '2 file(s) left as they were (already blocked or deleted).',
    })));
  });

  it('says nothing about files left alone when there were none, or the worker predates the count', async () => {
    renderWithProvider(<UserActions pubkey={PUBKEY} />); // doneJob has no mediaSkipped
    fireEvent.click(screen.getByRole('button', { name: /Age Restrict All/i }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      title: expect.stringMatching(/Age-restricted 2 media file\(s\)/i),
    })));
    const call = vi.mocked(toast).mock.calls.find(([arg]) => /Age-restricted/.test(String(arg.title)));
    expect(call?.[0].description).toBeUndefined();
  });

  it('includes files left alone in a finished-with-issues report too', async () => {
    api.getBulkJobStatus.mockResolvedValue(doneJob('age-gate-all', { mediaSkipped: 1, failures: ['media:x:boom'] }));
    renderWithProvider(<UserActions pubkey={PUBKEY} />);
    fireEvent.click(screen.getByRole('button', { name: /Age Restrict All/i }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      title: expect.stringMatching(/finished with issues/i),
      description: expect.stringContaining('1 file(s) left as they were'),
    })));
  });

  it('age-restrict enqueues, polls to completion, toasts the result, and calls onActionComplete', async () => {
    api.getBulkJobStatus.mockResolvedValue(doneJob('age-gate-all'));
    const onActionComplete = vi.fn();
    renderWithProvider(<UserActions pubkey={PUBKEY} onActionComplete={onActionComplete} />);

    fireEvent.click(screen.getByRole('button', { name: /Age Restrict All/i }));

    await waitFor(() =>
      expect(api.bulkModerate).toHaveBeenCalledWith(PUBKEY, 'age-gate-all', expect.any(String)),
    );
    await waitFor(() => expect(api.getBulkJobStatus).toHaveBeenCalledWith('job-1'));
    await waitFor(() => expect(onActionComplete).toHaveBeenCalledTimes(1));
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: expect.stringMatching(/Age-restricted 2 media file\(s\) across 3 events/i) }),
    );
  });

  it('counts an overflow marker as the issues it stands for', async () => {
    // The worker stores 50 failures and counts the rest in "+N more".
    const failures = [...Array.from({ length: 50 }, (_, i) => `media:${i}:boom`), '+10 more'];
    api.getBulkJobStatus.mockResolvedValue(doneJob('delete-all', { failures }));
    renderWithProvider(<UserActions pubkey={PUBKEY} />);
    fireEvent.click(screen.getByRole('button', { name: /Delete All Content/i }));
    fireEvent.click(await screen.findByRole('button', { name: /Confirm Delete/i }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      title: expect.stringMatching(/finished with issues/i),
      description: expect.stringContaining('60 problem(s)'),
    })));
  });

  it('reports a job that finished with failures with a destructive toast', async () => {
    api.getBulkJobStatus.mockResolvedValue(doneJob('age-gate-all', { failures: ['media:x:boom'] }));
    renderWithProvider(<UserActions pubkey={PUBKEY} />);

    fireEvent.click(screen.getByRole('button', { name: /Age Restrict All/i }));

    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Bulk age-restrict finished with issues', variant: 'destructive' }),
      ),
    );
  });

  // A failed job did not finish, and its panel says "stopped": so does the toast.
  it('says a failed job stopped before it finished, never that it finished', async () => {
    api.getBulkJobStatus.mockResolvedValue(doneJob('age-gate-all', { status: 'failed', failures: ['media:x:boom'] }));
    renderWithProvider(<UserActions pubkey={PUBKEY} />);

    fireEvent.click(screen.getByRole('button', { name: /Age Restrict All/i }));

    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Bulk age-restrict stopped before it finished', variant: 'destructive' }),
      ),
    );
    expect(vi.mocked(toast).mock.calls.some(([arg]) => /finished with issues/.test(String(arg.title)))).toBe(false);
  });

  it('shows an error toast when the enqueue request fails', async () => {
    api.bulkModerate.mockRejectedValue(new Error('queue down'));
    renderWithProvider(<UserActions pubkey={PUBKEY} />);

    fireEvent.click(screen.getByRole('button', { name: /Age Restrict All/i }));

    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Bulk action failed', variant: 'destructive' }),
      ),
    );
  });

  it('polls through running -> done and fires onComplete exactly once', async () => {
    // First poll returns running (no toast yet), second returns done.
    api.getBulkJobStatus
      .mockResolvedValueOnce(doneJob('age-gate-all', { status: 'running', mediaProcessed: 0, eventsProcessed: 0 }))
      .mockResolvedValue(doneJob('age-gate-all'));
    const onActionComplete = vi.fn();
    renderWithProvider(<UserActions pubkey={PUBKEY} onActionComplete={onActionComplete} />);

    fireEvent.click(screen.getByRole('button', { name: /Age Restrict All/i }));
    // Button reflects the running job before the terminal poll.
    await waitFor(() => expect(screen.getByRole('button', { name: /Restricting/i })).toBeInTheDocument());
    // After the next poll the job is done: onComplete fires exactly once.
    await waitFor(() => expect(onActionComplete).toHaveBeenCalledTimes(1), { timeout: 4000 });
    expect(api.getBulkJobStatus.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(onActionComplete).toHaveBeenCalledTimes(1);
  });

  // A failed status poll is a read that went unanswered, not a failed job: the
  // job may still be running, so the buttons stay off until a check settles it.
  it('reports a lost status poll as lost track, not failed, and keeps the buttons off', async () => {
    api.getBulkJobStatus.mockRejectedValue(new Error('Network connection lost'));
    renderWithProvider(<UserActions pubkey={PUBKEY} />);

    fireEvent.click(screen.getByRole('button', { name: /Age Restrict All/i }));

    await waitFor(() => expect(toast).toHaveBeenCalledWith({
      title: 'Lost track of the bulk action',
      description: 'It may still be running on the server. Wait a minute and check again before running it again.',
    }));
    expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({ title: 'Bulk action failed' }));
    expect(screen.getByText('Lost track of the bulk action')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Age Restrict All/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Delete All Content/i })).toBeDisabled();
    // Only the bulk buttons: Ban is the severe-action escape hatch, and the
    // account actions don't race a bulk job.
    expect(screen.getByRole('button', { name: /Ban User/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /Suspend User/i })).toBeEnabled();
  });

  // The bulk gate is "anything pending, or tracking lost": an account action
  // in flight keeps the bulk buttons off too, not only a lost job.
  it.each([
    ['Suspend', false, () => api.suspendPubkey, (): void => {
      suspendThroughDialog();
    }],
    ['Unban', true, () => api.unbanPubkey, (): void => {
      fireEvent.click(screen.getByRole('button', { name: /Unban User/i }));
    }],
    ['Ban', false, () => api.banPubkey, (): void => {
      fireEvent.click(screen.getByRole('button', { name: /Ban User/i }));
      const dialog = screen.getByRole('alertdialog');
      fireEvent.click(within(dialog).getByRole('button', { name: /Ban User/i }));
    }],
  ] as const)('keeps the bulk buttons off while %s is pending', async (_label, isBanned, call, act) => {
    call().mockReturnValue(new Promise(() => {}));                    // never settles
    renderWithProvider(<UserActions pubkey={PUBKEY} isBanned={isBanned} />);

    act();

    await waitFor(() => expect(call()).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: /Age Restrict All/i, hidden: true })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Delete All Content/i, hidden: true })).toBeDisabled();
  });

  it('keeps Unban available while tracking is lost', async () => {
    api.getBulkJobStatus.mockRejectedValue(new Error('Network connection lost'));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const tree = (isBanned: boolean) => (
      <QueryClientProvider client={qc}>
        <TooltipProvider><UserActions pubkey={PUBKEY} isBanned={isBanned} /></TooltipProvider>
      </QueryClientProvider>
    );
    const { rerender } = render(tree(false));
    fireEvent.click(screen.getByRole('button', { name: /Age Restrict All/i }));
    await screen.findByText('Lost track of the bulk action');

    // The account is banned meanwhile (same mount, same lost job).
    rerender(tree(true));

    expect(screen.getByText('Lost track of the bulk action')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Unban User/i })).toBeEnabled();
  });

  // A finished job's status can be read again later (a refocused tab once it
  // is stale), and that read can fail. The job is over, so that is not lost
  // tracking, and the bulk buttons stay usable.
  it('does not report lost track when a finished job\'s later status read fails', async () => {
    api.getBulkJobStatus.mockResolvedValue(doneJob('age-gate-all'));
    const onActionComplete = vi.fn();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <TooltipProvider><UserActions pubkey={PUBKEY} onActionComplete={onActionComplete} /></TooltipProvider>
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Age Restrict All/i }));
    await waitFor(() => expect(onActionComplete).toHaveBeenCalledTimes(1));

    api.getBulkJobStatus.mockRejectedValue(new Error('Network connection lost'));
    await qc.refetchQueries({ queryKey: ['bulk-job'] });
    await waitFor(() => expect(qc.getQueryState(['bulk-job', PUBKEY, 'job-1'])?.status).toBe('error'));

    expect(screen.queryByText('Lost track of the bulk action')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Age Restrict All$/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /Delete All Content/i })).toBeEnabled();
  });

  it('"Check again" re-reads the job and settles it', async () => {
    api.getBulkJobStatus.mockRejectedValueOnce(new Error('Network connection lost'));
    api.getBulkJobStatus.mockResolvedValue(doneJob('age-gate-all'));
    const onActionComplete = vi.fn();
    renderWithProvider(<UserActions pubkey={PUBKEY} onActionComplete={onActionComplete} />);
    fireEvent.click(screen.getByRole('button', { name: /Age Restrict All/i }));
    const checkAgain = await screen.findByRole('button', { name: 'Check again' });

    fireEvent.click(checkAgain);

    await waitFor(() => expect(onActionComplete).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('Lost track of the bulk action')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: /^Age Restrict All$/i })).toBeEnabled());
  });

  it('keeps the destructive button disabled while a job stays non-terminal (no fixed-timer re-enable)', async () => {
    // A chunked job can legitimately run longer than any client timer. The button
    // must NOT re-enable on a timer (which would let a moderator start a second,
    // duplicate destructive job); it stays in the running state until the worker
    // reports terminal. Verifies the removal of the 10-minute give-up.
    vi.useFakeTimers();
    try {
      api.getBulkJobStatus.mockResolvedValue(doneJob('age-gate-all', { status: 'running', mediaProcessed: 0, eventsProcessed: 0 }));
      renderWithProvider(<UserActions pubkey={PUBKEY} />);
      fireEvent.click(screen.getByRole('button', { name: /Age Restrict All/i }));
      await vi.advanceTimersByTimeAsync(2000); // enqueue resolves, job running
      await vi.advanceTimersByTimeAsync(11 * 60 * 1000); // well past the old 10-minute give-up
      // Still running (not re-enabled to its idle label), so no duplicate job can start.
      expect(screen.queryByRole('button', { name: /^Age Restrict All$/i })).toBeNull();
      expect(screen.getByRole('button', { name: /Restricting/i })).toBeInTheDocument();
      expect(toast).not.toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Bulk action failed', variant: 'destructive' }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('detaches from an in-flight job when the selected user changes (no stale running state)', async () => {
    // Job for user A keeps polling (never terminal).
    api.getBulkJobStatus.mockResolvedValue(doneJob('age-gate-all', { status: 'running', mediaProcessed: 0, eventsProcessed: 0 }));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const Wrapper = ({ pk }: { pk: string }) => (
      <QueryClientProvider client={qc}>
        <TooltipProvider><UserActions pubkey={pk} /></TooltipProvider>
      </QueryClientProvider>
    );
    const { rerender } = render(<Wrapper pk={PUBKEY} />);

    fireEvent.click(screen.getByRole('button', { name: /Age Restrict All/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Restricting/i })).toBeInTheDocument());

    // Switch to a different user — same component instance, not remounted.
    rerender(<Wrapper pk={'b'.repeat(64)} />);

    // The new user's button is idle/enabled, not stuck on the previous job.
    await waitFor(() => expect(screen.getByRole('button', { name: /^Age Restrict All$/i })).toBeEnabled());
  });

  it('completes the ban (closing the modal) even when the audit log never resolves', async () => {
    // Regression: logDecision used to be awaited in the mutation critical path, so a
    // hung /api/decisions write left the confirm dialog stuck on "Banning…". The audit
    // log is now fire-and-forget, so the ban must still settle when it never resolves.
    api.logDecision.mockReturnValue(new Promise(() => {})); // never settles
    const onActionComplete = vi.fn();

    renderWithProvider(
      <UserActions pubkey={'a'.repeat(64)} onActionComplete={onActionComplete} />
    );

    fireEvent.click(screen.getByRole('button', { name: /Ban User/i })); // open confirm dialog
    const dialog = screen.getByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Ban User' })); // confirm

    await waitFor(() => expect(onActionComplete).toHaveBeenCalledTimes(1));
    expect(api.banPubkey).toHaveBeenCalledWith('a'.repeat(64), 'Banned by moderator');
    expect(api.logDecision).toHaveBeenCalledTimes(1); // fired, but not awaited
  });

  it('invalidates the decision log after the detached audit write lands (report converges without manual refresh)', async () => {
    // Resolution that comes only from the D1 decision row races the
    // fire-and-forget write in the onSuccess refetch. The invalidation must fire
    // AFTER the write resolves (not before), so the report converges on its own.
    // Unsuspend: suspend no longer writes from the browser (see the next test).
    let resolveWrite!: () => void;
    api.logDecision.mockReturnValue(new Promise<void>((r) => { resolveWrite = () => r(undefined); }));

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const decisionsInvalidations = () => invalidateSpy.mock.calls.filter(
      ([arg]) => (arg as { queryKey?: unknown[] })?.queryKey?.[0] === 'decisions',
    ).length;

    render(
      <QueryClientProvider client={qc}>
        <TooltipProvider><UserActions pubkey={'a'.repeat(64)} isSuspended /></TooltipProvider>
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: /Unsuspend User/i }));

    await waitFor(() => expect(api.logDecision).toHaveBeenCalledTimes(1));
    expect(decisionsInvalidations()).toBe(0); // write hasn't landed yet — report stays unresolved

    resolveWrite();

    await waitFor(() => expect(decisionsInvalidations()).toBe(1));
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['decisions'] });
    // The queue subtracts the ['resolution-state'] projection, not the decision
    // log, so without this key the account's reports stay misplaced until the
    // next poll (#273).
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['resolution-state'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['reports-resolved'] });
  });

  // The worker wrote the suspend's decision row before answering, so the
  // refresh runs on success: suspend resolution comes only from that row.
  it('refreshes the decision log and resolved state after a suspend', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    renderWithProvider(<UserActions pubkey={PUBKEY} />, qc);
    suspendThroughDialog();
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: expect.stringMatching(/^User suspended/) })));
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['decisions'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['resolution-state'] });
  });

  // A suspend writes a new timer (or none, for no end date), so a cached answer from before it
  // must not stand in for the new end. Reset, not invalidate, as below.
  it('resets the timers after a suspend', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const resetSpy = vi.spyOn(qc, 'resetQueries');
    renderWithProvider(<UserActions pubkey={PUBKEY} />, qc);
    suspendThroughDialog();
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: expect.stringMatching(/^User suspended/) })));
    expect(resetSpy).toHaveBeenCalledWith({ queryKey: TIMED_SUSPENSIONS_KEY });
  });

  // Reset, not invalidate, like every other timer-changing action: if the re-read
  // fails, the old end must not stay on screen as if current.
  it('resets the timers after an unsuspend', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const resetSpy = vi.spyOn(qc, 'resetQueries');
    renderWithProvider(<UserActions pubkey={PUBKEY} isSuspended />, qc);
    fireEvent.click(screen.getByRole('button', { name: /Unsuspend User/i }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith({ title: 'User unsuspended' }));
    expect(resetSpy).toHaveBeenCalledWith({ queryKey: TIMED_SUSPENSIONS_KEY });
  });

  it('closes the ban dialog on success (the alertdialog is removed)', async () => {
    // The real symptom of the hang bug is the dialog never closing; assert it's gone.
    renderWithProvider(<UserActions pubkey={'a'.repeat(64)} />);
    fireEvent.click(screen.getByRole('button', { name: /Ban User/i }));
    const dialog = screen.getByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Ban User' }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  });

  // banPubkey turns a timeout the ban list cannot confirm into BanNotConfirmedError.
  // It may have landed, so it must not read as a destructive "Failed".
  it('surfaces an unconfirmed ban as "not confirmed", not a failure, and keeps the dialog open', async () => {
    const notConfirmed = new BanNotConfirmedError('Request to /api/moderate timed out after 30s.');
    api.banPubkey.mockRejectedValue(notConfirmed);
    const invalidate = vi.spyOn(QueryClient.prototype, 'invalidateQueries');
    renderWithProvider(<UserActions pubkey={'a'.repeat(64)} />);
    fireEvent.click(screen.getByRole('button', { name: /Ban User/i }));
    const dialog = screen.getByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Ban User' }));

    await waitFor(() => expect(toast).toHaveBeenCalledWith(banFailureToast(notConfirmed)));
    expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({ variant: 'destructive' }));
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    // The toast asks for a re-check; the ban lists must not be the stale ones.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['banned-pubkeys'] });
    invalidate.mockRestore();
  });

  it('keeps a refused ban a destructive failure', async () => {
    const refusal = new ApiError('Missing pubkey for ban_pubkey', 400);
    api.banPubkey.mockRejectedValue(refusal);
    renderWithProvider(<UserActions pubkey={'a'.repeat(64)} />);
    fireEvent.click(screen.getByRole('button', { name: /Ban User/i }));
    const dialog = screen.getByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Ban User' }));

    await waitFor(() => expect(toast).toHaveBeenCalledWith(banFailureToast(refusal)));
  });

  // The app shows one toast at a time, and whether the audit warning lands
  // before or after the ban toast depends on timing, so both carry the note.
  it('keeps the ban note on the audit warning when the audit log fails', async () => {
    api.banPubkey.mockResolvedValue({ unconfirmed: 'follow_ups_not_run' });
    api.logDecision.mockRejectedValue(new Error('audit down'));
    renderWithProvider(<UserActions pubkey={'a'.repeat(64)} />);
    fireEvent.click(screen.getByRole('button', { name: /Ban User/i }));
    const dialog = screen.getByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Ban User' }));

    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(expect.objectContaining({
        title: expect.stringMatching(/audit log not recorded/i),
        description: banSuccessNote({ unconfirmed: 'follow_ups_not_run' }),
      })),
    );
  });

  it('explains what was not confirmed when the ban landed without confirmed content removal', async () => {
    api.banPubkey.mockResolvedValue({ unconfirmed: 'removal_running' });
    renderWithProvider(<UserActions pubkey={'a'.repeat(64)} />);
    fireEvent.click(screen.getByRole('button', { name: /Ban User/i }));
    const dialog = screen.getByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Ban User' }));

    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(expect.objectContaining({
        title: 'User banned from relay',
        description: banSuccessNote({ unconfirmed: 'removal_running' }),
      })),
    );
  });

  it('shows a non-blocking toast when the audit log fails but still completes the ban', async () => {
    // Audit-log loss should be visible to the moderator, but must never block the
    // action or the dialog close.
    api.logDecision.mockRejectedValue(new Error('audit down'));
    renderWithProvider(<UserActions pubkey={'a'.repeat(64)} />);
    fireEvent.click(screen.getByRole('button', { name: /Ban User/i }));
    const dialog = screen.getByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Ban User' }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({ title: expect.stringMatching(/audit log not recorded/i) }),
      ),
    );
  });

  // `null` here means a relay list read did not complete, which is not the same
  // as a confirmed negative. The actions stay live either way -- a failed status
  // read must not block moderation -- but the moderator is told the status was
  // never confirmed rather than being shown an implied clean account.
  describe('unconfirmed account status', () => {
    it('says so when the suspend status could not be confirmed', () => {
      renderWithProvider(<UserActions pubkey={PUBKEY} isBanned={false} isSuspended={null} />);

      expect(screen.getByText('Account status could not be confirmed')).toBeInTheDocument();
    });

    it('says so when the ban status could not be confirmed', () => {
      renderWithProvider(<UserActions pubkey={PUBKEY} isBanned={null} isSuspended={false} />);

      expect(screen.getByText('Account status could not be confirmed')).toBeInTheDocument();
    });

    it('stays quiet when both statuses were confirmed', () => {
      renderWithProvider(<UserActions pubkey={PUBKEY} isBanned={false} isSuspended={false} />);

      expect(screen.queryByText('Account status could not be confirmed')).not.toBeInTheDocument();
    });

    it('stays quiet when the caller has no status to pass at all', () => {
      // AgeReviewDetail renders this without status props. Omitted must keep
      // meaning "not applicable", not "unconfirmed".
      renderWithProvider(<UserActions pubkey={PUBKEY} />);

      expect(screen.queryByText('Account status could not be confirmed')).not.toBeInTheDocument();
    });

    it('says it is still checking, not that it failed, while a read is in flight', () => {
      // Before a list first answers, the status is null for the same reason a
      // failed read makes it null. "Could not be confirmed" claims a failure
      // that has not happened yet.
      renderWithProvider(
        <UserActions pubkey={PUBKEY} isBanned={null} isSuspended={null} statusPending />,
      );

      expect(screen.getByText('Checking account status')).toBeInTheDocument();
      expect(screen.queryByText('Account status could not be confirmed')).not.toBeInTheDocument();
    });

    it('says it is checking while a re-check of a confirmed status runs', () => {
      // A re-check runs after every action a moderator takes. Until it answers,
      // the status on screen is from BEFORE that action -- right after an
      // Unsuspend it still reads "suspended". Presenting it as current with no
      // note is the one thing this must not do.
      renderWithProvider(
        <UserActions pubkey={PUBKEY} isBanned={false} isSuspended={false} statusPending />,
      );

      expect(screen.getByText('Checking account status')).toBeInTheDocument();
      expect(screen.queryByText('Account status could not be confirmed')).not.toBeInTheDocument();
    });

    it('says a kept status may be out of date when its refresh failed', () => {
      renderWithProvider(<UserActions pubkey={PUBKEY} isBanned={false} isSuspended statusStale />);

      expect(screen.getByText('Account status may be out of date')).toBeInTheDocument();
      // The undo stays reachable: that is why the kept status is shown at all.
      expect(screen.getByRole('button', { name: /Unsuspend User/i })).toBeEnabled();
    });

    it('says it is checking, not out of date, while a re-check runs', () => {
      renderWithProvider(<UserActions pubkey={PUBKEY} isBanned={false} isSuspended statusStale statusPending />);

      expect(screen.getByText('Checking account status')).toBeInTheDocument();
      expect(screen.queryByText('Account status may be out of date')).not.toBeInTheDocument();
    });

    it('still offers the actions when the status is unconfirmed', () => {
      renderWithProvider(<UserActions pubkey={PUBKEY} isBanned={null} isSuspended={null} />);

      // A relay blip must not take moderation away.
      expect(screen.getByText('Account status could not be confirmed')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Ban User/i })).toBeEnabled();
    });
  });

  // The report pane treats everything from before an account action as
  // unconfirmed until its check answers. A content action leaves the account
  // status as it was, so the caller must be told which kind finished.
  describe('says whether the finished action changed account status', () => {
    it('after a suspend', async () => {
      const onActionComplete = vi.fn();
      renderWithProvider(<UserActions pubkey={PUBKEY} onActionComplete={onActionComplete} />);
      suspendThroughDialog();
      await waitFor(() => expect(onActionComplete).toHaveBeenCalledWith({ accountStatusChanged: true, pubkey: PUBKEY, action: 'suspend' }));
    });

    it('after an unsuspend', async () => {
      const onActionComplete = vi.fn();
      renderWithProvider(<UserActions pubkey={PUBKEY} isSuspended onActionComplete={onActionComplete} />);
      fireEvent.click(screen.getByRole('button', { name: /Unsuspend User/i }));
      await waitFor(() => expect(onActionComplete).toHaveBeenCalledWith({ accountStatusChanged: true, pubkey: PUBKEY, action: 'unsuspend' }));
    });

    it('after a ban', async () => {
      const onActionComplete = vi.fn();
      renderWithProvider(<UserActions pubkey={PUBKEY} onActionComplete={onActionComplete} />);
      fireEvent.click(screen.getByRole('button', { name: /Ban User/i }));
      fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Ban User' }));
      await waitFor(() => expect(onActionComplete).toHaveBeenCalledWith({ accountStatusChanged: true, pubkey: PUBKEY, action: 'ban' }));
    });

    it('after an unban', async () => {
      const onActionComplete = vi.fn();
      renderWithProvider(<UserActions pubkey={PUBKEY} isBanned onActionComplete={onActionComplete} />);
      fireEvent.click(screen.getByRole('button', { name: /Unban User/i }));
      await waitFor(() => expect(onActionComplete).toHaveBeenCalledWith({ accountStatusChanged: true, pubkey: PUBKEY, action: 'unban' }));
    });

    it('after Age Restrict All, which leaves the account as it was', async () => {
      const onActionComplete = vi.fn();
      renderWithProvider(<UserActions pubkey={PUBKEY} onActionComplete={onActionComplete} />);
      fireEvent.click(screen.getByRole('button', { name: /Age Restrict All/i }));
      await waitFor(() => expect(onActionComplete).toHaveBeenCalledWith({ accountStatusChanged: false }));
    });

    it('reports Delete All Content even when some deletions failed', async () => {
      api.getBulkJobStatus.mockResolvedValue(doneJob('delete-all', { failures: ['event:relay down'] }));
      const onActionComplete = vi.fn();
      renderWithProvider(<UserActions pubkey={PUBKEY} onActionComplete={onActionComplete} />);
      fireEvent.click(screen.getByRole('button', { name: /Delete All Content/i }));
      fireEvent.click(await screen.findByRole('button', { name: 'Confirm Delete' }));
      await waitFor(() => expect(onActionComplete).toHaveBeenCalledWith({ accountStatusChanged: false, action: 'delete-all' }));
    });
  });

});

// #299: a finished job's problems and notes for a person (other accounts'
// files) are listed in a panel that stays until dismissed, not in the toast.
// The Users page starts only Age Restrict All and Delete All, so it never gets
// still-hidden notes (only Un-age-restrict All makes them).
describe('UserActions bulk job notes', () => {
  const THEIRS = '3'.repeat(64);
  const OTHER_THEIRS = '4'.repeat(64);
  const OWNER = 'b2'.repeat(32);

  async function finishAgeRestrictAll() {
    renderWithProvider(<UserActions pubkey={PUBKEY} />);
    fireEvent.click(screen.getByRole('button', { name: /Age Restrict All/i }));
    await waitFor(() => expect(toast).toHaveBeenCalled());
  }

  it("lists the job's stored failures in the panel, above its notes, and the toast only points to them", async () => {
    const failures = [`media:${'9'.repeat(64)}:Moderation service returned 500`, 'enumeration:x:the list could not be read', '+3 more'];
    api.getBulkJobStatus.mockResolvedValue(doneJob('delete-all', { failures, noteCount: 1 }));
    api.getBulkJobNotes.mockResolvedValue({ notes: [{ kind: 'not-owned', sha256: THEIRS, owner: OWNER }], next: null });
    renderWithProvider(<UserActions pubkey={PUBKEY} />);
    fireEvent.click(screen.getByRole('button', { name: /Delete All Content/i }));
    fireEvent.click(await screen.findByRole('button', { name: /Confirm Delete/i }));
    expect(await screen.findByRole('heading', { name: /problems \(5\)/i })).toBeInTheDocument();
    expect(screen.getByText(`File ${'9'.repeat(64)} could not be changed: Moderation service returned 500.`)).toBeInTheDocument();
    expect(await screen.findByText(THEIRS)).toBeInTheDocument();
    expect(screen.getByRole('region', { name: /results to look at/i })).toHaveTextContent('The job finished.');
    const call = vi.mocked(toast).mock.calls.find(([arg]) => /finished with issues/.test(String(arg.title)));
    expect(call?.[0].description).toBe('2 media across 3 events. 5 problem(s) and 1 file(s) to check are listed below.');
  });

  it('says a failed job stopped before it finished', async () => {
    api.getBulkJobStatus.mockResolvedValue(doneJob('age-gate-all', { status: 'failed', failures: ['job:relay down'] }));
    await finishAgeRestrictAll();
    expect(await screen.findByRole('region', { name: /results to look at/i })).toHaveTextContent('The job stopped before it finished.');
  });

  it('moves focus to the account actions when the panel is dismissed', async () => {
    api.getBulkJobStatus.mockResolvedValue(doneJob('age-gate-all', { failures: ['enumeration:x:y'] }));
    await finishAgeRestrictAll();
    fireEvent.click(await screen.findByRole('button', { name: /dismiss/i }));
    expect(document.activeElement).toBe(screen.getByRole('group', { name: /account actions/i }));
  });

  it('reads every page of a finished job\'s notes and lists them until dismissed', async () => {
    api.getBulkJobStatus.mockResolvedValue(doneJob('age-gate-all', { noteCount: 2 }));
    api.getBulkJobNotes
      .mockResolvedValueOnce({ notes: [{ kind: 'not-owned', sha256: THEIRS, owner: OWNER }], next: '1' })
      .mockResolvedValueOnce({ notes: [{ kind: 'not-owned', sha256: OTHER_THEIRS, owner: OWNER }], next: null });
    await finishAgeRestrictAll();
    expect(await screen.findByText(THEIRS)).toBeInTheDocument();
    expect(screen.getByText(OTHER_THEIRS)).toBeInTheDocument();
    expect(api.getBulkJobNotes).toHaveBeenNthCalledWith(1, 'job-1', undefined);
    expect(api.getBulkJobNotes).toHaveBeenNthCalledWith(2, 'job-1', '1');
    // Notes are not issues: the job finished clean.
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: expect.stringMatching(/Age-restricted 2 media file\(s\)/i) }));
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(screen.queryByText(THEIRS)).not.toBeInTheDocument();
  });

  it('does not read notes for a job that stored none', async () => {
    api.getBulkJobStatus.mockResolvedValue(doneJob('age-gate-all', { noteCount: 0 }));
    await finishAgeRestrictAll();
    expect(api.getBulkJobNotes).not.toHaveBeenCalled();
    expect(screen.queryByRole('region', { name: /to look at/i })).not.toBeInTheDocument();
  });

  it('shows no notes for a job a worker that predates notes ran (no count, no notes route)', async () => {
    api.getBulkJobStatus.mockResolvedValue(doneJob('age-gate-all'));
    api.getBulkJobNotes.mockRejectedValue(new ApiError('Not found', 404, 'Not Found'));
    await finishAgeRestrictAll();
    await waitFor(() => expect(api.getBulkJobNotes).toHaveBeenCalled());
    expect(screen.queryByRole('region', { name: /to look at/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/could not be loaded/i)).not.toBeInTheDocument();
  });

  it('still lists the notes when the job\'s count could not be read', async () => {
    api.getBulkJobStatus.mockResolvedValue(doneJob('age-gate-all'));
    api.getBulkJobNotes.mockResolvedValue({ notes: [{ kind: 'not-owned', sha256: THEIRS, owner: OWNER }], next: null });
    await finishAgeRestrictAll();
    expect(await screen.findByText(THEIRS)).toBeInTheDocument();
  });

  it('says why the notes could not be loaded, and tries again on request', async () => {
    api.getBulkJobStatus.mockResolvedValue(doneJob('age-gate-all', { noteCount: 1 }));
    api.getBulkJobNotes.mockRejectedValueOnce(new ApiError('HTTP 500: Internal Server Error', 500, 'Internal Server Error'));
    api.getBulkJobNotes.mockResolvedValueOnce({ notes: [{ kind: 'not-owned', sha256: THEIRS, owner: OWNER }], next: null });
    await finishAgeRestrictAll();
    expect(await screen.findByText(/HTTP 500/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByText(THEIRS)).toBeInTheDocument();
  });
});

// UserActions drops the acted-on account's authored-content reads itself, so
// every host (report detail, user management, age review) gets it: the relay
// hides a banned or suspended account's content, so a count read before the
// action describes the other state (lib/userStatsCache).
describe('UserActions drops cached authored-content reads after its account actions', () => {
  const statsKey = (pk: string) => ['user-stats', 'wss://relay.test', pk];
  function clientWithStats(pk: string) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    qc.setQueryData(statsKey(pk), { postCount: 0 });
    return qc;
  }

  it('after a suspend', async () => {
    const qc = clientWithStats(PUBKEY);
    renderWithProvider(<UserActions pubkey={PUBKEY} />, qc);
    suspendThroughDialog();
    await waitFor(() => expect(qc.getQueryData(statsKey(PUBKEY))).toBeUndefined());
  });

  it('after a ban', async () => {
    const qc = clientWithStats(PUBKEY);
    renderWithProvider(<UserActions pubkey={PUBKEY} />, qc);
    fireEvent.click(screen.getByRole('button', { name: /Ban User/i }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Ban User' }));
    await waitFor(() => expect(qc.getQueryData(statsKey(PUBKEY))).toBeUndefined());
  });

  // The ban may have landed even though it could not be confirmed.
  it('after a ban that could not be confirmed', async () => {
    api.banPubkey.mockRejectedValue(new BanNotConfirmedError('timed out'));
    const qc = clientWithStats(PUBKEY);
    renderWithProvider(<UserActions pubkey={PUBKEY} />, qc);
    fireEvent.click(screen.getByRole('button', { name: /Ban User/i }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Ban User' }));
    await waitFor(() => expect(qc.getQueryData(statsKey(PUBKEY))).toBeUndefined());
  });

  it('for the account the action was taken on, even if another is shown by the time it lands', async () => {
    const OTHER = 'c'.repeat(64);
    let land: (v: unknown) => void = () => {};
    api.suspendPubkey.mockImplementation(() => new Promise(r => { land = r; }));
    const qc = clientWithStats(PUBKEY);
    qc.setQueryData(statsKey(OTHER), { postCount: 0 });
    const tree = (pk: string) => (
      <QueryClientProvider client={qc}>
        <TooltipProvider><UserActions pubkey={pk} /></TooltipProvider>
      </QueryClientProvider>
    );
    const { rerender } = render(tree(PUBKEY));
    suspendThroughDialog();
    await waitFor(() => expect(api.suspendPubkey).toHaveBeenCalled());

    rerender(tree(OTHER));
    await act(async () => { land({ endsAt: threeDaysOut(), recorded: true, decisionRecorded: true }); });

    await waitFor(() => expect(qc.getQueryData(statsKey(PUBKEY))).toBeUndefined());
    expect(qc.getQueryData(statsKey(OTHER))).toEqual({ postCount: 0 });
  });

  // The relay's suspension filter can lag an Unsuspend by a few minutes.
  it('starts the restore window after an unsuspend', async () => {
    const pk = '1'.repeat(64);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const qc = clientWithStats(pk);
      renderWithProvider(<UserActions pubkey={pk} isSuspended />, qc);
      fireEvent.click(screen.getByRole('button', { name: /Unsuspend User/i }));

      const { result } = renderHook(() => useJustRestored(pk));
      await waitFor(() => expect(result.current).toBe(true));
      expect(qc.getQueryData(statsKey(pk))).toBeUndefined();
      await act(async () => { await vi.advanceTimersByTimeAsync(RESTORE_SETTLE_MS + 1); });
    } finally {
      vi.useRealTimers();
    }
  });

  // A ban usually purged the posts (funnelcake's inline purge), so "posts can
  // take a few minutes to reappear" would mislead. An unban resets the reads
  // and opens no window.
  it('resets the reads after an unban, but opens no restore window', async () => {
    const pk = '2'.repeat(64);
    const { result } = renderHook(() => useJustRestored(pk));
    const qc = clientWithStats(pk);
    renderWithProvider(<UserActions pubkey={pk} isBanned />, qc);
    fireEvent.click(screen.getByRole('button', { name: /Unban User/i }));

    await waitFor(() => expect(qc.getQueryData(statsKey(pk))).toBeUndefined());
    expect(result.current).toBe(false);
  });

  // Positive control: the relay call landed and only the audit write (which
  // UserActions does not await) failed. The account is restored.
  it.each([
    ['unsuspend', 'a1'.repeat(32), { isSuspended: true }, /Unsuspend User/i],
  ] as const)('starts the restore window after an %s whose audit write failed', async (_name, pk, props, button) => {
    // Rendered once, before the action: a renderHook inside waitFor's callback
    // would loop on a failing assertion. Real timers; a pubkey nothing else uses.
    const { result } = renderHook(() => useJustRestored(pk));
    api.logDecision.mockRejectedValue(new Error('audit down'));
    renderWithProvider(<UserActions pubkey={pk} {...props} />, clientWithStats(pk));
    fireEvent.click(screen.getByRole('button', { name: button }));

    await waitFor(() => expect(api.logDecision).toHaveBeenCalled());
    await waitFor(() => expect(result.current).toBe(true));
  });

  // A failed or still-pending restore leaves the account hidden, so "just
  // restored" would be wrong. The pending case fails if the window is opened
  // before the relay call is awaited.
  it.each([
    ['unsuspend', '4'.repeat(64), { isSuspended: true }, /Unsuspend User/i, () => api.unsuspendPubkey],
  ] as const)('does not start the restore window while the %s is still pending', async (_name, pk, props, button, call) => {
    call().mockImplementation(() => new Promise(() => {}));
    renderWithProvider(<UserActions pubkey={pk} {...props} />, clientWithStats(pk));
    fireEvent.click(screen.getByRole('button', { name: button }));

    await waitFor(() => expect(call()).toHaveBeenCalled());
    expect(renderHook(() => useJustRestored(pk)).result.current).toBe(false);
  });

  it('does not start the restore window when the unsuspend failed', async () => {
    const pk = '9'.repeat(64);
    api.unsuspendPubkey.mockRejectedValue(new Error('relay unreachable'));
    renderWithProvider(<UserActions pubkey={pk} isSuspended />, clientWithStats(pk));
    fireEvent.click(screen.getByRole('button', { name: /Unsuspend User/i }));

    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Failed to unsuspend user' })));
    expect(renderHook(() => useJustRestored(pk)).result.current).toBe(false);
  });

});

// A ban or suspend after a restore hides the account again: the window must end.
describe('UserActions ends the restore window when it hides the account', () => {
  it.each([
    ['suspend', 'c3'.repeat(32), /Suspend User/i, false],
    ['ban', 'd4'.repeat(32), /Ban User/i, true],
  ] as const)('after a %s', async (_name, pk, button, confirm) => {
    const { result } = renderHook(() => useJustRestored(pk));
    await act(async () => { await markRestored(new QueryClient(), pk, undefined); });
    expect(result.current).toBe(true);

    renderWithProvider(<UserActions pubkey={pk} />);
    fireEvent.click(screen.getByRole('button', { name: button }));
    if (confirm) fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Ban User' }));
    else confirmSuspendDialog();

    await waitFor(() => expect(result.current).toBe(false));
  });

  // A refused ban or suspend did not hide the account: the reads reset (that
  // the failure settled), and the window an earlier unsuspend opened stays.
  it.each([
    ['suspend', 'e6'.repeat(32), /Suspend User/i, false, () => api.suspendPubkey],
    ['ban', 'f7'.repeat(32), /Ban User/i, true, () => api.banPubkey],
  ] as const)('keeps the window when the %s was refused', async (_name, pk, button, confirm, call) => {
    call().mockRejectedValue(new ApiError('refused', 403, 'Forbidden'));
    const { result } = renderHook(() => useJustRestored(pk));
    await act(async () => { await markRestored(new QueryClient(), pk, undefined); });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    qc.setQueryData(['user-stats', 'wss://relay.test', pk], { postCount: 0 });

    renderWithProvider(<UserActions pubkey={pk} />, qc);
    fireEvent.click(screen.getByRole('button', { name: button }));
    if (confirm) fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Ban User' }));
    else confirmSuspendDialog();

    await waitFor(() => expect(qc.getQueryData(['user-stats', 'wss://relay.test', pk])).toBeUndefined());
    expect(result.current).toBe(true);
  });
});

// The window belongs to the environment the action ran in, captured when it
// started: one that lands after a switch must not open on the new one.
describe('UserActions restore window per environment', () => {
  const ctx = (relayUrl: string) => ({ config: { relayUrl, apiUrl: '', theme: 'light' }, updateConfig: () => {} }) as AppContextType;

  it('marks the environment the unsuspend started in, even if it lands after a switch', async () => {
    const pk = 'e5'.repeat(32);
    let land: (v: unknown) => void = () => {};
    api.unsuspendPubkey.mockImplementation(() => new Promise(r => { land = r; }));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const tree = (relayUrl: string) => (
      <AppContext.Provider value={ctx(relayUrl)}>
        <QueryClientProvider client={qc}>
          <TooltipProvider><UserActions pubkey={pk} isSuspended /></TooltipProvider>
        </QueryClientProvider>
      </AppContext.Provider>
    );
    const inEnv = (relayUrl: string) => renderHook(() => useJustRestored(pk), {
      wrapper: ({ children }: { children: React.ReactNode }) => <AppContext.Provider value={ctx(relayUrl)}>{children}</AppContext.Provider>,
    }).result;
    const { rerender } = render(tree('wss://relay.prod.test'));
    fireEvent.click(screen.getByRole('button', { name: /Unsuspend User/i }));
    await waitFor(() => expect(api.unsuspendPubkey).toHaveBeenCalled());

    rerender(tree('wss://relay.staging.test'));
    await act(async () => { land({ success: true }); });

    const prod = inEnv('wss://relay.prod.test');
    await waitFor(() => expect(prod.current).toBe(true));
    expect(inEnv('wss://relay.staging.test').current).toBe(false);
  });
});

// Timed suspensions: Suspend asks for a length, a suspended account shows when
// its suspension ends, and Change end date moves that end.
describe('UserActions timed suspensions', () => {
  // The timer read sets its own retry (1); keep its delay out of the tests.
  const client = () => new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 }, mutations: { retry: false } } });
  const timer = (endsAt: string | null) => ({
    pubkey: PUBKEY, endsAt, status: 'active' as const, setBy: null, setAt: '2026-11-20T00:00:00.000Z', changedAt: null,
  });

  describe('Suspend', () => {
    it('Suspend -> 3 days -> Suspend sends the length, and the browser writes no suspend_user row', async () => {
      const endsAt = threeDaysOut();
      api.suspendPubkey.mockResolvedValue({ endsAt, recorded: true, decisionRecorded: true });
      renderWithProvider(<UserActions pubkey={PUBKEY} />, client());
      suspendThroughDialog('3', 'days');
      await waitFor(() => expect(api.suspendPubkey).toHaveBeenCalledWith(PUBKEY, 'Suspended by moderator', { value: 3, unit: 'days' }));
      await waitFor(() => expect(toast).toHaveBeenCalledWith({ title: `User suspended until ${formatSuspensionEnd(endsAt)}` }));
      expect(api.logDecision).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'suspend_user' }));
      // The dialog closes once the suspend lands.
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    });

    it('No end date sends an explicit open end', async () => {
      api.suspendPubkey.mockResolvedValue({ endsAt: null, recorded: true, decisionRecorded: true });
      renderWithProvider(<UserActions pubkey={PUBKEY} />, client());
      suspendThroughDialog(null);
      await waitFor(() => expect(api.suspendPubkey).toHaveBeenCalledWith(PUBKEY, 'Suspended by moderator', null));
      await waitFor(() => expect(toast).toHaveBeenCalledWith({ title: 'User suspended, no end date' }));
    });

    it('says the end date was not saved when the timer record was not written', async () => {
      // decisionRecorded false as well: the not-saved toast outranks the audit one.
      api.suspendPubkey.mockResolvedValue({ endsAt: null, recorded: false, decisionRecorded: false });
      renderWithProvider(<UserActions pubkey={PUBKEY} />, client());
      suspendThroughDialog('3', 'days');
      await waitFor(() => expect(toast).toHaveBeenCalledWith({
        title: 'User suspended, but the end date was not saved',
        description: 'Use Change end date to set it.',
      }));
      expect(toast).toHaveBeenCalledTimes(1);
    });

    // An open-ended suspend also replaces the timer record. When that write fails, an
    // earlier timer stays active and can still lift the suspension at its old end (G7).
    it('warns that an earlier end may still lift it when an open-ended suspend was not recorded', async () => {
      api.suspendPubkey.mockResolvedValue({ endsAt: null, recorded: false, decisionRecorded: true });
      renderWithProvider(<UserActions pubkey={PUBKEY} />, client());
      suspendThroughDialog(null);
      await waitFor(() => expect(toast).toHaveBeenCalledWith({
        title: 'User suspended, but the end date could not be cleared',
        description: 'An earlier end date may still lift this suspension. Check its end date.',
      }));
      expect(toast).toHaveBeenCalledTimes(1);
    });

    it('says the audit log was not recorded when the worker could not write the decision row', async () => {
      const endsAt = threeDaysOut();
      api.suspendPubkey.mockResolvedValue({ endsAt, recorded: true, decisionRecorded: false });
      renderWithProvider(<UserActions pubkey={PUBKEY} />, client());
      suspendThroughDialog('3', 'days');
      await waitFor(() => expect(toast).toHaveBeenCalledWith({
        title: 'Action applied; audit log not recorded',
        description: `User suspended until ${formatSuspensionEnd(endsAt)}`,
      }));
    });

    // ReportDetail keeps UserActions mounted across reports: a dialog opened
    // for one account must not confirm against the next one shown.
    it('closes the dialog when another account is shown', () => {
      const qc = client();
      const tree = (pk: string) => (
        <QueryClientProvider client={qc}><TooltipProvider><UserActions pubkey={pk} /></TooltipProvider></QueryClientProvider>
      );
      const { rerender } = render(tree(PUBKEY));
      fireEvent.click(screen.getByRole('button', { name: /^Suspend User/i }));
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      rerender(tree('b'.repeat(64)));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      // Back to the first account: the abandoned dialog stays closed (G6).
      rerender(tree(PUBKEY));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(api.suspendPubkey).not.toHaveBeenCalled();
    });

    // Reset, not invalidate: a cached "no timer" answer from before the suspend
    // must not stand in for the new end when the re-read fails.
    it('shows the end as unavailable, not a stale answer, when the re-read after a suspend fails', async () => {
      const qc = client();
      qc.setQueryData([...TIMED_SUSPENSIONS_KEY, 'https://api.test'], []);
      api.listTimedSuspensions.mockRejectedValue(new Error('worker down'));
      const tree = (isSuspended: boolean) => (
        <QueryClientProvider client={qc}><TooltipProvider><UserActions pubkey={PUBKEY} isSuspended={isSuspended} /></TooltipProvider></QueryClientProvider>
      );
      const { rerender } = render(tree(false));
      suspendThroughDialog('3', 'days');
      await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: expect.stringMatching(/^User suspended/) })));
      rerender(tree(true)); // the host's status re-read lands
      expect(await screen.findByText('Suspended. End date unavailable')).toBeInTheDocument();
      expect(screen.queryByText('Suspended, no end date')).not.toBeInTheDocument();
    });

    it('cancelling the dialog suspends nothing', () => {
      renderWithProvider(<UserActions pubkey={PUBKEY} />, client());
      fireEvent.click(screen.getByRole('button', { name: /^Suspend User/i }));
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(api.suspendPubkey).not.toHaveBeenCalled();
    });
  });

  describe('end-time line', () => {
    it('shows when a suspended account\'s suspension ends', async () => {
      const endsAt = threeDaysOut();
      api.listTimedSuspensions.mockResolvedValue({ suspensions: [timer(endsAt)], autoLift: true });
      renderWithProvider(<UserActions pubkey={PUBKEY} isSuspended />, client());
      expect(await screen.findByText(`Suspended until ${formatSuspensionEnd(endsAt)}`)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Unsuspend User/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Change end date' })).toBeInTheDocument();
    });

    it('says the end date is unavailable when the timers could not be read', async () => {
      api.listTimedSuspensions.mockRejectedValue(new Error('worker down'));
      renderWithProvider(<UserActions pubkey={PUBKEY} isSuspended />, client());
      expect(await screen.findByText('Suspended. End date unavailable')).toBeInTheDocument();
      expect(screen.queryByText(/no end date/i)).not.toBeInTheDocument();
    });

    // F18: an underage report hands off to Age Review, which owns the
    // suspension; the end line and Change end date stay out of it.
    it('keeps the Age Review hand-off ahead of the end line for an underage report', async () => {
      api.listTimedSuspensions.mockResolvedValue({ suspensions: [timer(threeDaysOut())], autoLift: true });
      renderWithProvider(
        <UserActions pubkey={PUBKEY} context="report" reportCategory="NS-underageUser" isSuspended />, client());
      expect(screen.getByRole('button', { name: /Handle in Age Review/i })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Change end date' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Unsuspend User/i })).not.toBeInTheDocument();
      expect(screen.queryByText(/Suspended until|Checking suspension end date/)).not.toBeInTheDocument();
    });

    // St7: only a confirmed suspension shows an end. An unconfirmed status
    // (null) shows neither an end nor Change end date.
    it.each([[null], [false]] as const)('shows no end line or Change end date when isSuspended is %s', async (isSuspended) => {
      renderWithProvider(<UserActions pubkey={PUBKEY} isSuspended={isSuspended} />, client());
      expect(screen.queryByRole('button', { name: 'Change end date' })).not.toBeInTheDocument();
      expect(screen.queryByText(/Checking suspension end date|Suspended until|no end date/)).not.toBeInTheDocument();
      expect(api.listTimedSuspensions).not.toHaveBeenCalled();
    });

    it('shows no end line for a banned account', () => {
      renderWithProvider(<UserActions pubkey={PUBKEY} isBanned isSuspended />, client());
      expect(screen.queryByRole('button', { name: 'Change end date' })).not.toBeInTheDocument();
      expect(screen.queryByText(/Checking suspension end date/)).not.toBeInTheDocument();
    });
  });

  describe('Change end date', () => {
    function changeTo(length: string, unit: 'days' | 'hours') {
      fireEvent.click(screen.getByRole('button', { name: 'Change end date' }));
      const dialog = screen.getByRole('dialog');
      fireEvent.change(within(dialog).getByRole('combobox', { name: 'Unit' }), { target: { value: unit } });
      fireEvent.change(within(dialog).getByLabelText('Length'), { target: { value: length } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Change end date' }));
    }

    it.each([
      ['a lowercase account ID', PUBKEY],
      ['an uppercase account link', PUBKEY.toUpperCase()],
    ])('Change end date sends the new length through asModerator(token) for %s', async (_source, pubkey) => {
      const endsAt = threeDaysOut();
      api.changeSuspensionEnd.mockResolvedValue({ endsAt, decisionRecorded: true });
      renderWithProvider(<UserActions pubkey={pubkey} isSuspended />, client());
      changeTo('12', 'hours');
      await waitFor(() => expect(api.changeSuspensionEnd).toHaveBeenCalledWith(PUBKEY, { value: 12, unit: 'hours' }));
      expect(tokensFor(moderatorApi, 'changeSuspensionEnd')).toEqual([MOD_TOKEN]);
      await waitFor(() => expect(toast).toHaveBeenCalledWith({ title: `End date changed to ${formatSuspensionEnd(endsAt)}` }));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    });

    it('shows the current end in the dialog', async () => {
      const endsAt = threeDaysOut();
      api.listTimedSuspensions.mockResolvedValue({ suspensions: [timer(endsAt)], autoLift: true });
      renderWithProvider(<UserActions pubkey={PUBKEY} isSuspended />, client());
      await screen.findByText(`Suspended until ${formatSuspensionEnd(endsAt)}`);
      fireEvent.click(screen.getByRole('button', { name: 'Change end date' }));
      expect(within(screen.getByRole('dialog')).getByText(`Currently: ${formatSuspensionEnd(endsAt)}`)).toBeInTheDocument();
    });

    it('says "no end date" in the dialog for a suspension without a timer', async () => {
      renderWithProvider(<UserActions pubkey={PUBKEY} isSuspended />, client());
      await screen.findByText('Suspended, no end date');
      fireEvent.click(screen.getByRole('button', { name: 'Change end date' }));
      expect(within(screen.getByRole('dialog')).getByText('Currently: no end date')).toBeInTheDocument();
    });

    it('does not claim "no end date" in the dialog when the timers could not be read', async () => {
      api.listTimedSuspensions.mockRejectedValue(new Error('worker down'));
      renderWithProvider(<UserActions pubkey={PUBKEY} isSuspended />, client());
      await screen.findByText('Suspended. End date unavailable');
      fireEvent.click(screen.getByRole('button', { name: 'Change end date' }));
      expect(within(screen.getByRole('dialog')).queryByText(/^Currently:/)).not.toBeInTheDocument();
    });

    it('refreshes the timers, decision log and report queue after a change', async () => {
      const qc = client();
      const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
      const resetSpy = vi.spyOn(qc, 'resetQueries');
      renderWithProvider(<UserActions pubkey={PUBKEY} isSuspended />, qc);
      changeTo('12', 'hours');
      await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: expect.stringMatching(/^End date changed to/) })));
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['decisions'] });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['resolution-state'] });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['reports'] });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['reports-resolved'] });
      expect(resetSpy).toHaveBeenCalledWith({ queryKey: TIMED_SUSPENSIONS_KEY });
    });

    // Reset, not invalidate: a failed re-read after the change must show the
    // end as unavailable, not keep the old end on screen.
    it('shows the end as unavailable, not the old end, when the re-read after a change fails', async () => {
      const oldEnd = threeDaysOut();
      api.listTimedSuspensions.mockResolvedValueOnce({ suspensions: [timer(oldEnd)], autoLift: true }).mockRejectedValue(new Error('worker down'));
      renderWithProvider(<UserActions pubkey={PUBKEY} isSuspended />, client());
      await screen.findByText(`Suspended until ${formatSuspensionEnd(oldEnd)}`);
      changeTo('12', 'hours');
      expect(await screen.findByText('Suspended. End date unavailable')).toBeInTheDocument();
      expect(screen.queryByText(`Suspended until ${formatSuspensionEnd(oldEnd)}`)).not.toBeInTheDocument();
    });

    // The refusal says the panel's status is out of date; the host re-reads it
    // through the same onActionComplete it runs after any action here.
    it.each(['not_suspended', 'account_banned'] as const)('re-reads the account status after a %s refusal', async (code) => {
      api.changeSuspensionEnd.mockRejectedValue(new ApiError('server words', 409, 'Conflict', code));
      const onActionComplete = vi.fn();
      renderWithProvider(<UserActions pubkey={PUBKEY} isSuspended onActionComplete={onActionComplete} />, client());
      changeTo('12', 'hours');
      await waitFor(() => expect(onActionComplete).toHaveBeenCalledWith({ accountStatusChanged: false }));
      expect(onActionComplete).toHaveBeenCalledTimes(1);
    });

    it('does not re-read the account status for a refusal that says nothing about it', async () => {
      api.changeSuspensionEnd.mockRejectedValue(new ApiError('server words', 409, 'Conflict', 'conflict'));
      const onActionComplete = vi.fn();
      renderWithProvider(<UserActions pubkey={PUBKEY} isSuspended onActionComplete={onActionComplete} />, client());
      changeTo('12', 'hours');
      await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ variant: 'destructive' })));
      expect(onActionComplete).not.toHaveBeenCalled();
    });

    it('says the audit log was not recorded when the change saved without its decision row', async () => {
      const endsAt = threeDaysOut();
      api.changeSuspensionEnd.mockResolvedValue({ endsAt, decisionRecorded: false });
      renderWithProvider(<UserActions pubkey={PUBKEY} isSuspended />, client());
      changeTo('2', 'days');
      await waitFor(() => expect(toast).toHaveBeenCalledWith({
        title: 'Action applied; audit log not recorded',
        description: `End date changed to ${formatSuspensionEnd(endsAt)}`,
      }));
    });

    it.each([
      ['account_banned', 409, 'This account is banned. Unban it first.'],
      ['not_suspended', 409, 'This account is no longer suspended.'],
      ['suspension_ending', 409, 'This suspension is ending now. Check again in a few minutes.'],
      ['conflict', 409, 'Someone changed this suspension at the same time. Try again.'],
      ['status_unavailable', 503, 'Could not check the account\'s status. Try again.'],
      ['age_review_suspension', 409, 'This suspension is from age review, so it has no end date to change.'],
    ] as const)('a refusal with code %s toasts its own copy and keeps the dialog open', async (code, status, title) => {
      api.changeSuspensionEnd.mockRejectedValue(new ApiError('server words', status, 'x', code));
      renderWithProvider(<UserActions pubkey={PUBKEY} isSuspended />, client());
      changeTo('12', 'hours');
      await waitFor(() => expect(toast).toHaveBeenCalledWith({ title, variant: 'destructive' }));
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(navigate).not.toHaveBeenCalled();
    });

    it('routes an age-review refusal to the case', async () => {
      api.changeSuspensionEnd.mockRejectedValue(new ApiError('under age review', 409, 'Conflict', 'age_review_active'));
      renderWithProvider(<UserActions pubkey={PUBKEY} isSuspended />, client());
      changeTo('12', 'hours');
      await waitFor(() => expect(navigate).toHaveBeenCalledWith(`/age-review?pubkey=${PUBKEY}`));
      expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({ variant: 'destructive' }));
    });

    it('shows the server message for any other failure', async () => {
      api.changeSuspensionEnd.mockRejectedValue(new ApiError('Database not configured', 503, 'x', 'db_unavailable'));
      renderWithProvider(<UserActions pubkey={PUBKEY} isSuspended />, client());
      changeTo('12', 'hours');
      await waitFor(() => expect(toast).toHaveBeenCalledWith({
        title: 'Failed to change end date', description: 'Database not configured', variant: 'destructive',
      }));
    });
  });
});

// Unban of a banned account that is also suspended (or may be) asks what
// happens to the suspension; a confirmed not-suspended account unbans as before.
describe('UserActions unban prompt', () => {
  const client = () => new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 }, mutations: { retry: false } } });
  const timer = (endsAt: string | null, version = 5) => ({
    pubkey: PUBKEY, endsAt, status: 'cancelled_ban' as const, setBy: null, setAt: '2026-11-20T00:00:00.000Z', changedAt: null, version,
  });
  const clickUnban = () => fireEvent.click(screen.getByRole('button', { name: /Unban User/i }));
  // Confirm waits for the timers' first read (it sends the version shown), so wait for it.
  const confirmUnban = async () => {
    const button = within(screen.getByRole('dialog')).getByRole('button', { name: 'Unban' });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
  };

  it('banned and suspended: Unban opens the prompt, and End the suspension now sends end_now', async () => {
    const endsAt = threeDaysOut();
    api.listTimedSuspensions.mockResolvedValue({ suspensions: [timer(endsAt)], autoLift: true });
    api.unbanPubkey.mockResolvedValue({ suspension: { state: 'ended', endsAt: null, decisionRecorded: true } });
    renderWithProvider(<UserActions pubkey={PUBKEY} isBanned isSuspended />, client());
    clickUnban();
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Unban account' })).toBeInTheDocument();
    expect(api.unbanPubkey).not.toHaveBeenCalled();
    // The timer is read for a banned account that may be suspended, so the prompt names its end.
    expect(await within(dialog).findByLabelText(`Resume until ${formatSuspensionEnd(endsAt)}`)).toBeChecked();
    fireEvent.click(within(dialog).getByLabelText('End the suspension now'));
    await confirmUnban();
    // With the version of the timer the prompt showed, so a stale choice is refused.
    await waitFor(() => expect(api.unbanPubkey).toHaveBeenCalledWith(PUBKEY, 'end_now', 5));
    expect(tokensFor(moderatorApi, 'unbanPubkey')).toEqual([MOD_TOKEN]);
    await waitFor(() => expect(toast).toHaveBeenCalledWith({ title: 'User unbanned and unsuspended' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    // The browser's unban_user row stays.
    await waitFor(() => expect(api.logDecision).toHaveBeenCalledWith(expect.objectContaining({ action: 'unban_user', targetId: PUBKEY })));
  });

  // The host learns whether the unban ended the suspension, so a report pane can
  // drop what it kept from a Suspend; a suspension that continues changes nothing.
  it.each([
    ['ended', true],
    ['resumed', false],
    ['open_ended', false],
  ] as const)('reports to the host that the suspension ended: %s -> %s', async (state, ended) => {
    api.unbanPubkey.mockResolvedValue({ suspension: { state, endsAt: null, decisionRecorded: true } });
    const onActionComplete = vi.fn();
    renderWithProvider(<UserActions pubkey={PUBKEY} isBanned isSuspended onActionComplete={onActionComplete} />, client());
    clickUnban();
    await confirmUnban();
    await waitFor(() => expect(onActionComplete).toHaveBeenCalledWith(expect.objectContaining({ action: 'unban', accountStatusChanged: true })));
    expect(onActionComplete.mock.calls[0][0].suspensionEnded === true).toBe(ended);
  });

  // The prompt and the toast take the switch from the cached timers list.
  it.each([
    [true, 'Resume. The end date has passed, so it lifts at the next check',
      'User unbanned. The end date has passed, so the suspension lifts at the next check'],
    [false, 'Resume. The end date has passed, so unsuspend to lift it',
      'User unbanned. The end date has passed, so unsuspend to lift the suspension'],
    [undefined, 'Resume. The end date has passed, so unsuspend to lift it',
      'User unbanned. The end date has passed, so unsuspend to lift the suspension'],
  ])('a passed end with automatic lifting %s: the prompt and the toast say so', async (autoLift, label, title) => {
    const past = new Date(Math.floor((Date.now() - 86_400_000) / 60_000) * 60_000).toISOString();
    api.listTimedSuspensions.mockResolvedValue({ suspensions: [timer(past)], ...(autoLift !== undefined && { autoLift }) });
    api.unbanPubkey.mockResolvedValue({ suspension: { state: 'resumed', endsAt: past, decisionRecorded: true } });
    renderWithProvider(<UserActions pubkey={PUBKEY} isBanned isSuspended />, client());
    clickUnban();
    const dialog = screen.getByRole('dialog');
    expect(await within(dialog).findByLabelText(label)).toBeChecked();
    await confirmUnban();
    await waitFor(() => expect(toast).toHaveBeenCalledWith({ title }));
  });

  it('banned and confirmed not suspended: unbans with no prompt and no choice', async () => {
    renderWithProvider(<UserActions pubkey={PUBKEY} isBanned isSuspended={false} />, client());
    clickUnban();
    await waitFor(() => expect(api.unbanPubkey).toHaveBeenCalledWith(PUBKEY));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(toast).toHaveBeenCalledWith({ title: 'User unbanned' }));
    // No timer read for an account confirmed not suspended.
    expect(api.listTimedSuspensions).not.toHaveBeenCalled();
  });

  // St7: an unconfirmed suspension (null) asks, failing toward asking.
  it('banned with the suspension unconfirmed: the prompt is shown', async () => {
    renderWithProvider(<UserActions pubkey={PUBKEY} isBanned isSuspended={null} />, client());
    clickUnban();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(api.unbanPubkey).not.toHaveBeenCalled();
    // Unconfirmed, so the prompt does not state the suspension as fact.
    expect(screen.getByText('This account may also be suspended; its suspension status is not confirmed. Choose what happens to any suspension when the ban is lifted.')).toBeInTheDocument();
    expect(screen.queryByText('This account is also suspended. Choose what happens to the suspension when the ban is lifted.')).not.toBeInTheDocument();
  });

  it('banned and confirmed suspended: the prompt says it is suspended', () => {
    renderWithProvider(<UserActions pubkey={PUBKEY} isBanned isSuspended />, client());
    clickUnban();
    expect(screen.getByText('This account is also suspended. Choose what happens to the suspension when the ban is lifted.')).toBeInTheDocument();
    expect(screen.queryByText('This account may also be suspended; its suspension status is not confirmed. Choose what happens to any suspension when the ban is lifted.')).not.toBeInTheDocument();
  });

  // F5: the timers could not be read, so the prompt defaults to resume, which
  // keeps whatever end the server has, and says the end is unavailable.
  it('defaults to resume as it is when the timers cannot be read', async () => {
    api.listTimedSuspensions.mockRejectedValue(new Error('worker down'));
    renderWithProvider(<UserActions pubkey={PUBKEY} isBanned isSuspended />, client());
    clickUnban();
    const dialog = screen.getByRole('dialog');
    await waitFor(() => expect(api.listTimedSuspensions).toHaveBeenCalled());
    expect(within(dialog).getByLabelText('Resume the suspension as it is')).toBeChecked();
    expect(within(dialog).getByText('Suspended. End date unavailable')).toBeInTheDocument();
    await confirmUnban();
    await waitFor(() => expect(api.unbanPubkey).toHaveBeenCalledWith(PUBKEY, 'resume'));
  });

  // An older "no timer" copy whose refresh failed may predate a timed suspend: defaulting
  // to "no end date" from it could erase a real end, so the prompt treats it as unknown.
  it('defaults to resume as it is when a timer refresh failed over an older copy', async () => {
    api.listTimedSuspensions.mockResolvedValueOnce({ suspensions: [], autoLift: true });
    const qc = client();
    renderWithProvider(<UserActions pubkey={PUBKEY} isBanned isSuspended />, qc);
    await waitFor(() => expect(api.listTimedSuspensions).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(qc.getQueryState([...TIMED_SUSPENSIONS_KEY, 'https://api.test'])?.status).toBe('success'));
    api.listTimedSuspensions.mockRejectedValue(new Error('worker down'));
    await act(async () => { await qc.refetchQueries({ queryKey: TIMED_SUSPENSIONS_KEY }); });
    await waitFor(() => expect(qc.getQueryState([...TIMED_SUSPENSIONS_KEY, 'https://api.test'])?.status).toBe('error'));
    clickUnban();
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByLabelText('Resume the suspension as it is')).toBeChecked();
  });

  it('cancelling the prompt unbans nothing', () => {
    renderWithProvider(<UserActions pubkey={PUBKEY} isBanned isSuspended />, client());
    clickUnban();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(api.unbanPubkey).not.toHaveBeenCalled();
  });

  // ReportDetail keeps UserActions mounted across reports: a prompt opened for
  // one account must not unban the next one shown.
  it('closes the prompt when another account is shown', () => {
    const qc = client();
    const tree = (pk: string) => (
      <QueryClientProvider client={qc}><TooltipProvider><UserActions pubkey={pk} isBanned isSuspended /></TooltipProvider></QueryClientProvider>
    );
    const { rerender } = render(tree(PUBKEY));
    clickUnban();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    rerender(tree('b'.repeat(64)));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    // Back to the first account: the abandoned prompt stays closed (G6).
    rerender(tree(PUBKEY));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(api.unbanPubkey).not.toHaveBeenCalled();
  });

  // The prompt's Confirm takes the report shown at that click, like the direct
  // unban: an unban that finishes after the moderator opens another report
  // (same account or another) still names the report it was taken from.
  it.each([
    ['another account', 'b'.repeat(64)],
    ['the same account', PUBKEY],
  ])('reports the original post when a prompted unban finishes after switching to a report on %s', async (_label, nextPubkey) => {
    const original = { eventId: 'c'.repeat(64) };
    const next = { eventId: 'd'.repeat(64) };
    let finish!: (value: unknown) => void;
    api.unbanPubkey.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const onActionComplete = vi.fn();
    const qc = client();
    const tree = (pk: string, reportTarget: typeof original) => (
      <QueryClientProvider client={qc}>
        <TooltipProvider>
          <UserActions pubkey={pk} isBanned isSuspended reportTarget={reportTarget} onActionComplete={onActionComplete} />
        </TooltipProvider>
      </QueryClientProvider>
    );
    const { rerender } = render(tree(PUBKEY, original));
    clickUnban();
    fireEvent.click(within(screen.getByRole('dialog')).getByLabelText('End the suspension now'));
    await confirmUnban();
    await waitFor(() => expect(api.unbanPubkey).toHaveBeenCalledWith(PUBKEY, 'end_now', null)); // null: no timer shown

    rerender(tree(nextPubkey, next));
    finish({ suspension: { state: 'ended', endsAt: null, decisionRecorded: true } });

    await waitFor(() => expect(onActionComplete).toHaveBeenCalledTimes(1));
    expect(onActionComplete).toHaveBeenCalledWith({ accountStatusChanged: true, pubkey: PUBKEY, action: 'unban', reportTarget: original, suspensionEnded: true });
  });

  it.each([
    [{ suspension: { state: 'end_failed' } }, {
      title: 'User unbanned, but the suspension could not be lifted',
      description: 'It is still suspended. Try Unsuspend.', variant: 'destructive',
    }],
    [{ suspension: { state: 'unknown' } }, {
      title: 'User unbanned, but the suspension status could not be checked',
      description: 'Check the account before acting again.',
    }],
    [{ suspension: { state: 'none' }, choiceSkipped: 'non_canonical_pubkey' }, {
      title: 'User unbanned, but the suspension choice was not applied',
      description: 'Check the account before acting again.',
    }],
  ] as const)('toasts the outcome honestly (%#)', async (outcome, expected) => {
    api.unbanPubkey.mockResolvedValue(outcome);
    const onActionComplete = vi.fn();
    renderWithProvider(<UserActions pubkey={PUBKEY} isBanned isSuspended onActionComplete={onActionComplete} />, client());
    clickUnban();
    fireEvent.click(within(screen.getByRole('dialog')).getByLabelText('End the suspension now'));
    await confirmUnban();
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expected));
    expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({ title: 'User unbanned and unsuspended' }));
    // The ban was lifted whatever became of the suspension, so the host re-reads.
    await waitFor(() => expect(onActionComplete).toHaveBeenCalledWith({ accountStatusChanged: true, pubkey: PUBKEY, action: 'unban' }));
  });

  // The audit warning replaces the outcome toast (one shows at a time): an end_failed
  // must not vanish behind it or lose its severity (G4).
  it('keeps a destructive outcome on a failed audit write', async () => {
    api.unbanPubkey.mockResolvedValue({ suspension: { state: 'end_failed' } });
    api.logDecision.mockRejectedValue(new Error('audit down'));
    renderWithProvider(<UserActions pubkey={PUBKEY} isBanned isSuspended />, client());
    clickUnban();
    await confirmUnban();
    await waitFor(() => expect(toast).toHaveBeenLastCalledWith({
      title: 'User unbanned, but the suspension could not be lifted',
      description: 'It is still suspended. Try Unsuspend. Audit log not recorded.',
      variant: 'destructive',
    }));
  });

  it('carries a plain outcome on a failed audit write, saying the warning once', async () => {
    api.unbanPubkey.mockResolvedValue({ suspension: { state: 'ended', endsAt: null, decisionRecorded: false } });
    api.logDecision.mockRejectedValue(new Error('audit down'));
    renderWithProvider(<UserActions pubkey={PUBKEY} isBanned isSuspended />, client());
    clickUnban();
    await confirmUnban();
    await waitFor(() => expect(api.logDecision).toHaveBeenCalled());
    await waitFor(() => expect(toast).toHaveBeenCalledTimes(2));
    expect(toast).toHaveBeenLastCalledWith({ title: 'Action applied; audit log not recorded', description: 'User unbanned and unsuspended' });
  });

  // Reset, not invalidate: the unban may have ended or changed the timer, and a
  // failed re-read must not leave the old end on screen as current.
  it('resets the timers after an unban', async () => {
    const qc = client();
    const reset = vi.spyOn(qc, 'resetQueries');
    renderWithProvider(<UserActions pubkey={PUBKEY} isBanned isSuspended />, qc);
    clickUnban();
    await confirmUnban();
    await waitFor(() => expect(reset).toHaveBeenCalledWith({ queryKey: TIMED_SUSPENSIONS_KEY }));
  });

  it('stays open after a failed unban so the moderator can retry', async () => {
    api.unbanPubkey.mockRejectedValue(new ApiError('relay down', 502, 'Bad Gateway'));
    renderWithProvider(<UserActions pubkey={PUBKEY} isBanned isSuspended />, client());
    clickUnban();
    await confirmUnban();
    await waitFor(() => expect(toast).toHaveBeenCalledWith({ title: 'Failed to unban user', description: 'relay down', variant: 'destructive' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  // Ask again if it changed: the prompt showed no timer from a cached read while another
  // moderator set an end. The worker refuses; the timers are read again and the prompt asks
  // against the current end, with no "Failed to unban" toast, and the retry carries it.
  it('a suspension_changed refusal re-reads the timers and asks again against the current end', async () => {
    const endsAt = threeDaysOut();
    api.listTimedSuspensions.mockResolvedValueOnce({ suspensions: [], autoLift: true }).mockResolvedValue({ suspensions: [timer(endsAt, 6)], autoLift: true });
    api.unbanPubkey
      .mockRejectedValueOnce(new ApiError('changed', 409, 'Conflict', 'suspension_changed'))
      .mockResolvedValue({ suspension: { state: 'resumed', endsAt, decisionRecorded: true } });
    renderWithProvider(<UserActions pubkey={PUBKEY} isBanned isSuspended />, client());
    clickUnban();
    const dialog = screen.getByRole('dialog');
    expect(await within(dialog).findByLabelText('Keep suspended with no end date')).toBeChecked();
    await confirmUnban();
    await waitFor(() => expect(api.unbanPubkey).toHaveBeenCalledWith(PUBKEY, 'open_ended', null));

    expect(await within(dialog).findByText('The suspension changed after this was opened. Check the options below and confirm again.')).toBeInTheDocument();
    expect(await within(dialog).findByLabelText(`Resume until ${formatSuspensionEnd(endsAt)}`)).toBeChecked();
    expect(api.listTimedSuspensions).toHaveBeenCalledTimes(2);
    expect(toast).not.toHaveBeenCalled();

    await confirmUnban();
    await waitFor(() => expect(api.unbanPubkey).toHaveBeenLastCalledWith(PUBKEY, 'resume', 6));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  // Cancel stays enabled during the unban, and a closed prompt is unmounted, so it can't say
  // why nothing happened: the refusal is a toast instead, and the account is still banned.
  it('a suspension_changed refusal after the prompt was closed says so in a toast, once the timers are re-read', async () => {
    const REFUSED = 'The suspension changed after this was opened. Check the end date and confirm again.';
    const refusedToast = expect.objectContaining({ title: 'Failed to unban user', description: REFUSED });
    let reread!: (v: unknown) => void;
    api.listTimedSuspensions.mockResolvedValue({ suspensions: [], autoLift: true }).mockResolvedValueOnce({ suspensions: [], autoLift: true })
      .mockReturnValueOnce(new Promise(r => { reread = r; }));
    let refuse!: (e: unknown) => void;
    api.unbanPubkey.mockReturnValueOnce(new Promise((_, reject) => { refuse = reject; }));
    renderWithProvider(<UserActions pubkey={PUBKEY} isBanned isSuspended />, client());
    clickUnban();
    const dialog = screen.getByRole('dialog');
    await within(dialog).findByLabelText('Keep suspended with no end date');
    await confirmUnban();
    await waitFor(() => expect(api.unbanPubkey).toHaveBeenCalledWith(PUBKEY, 'open_ended', null));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await act(async () => { refuse(new ApiError(REFUSED, 409, 'Conflict', 'suspension_changed')); });
    await waitFor(() => expect(api.listTimedSuspensions).toHaveBeenCalledTimes(2));
    expect(toast).not.toHaveBeenCalledWith(refusedToast);

    await act(async () => { reread({ suspensions: [], autoLift: true }); });
    await waitFor(() => expect(toast).toHaveBeenCalledWith(refusedToast));
  });

  // Leaving the page with the prompt open unmounts it without a close: the refusal still
  // arrives (a mutation-level callback), and nothing on screen can say it but the toast.
  it('a suspension_changed refusal after the page unmounted with the prompt open is a toast', async () => {
    const REFUSED = 'The suspension changed after this was opened. Check the end date and confirm again.';
    api.listTimedSuspensions.mockResolvedValue({ suspensions: [], autoLift: true });
    let refuse!: (e: unknown) => void;
    api.unbanPubkey.mockReturnValueOnce(new Promise((_, reject) => { refuse = reject; }));
    const { unmount } = renderWithProvider(<UserActions pubkey={PUBKEY} isBanned isSuspended />, client());
    clickUnban();
    await within(screen.getByRole('dialog')).findByLabelText('Keep suspended with no end date');
    await confirmUnban();
    await waitFor(() => expect(api.unbanPubkey).toHaveBeenCalledWith(PUBKEY, 'open_ended', null));
    unmount();

    await act(async () => { refuse(new ApiError(REFUSED, 409, 'Conflict', 'suspension_changed')); });

    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Failed to unban user', description: REFUSED,
    })));
  });

  // A confirm before the timers' first read answers would carry no version and skip the check.
  it('blocks confirm while the timers are first loading', async () => {
    api.listTimedSuspensions.mockReturnValue(new Promise(() => {}));
    renderWithProvider(<UserActions pubkey={PUBKEY} isBanned isSuspended />, client());
    clickUnban();
    await waitFor(() => expect(api.listTimedSuspensions).toHaveBeenCalled());
    expect(within(screen.getByRole('dialog')).getByRole('button', { name: 'Unban' })).toBeDisabled();
  });

  // After a refusal the mutation stays pending until the timers are read again, so a confirm
  // cannot go out carrying the version that was just refused.
  it('keeps confirm disabled until the timers re-read after a suspension_changed refusal', async () => {
    const endsAt = threeDaysOut();
    let answer!: (v: unknown) => void;
    api.listTimedSuspensions.mockResolvedValueOnce({ suspensions: [], autoLift: true }).mockReturnValueOnce(new Promise(r => { answer = r; }));
    api.unbanPubkey.mockRejectedValueOnce(new ApiError('changed', 409, 'Conflict', 'suspension_changed'));
    renderWithProvider(<UserActions pubkey={PUBKEY} isBanned isSuspended />, client());
    clickUnban();
    const dialog = screen.getByRole('dialog');
    await within(dialog).findByLabelText('Keep suspended with no end date');
    await confirmUnban();
    await waitFor(() => expect(api.listTimedSuspensions).toHaveBeenCalledTimes(2));
    expect(within(dialog).getByRole('button', { name: 'Unbanning...' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeEnabled();
    await act(async () => { answer({ suspensions: [timer(endsAt, 6)], autoLift: true }); });
    expect(await within(dialog).findByLabelText(`Resume until ${formatSuspensionEnd(endsAt)}`)).toBeChecked();
    expect(within(dialog).getByRole('button', { name: 'Unban' })).toBeEnabled();
  });

  // The re-read failed: the prompt says the end is unavailable (F5), defaults to resume, and
  // the next confirm sends no version, since no timer is shown to compare against.
  it('a failed re-read after a suspension_changed refusal shows the end as unavailable and sends no version', async () => {
    api.listTimedSuspensions.mockResolvedValueOnce({ suspensions: [], autoLift: true }).mockRejectedValue(new Error('worker down'));
    api.unbanPubkey
      .mockRejectedValueOnce(new ApiError('changed', 409, 'Conflict', 'suspension_changed'))
      .mockResolvedValue({ suspension: { state: 'resumed', endsAt: null, decisionRecorded: true } });
    renderWithProvider(<UserActions pubkey={PUBKEY} isBanned isSuspended />, client());
    clickUnban();
    const dialog = screen.getByRole('dialog');
    await within(dialog).findByLabelText('Keep suspended with no end date');
    await confirmUnban();

    expect(await within(dialog).findByText('Suspended. End date unavailable')).toBeInTheDocument();
    expect(within(dialog).getByText('The suspension changed after this was opened. Check the options below and confirm again.')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Resume the suspension as it is')).toBeChecked();
    expect(toast).not.toHaveBeenCalled();
    await confirmUnban();
    await waitFor(() => expect(api.unbanPubkey).toHaveBeenLastCalledWith(PUBKEY, 'resume'));
  });

  it('routes an age-review refusal from the prompt to the case', async () => {
    api.unbanPubkey.mockRejectedValue(new ApiError('under age review', 409, 'Conflict', 'age_review_active'));
    renderWithProvider(<UserActions pubkey={PUBKEY} isBanned isSuspended />, client());
    clickUnban();
    await confirmUnban();
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(`/age-review?pubkey=${PUBKEY}`));
  });
});

// A Suspend from any host (the Users tab, age review, the report pane) must
// keep a banned-event read cached before it from showing the author's post
// outside the audited viewer (#445).
describe('UserActions suspend and cached banned-event reads', () => {
  const API = 'https://api.suspend.test';
  const ctx = { config: { relayUrl: 'wss://relay.suspend.test', apiUrl: API, theme: 'light' }, updateConfig: () => {} } as AppContextType;
  const EVENT = 'c'.repeat(64);
  const post = (pubkey: string): NostrEvent => ({ id: EVENT, pubkey, created_at: 1, kind: 1, tags: [], content: 'post', sig: 'b'.repeat(128) });
  const renderInEnv = (qc: QueryClient, ui: React.ReactElement) => render(
    <AppContext.Provider value={ctx}>
      <QueryClientProvider client={qc}><TooltipProvider>{ui}</TooltipProvider></QueryClientProvider>
    </AppContext.Provider>,
  );
  const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });

  it('taints and marks stale the suspended author\'s cached post, and no one else\'s', async () => {
    const qc = newClient();
    qc.setQueryData(bannedEventQueryKey(API, EVENT), post(PUBKEY));
    const strangerKey = bannedEventQueryKey(API, 'd'.repeat(64));
    qc.setQueryData(strangerKey, { ...post('9'.repeat(64)), id: 'd'.repeat(64) });
    renderInEnv(qc, <UserActions pubkey={PUBKEY} />);

    suspendThroughDialog();
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: expect.stringMatching(/^User suspended/) })));

    expect(isBannedEventReadTainted(qc, API, EVENT)).toBe(true);
    expect(qc.getQueryState(bannedEventQueryKey(API, EVENT))?.isInvalidated).toBe(true);
    expect(isBannedEventReadTainted(qc, API, 'd'.repeat(64))).toBe(false);
  });

  // The report pane handles its own Suspends (and keeps the post it shows), so
  // UserActions leaves it to the host there: one handling, not two.
  it('does not mark reads itself in the report context, where the pane does', async () => {
    const qc = newClient();
    qc.setQueryData(bannedEventQueryKey(API, EVENT), post(PUBKEY));
    renderInEnv(qc, <UserActions pubkey={PUBKEY} context="report" />);

    suspendThroughDialog();
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: expect.stringMatching(/^User suspended/) })));

    expect(isBannedEventReadTainted(qc, API, EVENT)).toBe(false);
  });

  // Pubkeys differ in case between hosts and relays; the author match ignores it.
  it.each([
    ['an uppercase account on the action', 'A'.repeat(64), 'a'.repeat(64)],
    ['an uppercase author on the cached post', 'a'.repeat(64), 'A'.repeat(64)],
  ])('matches the author by pubkey regardless of case: %s', async (_name, actionPubkey, postPubkey) => {
    const qc = newClient();
    qc.setQueryData(bannedEventQueryKey(API, EVENT), post(postPubkey));
    renderInEnv(qc, <UserActions pubkey={actionPubkey} />);

    suspendThroughDialog();
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: expect.stringMatching(/^User suspended/) })));

    expect(isBannedEventReadTainted(qc, API, EVENT)).toBe(true);
  });

  // The environment is the one the click happened in, as for the restore window.
  it('marks the environment the suspend started in, even if it lands after a switch', async () => {
    const OTHER = 'https://api.switched.test';
    let land: (v: unknown) => void = () => {};
    api.suspendPubkey.mockImplementation(() => new Promise(r => { land = r; }));
    const qc = newClient();
    qc.setQueryData(bannedEventQueryKey(API, EVENT), post(PUBKEY));
    qc.setQueryData(bannedEventQueryKey(OTHER, EVENT), post(PUBKEY));
    const tree = (apiUrl: string) => (
      <AppContext.Provider value={{ ...ctx, config: { ...ctx.config, apiUrl } }}>
        <QueryClientProvider client={qc}><TooltipProvider><UserActions pubkey={PUBKEY} /></TooltipProvider></QueryClientProvider>
      </AppContext.Provider>
    );
    const { rerender } = render(tree(API));
    suspendThroughDialog();
    await waitFor(() => expect(api.suspendPubkey).toHaveBeenCalled());
    rerender(tree(OTHER));
    await act(async () => { land({ endsAt: threeDaysOut(), recorded: true, decisionRecorded: true }); });
    await waitFor(() => expect(isBannedEventReadTainted(qc, API, EVENT)).toBe(true));
    expect(isBannedEventReadTainted(qc, OTHER, EVENT)).toBe(false);
  });

  // A suspend that errors or times out may still have applied: one re-read is
  // the cost of guessing wrong the other way. In every context, the report
  // pane included, which hears nothing from a failed action.
  it.each(['users', 'report'] as const)('marks the read even when the suspend fails, in the %s context', async (context) => {
    api.suspendPubkey.mockRejectedValue(new Error('relay down'));
    const qc = newClient();
    qc.setQueryData(bannedEventQueryKey(API, EVENT), post(PUBKEY));
    renderInEnv(qc, <UserActions pubkey={PUBKEY} context={context} />);

    suspendThroughDialog();
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Failed to suspend user' })));

    expect(isBannedEventReadTainted(qc, API, EVENT)).toBe(true);
  });

  it('marks the environment a failed suspend started in, even if it fails after a switch', async () => {
    const OTHER = 'https://api.switched.fail.test';
    let fail: (e: Error) => void = () => {};
    api.suspendPubkey.mockImplementation(() => new Promise((_, reject) => { fail = reject; }));
    const qc = newClient();
    qc.setQueryData(bannedEventQueryKey(API, EVENT), post(PUBKEY));
    qc.setQueryData(bannedEventQueryKey(OTHER, EVENT), post(PUBKEY));
    const tree = (apiUrl: string) => (
      <AppContext.Provider value={{ ...ctx, config: { ...ctx.config, apiUrl } }}>
        <QueryClientProvider client={qc}><TooltipProvider><UserActions pubkey={PUBKEY} /></TooltipProvider></QueryClientProvider>
      </AppContext.Provider>
    );
    const { rerender } = render(tree(API));
    suspendThroughDialog();
    await waitFor(() => expect(api.suspendPubkey).toHaveBeenCalled());
    rerender(tree(OTHER));
    await act(async () => { fail(new Error('timed out')); });
    await waitFor(() => expect(isBannedEventReadTainted(qc, API, EVENT)).toBe(true));
    expect(isBannedEventReadTainted(qc, OTHER, EVENT)).toBe(false);
  });
});
