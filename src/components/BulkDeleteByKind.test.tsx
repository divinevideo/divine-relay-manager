import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BulkDeleteByKind } from './BulkDeleteByKind';
import { ApiError } from '@/lib/adminApi';

const api = vi.hoisted(() => ({
  bulkModerate: vi.fn(),
  getBulkJobStatus: vi.fn(),
  getBulkKindCounts: vi.fn(),
}));
const toast = vi.hoisted(() => vi.fn());
const navigate = vi.hoisted(() => vi.fn());

vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()),
  useNavigate: () => navigate,
}));
vi.mock('@/hooks/useAdminApi', () => ({ useAdminApi: () => api }));
vi.mock('@/hooks/useToast', () => ({ useToast: () => ({ toast }) }));

const PUBKEY = 'a'.repeat(64);
const MODERATOR = 'd'.repeat(64);
const REPORT_ID = 'f'.repeat(64);

function job(over: Partial<Record<string, unknown>> = {}) {
  return {
    jobId: 'job-1', pubkey: PUBKEY, action: 'delete-kind', kind: 7, status: 'done',
    eventsProcessed: 3, mediaProcessed: 0, failures: [], createdAt: 't', updatedAt: 't', ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  api.getBulkKindCounts.mockResolvedValue({ counts: { 1: 800, 7: 3 }, complete: true });
  api.bulkModerate.mockResolvedValue({ success: true, jobId: 'job-1' });
  api.getBulkJobStatus.mockResolvedValue(job());
});

function renderDialog(props: Partial<React.ComponentProps<typeof BulkDeleteByKind>> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <BulkDeleteByKind pubkey={PUBKEY} {...props} />
    </QueryClientProvider>,
  );
}

async function openAndPickReactions() {
  fireEvent.click(screen.getByRole('button', { name: /Bulk Delete by Kind/i }));
  fireEvent.click(await screen.findByRole('button', { name: /Reaction \(3\)/ }));
}

describe('BulkDeleteByKind', () => {
  it('shows exact counts from a complete listing', async () => {
    renderDialog();
    await openAndPickReactions();

    expect(screen.getByText(/Found/)).toHaveTextContent('Found 3 Reaction events to delete');
    expect(screen.queryByText(/at least/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete 3 Events' })).toBeEnabled();
    expect(api.getBulkKindCounts).toHaveBeenCalledWith(PUBKEY);
  });

  it('shows counts from a cut-short listing as a lower bound, with a note', async () => {
    api.getBulkKindCounts.mockResolvedValue({ counts: { 1: 800, 7: 3 }, complete: false });
    renderDialog();
    fireEvent.click(screen.getByRole('button', { name: /Bulk Delete by Kind/i }));
    fireEvent.click(await screen.findByRole('button', { name: /Reaction \(3\+\)/ }));

    expect(screen.getByText(/Found/)).toHaveTextContent('Found at least 3 Reaction events to delete');
    expect(screen.getByText(/could not be listed in full/i)).toBeInTheDocument();
  });

  it('keeps Delete available for a kind the cut-short listing did not reach', async () => {
    api.getBulkKindCounts.mockResolvedValue({ counts: { 1: 800 }, complete: false });
    renderDialog();
    fireEvent.click(screen.getByRole('button', { name: /Bulk Delete by Kind/i }));
    await screen.findByRole('button', { name: /Text Note \(800\+\)/ });

    // Default kind (34235) has no count, but the listing stopped short.
    expect(screen.getByText(/Found/)).toHaveTextContent('Found at least 0');
    expect(screen.getByRole('button', { name: /^Delete/ })).toBeEnabled();
  });

  it('disables Delete when a complete listing has no events of the kind', async () => {
    renderDialog();
    fireEvent.click(screen.getByRole('button', { name: /Bulk Delete by Kind/i }));
    await screen.findByRole('button', { name: /Reaction \(3\)/ });

    expect(screen.getByRole('button', { name: 'Delete 0 Events' })).toBeDisabled();
  });

  // The relay hides every event of a banned or suspended account from REQ, so
  // its listing reads as empty. That must never look like "no events".
  it.each([
    ['banned', { isBanned: true, isSuspended: false }],
    ['suspended', { isBanned: false, isSuspended: true }],
  ])('for a %s account, says its content cannot be listed and disables Delete', async (_label, status) => {
    renderDialog(status);
    fireEvent.click(screen.getByRole('button', { name: /Bulk Delete by Kind/i }));

    expect(await screen.findByText(
      /The relay doesn't list a banned or suspended account's content, so it can't be counted or deleted here/,
    )).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Delete/ })).toBeDisabled();
    expect(screen.queryByText(/Found/)).not.toBeInTheDocument();
    expect(api.getBulkKindCounts).not.toHaveBeenCalled();
  });

  it('disables Delete when the account turns out to be banned after counts loaded', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const { rerender } = render(
      <QueryClientProvider client={qc}><BulkDeleteByKind pubkey={PUBKEY} isBanned={null} /></QueryClientProvider>,
    );
    await openAndPickReactions();
    expect(screen.getByRole('button', { name: 'Delete 3 Events' })).toBeEnabled();

    rerender(<QueryClientProvider client={qc}><BulkDeleteByKind pubkey={PUBKEY} isBanned={true} /></QueryClientProvider>);

    expect(screen.getByText(/can't be counted or deleted here/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Delete/ })).toBeDisabled();
  });

  it('does not present zero as a confirmed absence when the account status is unknown', async () => {
    renderDialog({ isBanned: null, isSuspended: null });
    fireEvent.click(screen.getByRole('button', { name: /Bulk Delete by Kind/i }));
    await screen.findByRole('button', { name: /Reaction \(3\)/ });

    // Default kind (34235) has none in a complete listing.
    expect(screen.getByText(/No .* events found/)).toHaveTextContent(
      "No Video (Addressable) events found. If this account is banned or suspended, its content isn't listed.",
    );
    expect(screen.queryByText(/Found 0/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete 0 Events' })).toBeDisabled();
  });

  it('treats a status it was not given as unknown', async () => {
    renderDialog();
    fireEvent.click(screen.getByRole('button', { name: /Bulk Delete by Kind/i }));
    await screen.findByRole('button', { name: /Reaction \(3\)/ });

    expect(screen.getByText(/If this account is banned or suspended, its content isn't listed/)).toBeInTheDocument();
  });

  it('keeps the caveat when only one of the two statuses is known', async () => {
    renderDialog({ isBanned: false, isSuspended: null });
    fireEvent.click(screen.getByRole('button', { name: /Bulk Delete by Kind/i }));
    await screen.findByRole('button', { name: /Reaction \(3\)/ });

    expect(screen.getByText(/If this account is banned or suspended, its content isn't listed/)).toBeInTheDocument();
  });

  it('reports zero plainly for an account known to be neither banned nor suspended', async () => {
    renderDialog({ isBanned: false, isSuspended: false });
    fireEvent.click(screen.getByRole('button', { name: /Bulk Delete by Kind/i }));
    await screen.findByRole('button', { name: /Reaction \(3\)/ });

    expect(screen.getByText(/No .* events found/)).toHaveTextContent('No Video (Addressable) events found.');
    expect(screen.queryByText(/banned or suspended/)).not.toBeInTheDocument();
  });

  it('says so and keeps Delete disabled when the count fails', async () => {
    api.getBulkKindCounts.mockRejectedValue(new Error('relay down'));
    renderDialog();
    fireEvent.click(screen.getByRole('button', { name: /Bulk Delete by Kind/i }));

    expect(await screen.findByText(/Could not count this account's events/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Delete/ })).toBeDisabled();
  });

  it('starts a kind-scoped job carrying the moderator, report, and reason', async () => {
    api.getBulkJobStatus.mockResolvedValue(job({ status: 'running', eventsProcessed: 0 }));
    renderDialog({ reportId: REPORT_ID, getModeratorPubkey: async () => MODERATOR });
    await openAndPickReactions();
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'spam' } });

    fireEvent.click(screen.getByRole('button', { name: 'Delete 3 Events' }));

    await waitFor(() => expect(api.bulkModerate).toHaveBeenCalledWith(
      PUBKEY, 'delete-kind', 'spam', { kind: 7, moderatorPubkey: MODERATOR, reportId: REPORT_ID },
    ));
  });

  it('starts one job when Delete is clicked twice while the moderator resolves', async () => {
    api.getBulkJobStatus.mockResolvedValue(job({ status: 'running', eventsProcessed: 0 }));
    let release: (pubkey: string) => void = () => {};
    const identity = new Promise<string>((resolve) => { release = resolve; });
    renderDialog({ getModeratorPubkey: () => identity });
    await openAndPickReactions();

    const deleteButton = screen.getByRole('button', { name: 'Delete 3 Events' });
    fireEvent.click(deleteButton);
    fireEvent.click(deleteButton);
    release(MODERATOR);

    await waitFor(() => expect(api.bulkModerate).toHaveBeenCalled());
    await screen.findByText(/closing this dialog does not stop it/i);
    expect(api.bulkModerate).toHaveBeenCalledTimes(1);
  });

  it('shows progress from the job status and says closing does not stop it', async () => {
    api.getBulkJobStatus.mockResolvedValue(job({ status: 'running', eventsProcessed: 2 }));
    renderDialog();
    await openAndPickReactions();

    fireEvent.click(screen.getByRole('button', { name: 'Delete 3 Events' }));

    expect(await screen.findByText('Deleted 2 of 3 events...')).toBeInTheDocument();
    expect(screen.getByText(/closing this dialog does not stop it/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close' })).toBeEnabled();
    expect(screen.getByRole('button', { name: /Deleting/ })).toBeDisabled();
    expect(toast).not.toHaveBeenCalled();
  });

  it('reports a complete job as done and closes', async () => {
    const onComplete = vi.fn();
    renderDialog({ onComplete });
    await openAndPickReactions();

    fireEvent.click(screen.getByRole('button', { name: 'Delete 3 Events' }));

    await waitFor(() => expect(toast).toHaveBeenCalledWith({
      title: 'Bulk delete complete',
      description: 'Deleted 3 Reaction events',
    }));
    expect(onComplete).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  });

  it('reports a job that finished with failures without saying it is done', async () => {
    api.getBulkJobStatus.mockResolvedValue(job({
      eventsProcessed: 1,
      failures: ['event:x:banevent failed', 'event:y:banevent failed'],
    }));
    renderDialog();
    await openAndPickReactions();

    fireEvent.click(screen.getByRole('button', { name: 'Delete 3 Events' }));

    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Bulk delete finished with issues',
      variant: 'destructive',
    })));
    const { description } = toast.mock.calls[0][0] as { description: string };
    expect(description).toMatch(/Deleted 1 of 3 Reaction events/);
    expect(description).toMatch(/2 failed or could not be listed/);
    expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({ title: 'Bulk delete complete' }));
    // The dialog stays open with the outcome.
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByText(/finished with issues/i)).toBeInTheDocument();
  });

  it('counts the overflow marker when it reports how many failed', async () => {
    api.getBulkJobStatus.mockResolvedValue(job({
      eventsProcessed: 0,
      failures: ['event:x:boom', '+60 more'],
    }));
    renderDialog();
    await openAndPickReactions();

    fireEvent.click(screen.getByRole('button', { name: 'Delete 3 Events' }));

    await waitFor(() => expect(toast).toHaveBeenCalled());
    const { description } = toast.mock.calls[0][0] as { description: string };
    expect(description).toMatch(/61 failed or could not be listed/);
  });

  it('reports a job that stopped early as stopped, with what it got through', async () => {
    api.getBulkJobStatus.mockResolvedValue(job({
      status: 'failed', eventsProcessed: 1, failures: ['job:abandoned (no terminal update; worker likely evicted mid-run)'],
    }));
    renderDialog();
    await openAndPickReactions();

    fireEvent.click(screen.getByRole('button', { name: 'Delete 3 Events' }));

    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Bulk delete stopped early',
      variant: 'destructive',
    })));
    const { description } = toast.mock.calls[0][0] as { description: string };
    expect(description).toMatch(/Deleted 1 of 3 Reaction events before it stopped/);
    expect(description).toMatch(/abandoned/);
  });

  it('routes to the age-review case when the worker refuses the job', async () => {
    api.bulkModerate.mockRejectedValue(new ApiError('under age review', 409, 'Conflict', 'age_review_active'));
    renderDialog();
    await openAndPickReactions();

    fireEvent.click(screen.getByRole('button', { name: 'Delete 3 Events' }));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith(`/age-review?pubkey=${PUBKEY}`));
    expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({ title: 'Bulk delete failed' }));
  });

  it('shows an error when the job cannot be started', async () => {
    api.bulkModerate.mockRejectedValue(new Error('queue down'));
    renderDialog();
    await openAndPickReactions();

    fireEvent.click(screen.getByRole('button', { name: 'Delete 3 Events' }));

    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Bulk delete failed', description: 'queue down', variant: 'destructive',
    })));
  });
});
