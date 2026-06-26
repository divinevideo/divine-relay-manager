import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UserActions } from './UserActions';

// Stable mocks so async-flow tests can control enqueue + status polling and
// assert on the same fn instances.
const api = vi.hoisted(() => ({
  bulkModerate: vi.fn(),
  getBulkJobStatus: vi.fn(),
  banPubkey: vi.fn(),
  unbanPubkey: vi.fn(),
  suspendPubkey: vi.fn(),
  unsuspendPubkey: vi.fn(),
  logDecision: vi.fn(),
}));
const toast = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/useAdminApi', () => ({ useAdminApi: () => api }));
vi.mock('@/hooks/useToast', () => ({ useToast: () => ({ toast }) }));

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
});
