import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UserActions } from './UserActions';
import { ApiError } from '@/lib/adminApi';

// Stable mocks so async-flow tests can control enqueue + status polling and
// assert on the same fn instances.
const api = vi.hoisted(() => ({
  bulkModerate: vi.fn(),
  getBulkJobStatus: vi.fn(),
  banPubkey: vi.fn(),
  unbanPubkey: vi.fn(),
  suspendPubkey: vi.fn(),
  unsuspendPubkey: vi.fn(),
  getActiveAgeReviewCase: vi.fn(),
  logDecision: vi.fn(),
}));
const toast = vi.hoisted(() => vi.fn());

const navigate = vi.hoisted(() => vi.fn());
vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()),
  useNavigate: () => navigate,
}));

vi.mock('@/hooks/useAdminApi', () => ({ useAdminApi: () => api }));
vi.mock('@/hooks/useToast', () => ({ useToast: () => ({ toast }) }));
// Logged-in moderator, so audit writes carry attribution (#178).
const MOD_PUBKEY = 'e'.repeat(64);
vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ user: { pubkey: MOD_PUBKEY }, getModeratorPubkey: async () => MOD_PUBKEY }),
}));

const PUBKEY = 'a'.repeat(64);

function doneJob(action: 'age-restrict-all' | 'delete-all', over: Partial<Record<string, unknown>> = {}) {
  return {
    jobId: 'job-1', pubkey: PUBKEY, action, status: 'done',
    eventsProcessed: 3, mediaProcessed: 2, failures: [], createdAt: 't', updatedAt: 't', ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  api.bulkModerate.mockResolvedValue({ success: true, jobId: 'job-1' });
  api.getBulkJobStatus.mockResolvedValue(doneJob('age-restrict-all'));
  api.banPubkey.mockResolvedValue({ success: true });
  api.unbanPubkey.mockResolvedValue({ success: true });
  api.suspendPubkey.mockResolvedValue({ success: true });
  api.unsuspendPubkey.mockResolvedValue({ success: true });
  api.getActiveAgeReviewCase.mockResolvedValue({ success: true, case: null });
  api.logDecision.mockResolvedValue(undefined);
});

function renderWithProvider(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
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
    fireEvent.click(screen.getByRole('button', { name: /Suspend User/i }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(`/age-review?pubkey=${PUBKEY}`));
  });

  it('attributes the audit write to the logged-in moderator (#178)', async () => {
    renderWithProvider(<UserActions pubkey={PUBKEY} />);
    fireEvent.click(screen.getByRole('button', { name: /Suspend User/i }));
    await waitFor(() => expect(api.suspendPubkey).toHaveBeenCalled());
    await waitFor(() =>
      expect(api.logDecision).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'suspend_user', moderatorPubkey: MOD_PUBKEY }),
      ),
    );
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

  it('age-restrict enqueues, polls to completion, toasts the result, and calls onActionComplete', async () => {
    api.getBulkJobStatus.mockResolvedValue(doneJob('age-restrict-all'));
    const onActionComplete = vi.fn();
    renderWithProvider(<UserActions pubkey={PUBKEY} onActionComplete={onActionComplete} />);

    fireEvent.click(screen.getByRole('button', { name: /Age Restrict All/i }));

    await waitFor(() =>
      expect(api.bulkModerate).toHaveBeenCalledWith(PUBKEY, 'age-restrict-all', expect.any(String)),
    );
    await waitFor(() => expect(api.getBulkJobStatus).toHaveBeenCalledWith('job-1'));
    await waitFor(() => expect(onActionComplete).toHaveBeenCalledTimes(1));
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: expect.stringMatching(/Age-restricted 2 media file\(s\) across 3 events/i) }),
    );
  });

  it('reports a partial/failed job with a destructive toast', async () => {
    api.getBulkJobStatus.mockResolvedValue(doneJob('age-restrict-all', { status: 'failed', failures: ['media:x:boom'] }));
    renderWithProvider(<UserActions pubkey={PUBKEY} />);

    fireEvent.click(screen.getByRole('button', { name: /Age Restrict All/i }));

    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({ title: expect.stringMatching(/finished with issues/i), variant: 'destructive' }),
      ),
    );
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
      .mockResolvedValueOnce(doneJob('age-restrict-all', { status: 'running', mediaProcessed: 0, eventsProcessed: 0 }))
      .mockResolvedValue(doneJob('age-restrict-all'));
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

  it('surfaces a persistent status-poll failure (worker unreachable) and re-enables the buttons', async () => {
    api.getBulkJobStatus.mockRejectedValue(new Error('Network connection lost'));
    renderWithProvider(<UserActions pubkey={PUBKEY} />);

    fireEvent.click(screen.getByRole('button', { name: /Age Restrict All/i }));

    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Bulk action failed', variant: 'destructive' }),
      ),
    );
    // Not stuck polling/disabled: the button returns to its idle label.
    await waitFor(() => expect(screen.getByRole('button', { name: /^Age Restrict All$/i })).toBeEnabled());
  });

  it('keeps the destructive button disabled while a job stays non-terminal (no fixed-timer re-enable)', async () => {
    // A chunked job can legitimately run longer than any client timer. The button
    // must NOT re-enable on a timer (which would let a moderator start a second,
    // duplicate destructive job); it stays in the running state until the worker
    // reports terminal. Verifies the removal of the 10-minute give-up.
    vi.useFakeTimers();
    try {
      api.getBulkJobStatus.mockResolvedValue(doneJob('age-restrict-all', { status: 'running', mediaProcessed: 0, eventsProcessed: 0 }));
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
    api.getBulkJobStatus.mockResolvedValue(doneJob('age-restrict-all', { status: 'running', mediaProcessed: 0, eventsProcessed: 0 }));
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
    // Suspend/age-restrict resolution comes only from the D1 decision row, and the
    // onSuccess refetch races the fire-and-forget write. The invalidation must fire
    // AFTER the write resolves (not before), so the report converges on its own.
    let resolveWrite!: () => void;
    api.logDecision.mockReturnValue(new Promise<void>((r) => { resolveWrite = () => r(undefined); }));

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const decisionsInvalidations = () => invalidateSpy.mock.calls.filter(
      ([arg]) => (arg as { queryKey?: unknown[] })?.queryKey?.[0] === 'decisions',
    ).length;

    render(
      <QueryClientProvider client={qc}>
        <TooltipProvider><UserActions pubkey={'a'.repeat(64)} /></TooltipProvider>
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: /Suspend User/i }));

    await waitFor(() => expect(api.logDecision).toHaveBeenCalledTimes(1));
    expect(decisionsInvalidations()).toBe(0); // write hasn't landed yet — report stays unresolved

    resolveWrite();

    await waitFor(() => expect(decisionsInvalidations()).toBe(1));
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['decisions'] });
  });

  it('closes the ban dialog on success (the alertdialog is removed)', async () => {
    // The real symptom of the hang bug is the dialog never closing; assert it's gone.
    renderWithProvider(<UserActions pubkey={'a'.repeat(64)} />);
    fireEvent.click(screen.getByRole('button', { name: /Ban User/i }));
    const dialog = screen.getByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Ban User' }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  });

  it('surfaces a ban timeout as an error toast and keeps the dialog open for retry', async () => {
    api.banPubkey.mockRejectedValue(
      new Error("Relay RPC 'banpubkey' timed out after 30s. The action may still have applied. Re-check before retrying."),
    );
    renderWithProvider(<UserActions pubkey={'a'.repeat(64)} />);
    fireEvent.click(screen.getByRole('button', { name: /Ban User/i }));
    const dialog = screen.getByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Ban User' }));

    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Failed to ban user', variant: 'destructive' }),
      ),
    );
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
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
});
