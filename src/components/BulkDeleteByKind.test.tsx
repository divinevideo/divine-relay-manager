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
const EVENT_ID = '1'.repeat(64);
const RERUN = "Running it again is safe; it only picks up what's left.";
const HIDDEN = "The relay doesn't list a banned or suspended account's content, so it can't be counted or deleted here.";

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

function renderDialog(
  props: Partial<React.ComponentProps<typeof BulkDeleteByKind>> = {},
  qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }),
) {
  return render(
    <QueryClientProvider client={qc}>
      <BulkDeleteByKind pubkey={PUBKEY} {...props} />
    </QueryClientProvider>,
  );
}

function open() {
  fireEvent.click(screen.getByRole('button', { name: /Bulk Delete by Kind/i }));
}

async function openAndPickReactions() {
  open();
  fireEvent.click(await screen.findByRole('button', { name: /Reaction \(3\)/ }));
}

function lastToast() {
  return toast.mock.calls[toast.mock.calls.length - 1][0] as { title: string; description: string; variant?: string };
}

describe('BulkDeleteByKind counts', () => {
  it('shows exact counts from a complete listing, and names the kind on the button', async () => {
    renderDialog();
    await openAndPickReactions();

    expect(screen.getByText(/Found/)).toHaveTextContent('Found 3 Reaction events to delete');
    expect(screen.queryByText(/at least/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete 3 Reaction events' })).toBeEnabled();
    expect(api.getBulkKindCounts).toHaveBeenCalledWith(PUBKEY);
  });

  it('says the delete cannot be undone and that media files stay', () => {
    renderDialog();
    open();

    expect(screen.getByText(
      'Deletes every event of the chosen kind from this user on the relay. This cannot be undone. Media files are not deleted; use Delete All Content to remove them.',
    )).toBeInTheDocument();
  });

  it('shows counts from a cut-short listing as a lower bound, with a note', async () => {
    api.getBulkKindCounts.mockResolvedValue({ counts: { 1: 800, 7: 3 }, complete: false });
    renderDialog();
    open();
    fireEvent.click(await screen.findByRole('button', { name: /Reaction \(3\+\)/ }));

    expect(screen.getByText(/Found/)).toHaveTextContent('Found at least 3 Reaction events to delete');
    expect(screen.getByText(/could not be listed in full/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete all Reaction events' })).toBeEnabled();
  });

  it('keeps Delete available for a kind the cut-short listing did not reach', async () => {
    api.getBulkKindCounts.mockResolvedValue({ counts: { 1: 800 }, complete: false });
    renderDialog();
    open();
    await screen.findByRole('button', { name: /Text Note \(800\+\)/ });

    // Default kind (34235) has no count, but the listing stopped short.
    expect(screen.getByText(
      'None found in the part of this account that could be listed. The delete searches this kind directly and may find more.',
    )).toBeInTheDocument();
    expect(screen.queryByText(/Found/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete all Video (Addressable) events' })).toBeEnabled();
  });

  it('disables Delete when a complete listing has no events of the kind', async () => {
    renderDialog();
    open();
    await screen.findByRole('button', { name: /Reaction \(3\)/ });

    expect(screen.getByRole('button', { name: 'Delete 0 Video (Addressable) events' })).toBeDisabled();
  });

  it('marks the selected kind chip as pressed', async () => {
    renderDialog();
    await openAndPickReactions();

    expect(screen.getByRole('button', { name: /Reaction \(3\)/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /Text Note \(800\)/ })).toHaveAttribute('aria-pressed', 'false');
  });

  it('shows the count error once, without repeating its lead-in', async () => {
    api.getBulkKindCounts.mockRejectedValue(new ApiError('Relay query failed', 502));
    renderDialog();
    open();

    expect(await screen.findByText(/Could not count this account's events/)).toHaveTextContent(
      "Could not count this account's events: Relay query failed. Delete is unavailable until the count loads.",
    );
    expect(screen.getByRole('button', { name: /^Delete/ })).toBeDisabled();
  });

  it('does not blame the relay when the count only took too long', async () => {
    api.getBulkKindCounts.mockRejectedValue(new ApiError(
      'Request to /api/bulk-moderate/kind-counts timed out after 30s. Could not reach the relay. Try again.',
      undefined, undefined, 'timeout',
    ));
    renderDialog();
    open();

    expect(await screen.findByText(/took too long/)).toHaveTextContent(
      "Counting this account's events took too long. Close and reopen this dialog to try again. Delete is unavailable until the count loads.",
    );
    expect(screen.queryByText(/Could not reach the relay/)).not.toBeInTheDocument();
  });

  it('does not retry a failed count', async () => {
    api.getBulkKindCounts.mockRejectedValue(new ApiError('Relay query failed', 502));
    // The app's default: retries on, here with no delay so a retry would be seen.
    renderDialog({}, new QueryClient({ defaultOptions: { queries: { retry: 3, retryDelay: 0 } } }));
    open();

    await screen.findByText(/Could not count this account's events/);
    expect(api.getBulkKindCounts).toHaveBeenCalledTimes(1);
  });
});

describe('BulkDeleteByKind account status', () => {
  // The relay hides every event of a banned or suspended account from REQ, so
  // its listing reads as empty. That must never look like "no events".
  it.each([
    ['banned', { isBanned: true, isSuspended: false }],
    ['suspended', { isBanned: false, isSuspended: true }],
  ])('for a %s account, says its content cannot be listed and disables Delete', async (_label, status) => {
    renderDialog(status);
    open();

    expect(await screen.findByText(HIDDEN)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Delete/ })).toBeDisabled();
    expect(screen.queryByText(/Found/)).not.toBeInTheDocument();
    expect(api.getBulkKindCounts).not.toHaveBeenCalled();
  });

  it('disables Delete when the account turns out to be banned after counts loaded', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const { rerender } = renderDialog({ isBanned: null }, qc);
    await openAndPickReactions();
    expect(screen.getByRole('button', { name: 'Delete 3 Reaction events' })).toBeEnabled();

    rerender(<QueryClientProvider client={qc}><BulkDeleteByKind pubkey={PUBKEY} isBanned={true} /></QueryClientProvider>);

    expect(screen.getByText(/can't be counted or deleted here/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Delete/ })).toBeDisabled();
  });

  it('does not present zero as a confirmed absence when the account status is unknown', async () => {
    renderDialog({ isBanned: null, isSuspended: null });
    open();
    await screen.findByRole('button', { name: /Reaction \(3\)/ });

    // Default kind (34235) has none in a complete listing.
    expect(screen.getByText(/No .* events found/)).toHaveTextContent(
      "No Video (Addressable) events found. If this account is banned or suspended, its content isn't listed.",
    );
    expect(screen.queryByText(/Found 0/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete 0 Video (Addressable) events' })).toBeDisabled();
  });

  it('treats a status it was not given as unknown', async () => {
    renderDialog();
    open();
    await screen.findByRole('button', { name: /Reaction \(3\)/ });

    expect(screen.getByText(/If this account is banned or suspended, its content isn't listed/)).toBeInTheDocument();
  });

  it('keeps the caveat when only one of the two statuses is known', async () => {
    renderDialog({ isBanned: false, isSuspended: null });
    open();
    await screen.findByRole('button', { name: /Reaction \(3\)/ });

    expect(screen.getByText(/If this account is banned or suspended, its content isn't listed/)).toBeInTheDocument();
  });

  it('reports zero plainly for an account known to be neither banned nor suspended', async () => {
    renderDialog({ isBanned: false, isSuspended: false });
    open();
    await screen.findByRole('button', { name: /Reaction \(3\)/ });

    expect(screen.getByText(/No .* events found/)).toHaveTextContent('No Video (Addressable) events found.');
    expect(screen.queryByText(/banned or suspended/)).not.toBeInTheDocument();
  });
});

describe('BulkDeleteByKind running a job', () => {
  it('starts a kind-scoped job carrying the moderator, report, and reason', async () => {
    api.getBulkJobStatus.mockResolvedValue(job({ status: 'running', eventsProcessed: 0 }));
    renderDialog({ reportId: REPORT_ID, getModeratorPubkey: async () => MODERATOR });
    await openAndPickReactions();
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'spam' } });

    fireEvent.click(screen.getByRole('button', { name: 'Delete 3 Reaction events' }));

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

    const deleteButton = screen.getByRole('button', { name: 'Delete 3 Reaction events' });
    fireEvent.click(deleteButton);
    fireEvent.click(deleteButton);
    release(MODERATOR);

    await waitFor(() => expect(api.bulkModerate).toHaveBeenCalled());
    await screen.findByText(/closing this dialog does not stop it/i);
    expect(api.bulkModerate).toHaveBeenCalledTimes(1);
  });

  it('shows progress from the job status, announced to assistive tech, and says closing does not stop it', async () => {
    api.getBulkJobStatus.mockResolvedValue(job({ status: 'running', eventsProcessed: 2 }));
    renderDialog();
    await openAndPickReactions();

    fireEvent.click(screen.getByRole('button', { name: 'Delete 3 Reaction events' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Deleted 2 of 3 events...');
    expect(screen.getByRole('progressbar', { name: 'Bulk delete progress' })).toBeInTheDocument();
    expect(screen.getByText(/closing this dialog does not stop it/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close' })).toBeEnabled();
    expect(screen.getByRole('button', { name: /Deleting/ })).toBeDisabled();
    expect(toast).not.toHaveBeenCalled();
  });

  it('routes to the age-review case when the worker refuses the job', async () => {
    api.bulkModerate.mockRejectedValue(new ApiError('under age review', 409, 'Conflict', 'age_review_active'));
    renderDialog();
    await openAndPickReactions();

    fireEvent.click(screen.getByRole('button', { name: 'Delete 3 Reaction events' }));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith(`/age-review?pubkey=${PUBKEY}`));
    expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({ title: 'Bulk delete failed' }));
  });

  it('shows an error when the job cannot be started', async () => {
    api.bulkModerate.mockRejectedValue(new Error('queue down'));
    renderDialog();
    await openAndPickReactions();

    fireEvent.click(screen.getByRole('button', { name: 'Delete 3 Reaction events' }));

    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Bulk delete failed', description: 'queue down', variant: 'destructive',
    })));
  });
});

describe('BulkDeleteByKind progress past the count', () => {
  it('drops "of Y" from the progress line once more than the count are deleted', async () => {
    api.getBulkJobStatus.mockResolvedValue(job({ status: 'running', eventsProcessed: 5 }));
    renderDialog();
    await openAndPickReactions();

    fireEvent.click(screen.getByRole('button', { name: 'Delete 3 Reaction events' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Deleted 5 events...');
  });

  it('drops "of at least 0" from the progress line against an incomplete zero', async () => {
    api.getBulkKindCounts.mockResolvedValue({ counts: { 1: 800 }, complete: false });
    api.getBulkJobStatus.mockResolvedValue(job({ kind: 34235, status: 'running', eventsProcessed: 2 }));
    renderDialog();
    open();
    await screen.findByRole('button', { name: /Text Note \(800\+\)/ });

    fireEvent.click(screen.getByRole('button', { name: 'Delete all Video (Addressable) events' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Deleted 2 events...');
  });
});

describe('BulkDeleteByKind lost track of the job', () => {
  const LOST_BODY = 'It may still be running on the server. Wait a minute and reopen this dialog to check before running it again.';

  it('says it lost track, not that the job failed, and keeps Delete off', async () => {
    api.getBulkJobStatus
      .mockResolvedValueOnce(job({ status: 'running', eventsProcessed: 1 }))
      .mockRejectedValue(new ApiError('Service Unavailable', 503));
    renderDialog();
    await openAndPickReactions();

    fireEvent.click(screen.getByRole('button', { name: 'Delete 3 Reaction events' }));

    await waitFor(() => expect(toast).toHaveBeenCalledWith({ title: 'Lost track of the bulk delete', description: LOST_BODY }), { timeout: 4000 });
    expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({ title: 'Bulk delete failed' }));
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByText('Lost track of the bulk delete')).toBeInTheDocument();
    expect(within(dialog).getByText(LOST_BODY)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete 3 Reaction events' })).toBeDisabled();
  });

  it('"Check again" re-reads the job and reports its real outcome', async () => {
    api.getBulkJobStatus.mockRejectedValueOnce(new ApiError('Service Unavailable', 503));
    renderDialog();
    await openAndPickReactions();
    fireEvent.click(screen.getByRole('button', { name: 'Delete 3 Reaction events' }));
    const checkAgain = await screen.findByRole('button', { name: 'Check again' });

    fireEvent.click(checkAgain);

    await waitFor(() => expect(toast).toHaveBeenCalledWith({ title: 'Bulk delete complete', description: 'Deleted 3 Reaction events' }));
    expect(screen.queryByText('Lost track of the bulk delete')).not.toBeInTheDocument();
  });
});

describe('BulkDeleteByKind outcomes', () => {
  async function runWith(jobOver: Partial<Record<string, unknown>>, props: Partial<React.ComponentProps<typeof BulkDeleteByKind>> = {}) {
    api.getBulkJobStatus.mockResolvedValue(job(jobOver));
    const view = renderDialog(props);
    await openAndPickReactions();
    fireEvent.click(screen.getByRole('button', { name: 'Delete 3 Reaction events' }));
    await waitFor(() => expect(toast).toHaveBeenCalled());
    return view;
  }

  it('reports a complete job as done and closes', async () => {
    const onComplete = vi.fn();
    await runWith({}, { onComplete });

    expect(lastToast()).toEqual({ title: 'Bulk delete complete', description: 'Deleted 3 Reaction events' });
    expect(onComplete).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  });

  it('says what was no longer listed when a clean job deleted fewer than the exact count', async () => {
    await runWith({ eventsProcessed: 1 });

    expect(lastToast()).toEqual({
      title: 'Bulk delete complete',
      description: 'Deleted 1 of 3 Reaction events. 2 were no longer listed: already deleted, or hidden because the account is now banned or suspended.',
    });
  });

  it('reports a clean job on a regular kind that deleted more than the count plainly', async () => {
    await runWith({ eventsProcessed: 5 });

    // Kind 7 has no versions; the extra were posted after the count.
    expect(lastToast()).toEqual({ title: 'Bulk delete complete', description: 'Deleted 5 Reaction events' });
  });

  it('counts older versions in a clean job on a replaceable kind that deleted more than the count', async () => {
    api.getBulkKindCounts.mockResolvedValue({ counts: { 0: 1, 7: 3 }, complete: true });
    api.getBulkJobStatus.mockResolvedValue(job({ kind: 0, eventsProcessed: 4 }));
    renderDialog();
    open();
    fireEvent.click(await screen.findByRole('button', { name: /Profile Metadata \(1\)/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete 1 Profile Metadata events' }));
    await waitFor(() => expect(toast).toHaveBeenCalled());

    expect(lastToast()).toEqual({
      title: 'Bulk delete complete',
      description: 'Deleted 4 Profile Metadata events, including older versions of edited events.',
    });
  });

  // "Deleted 20 of 1" reads as nonsense: past the count, or against an
  // incomplete zero, the total is left off.
  it('drops "of Y" from a partial outcome that deleted more than the count', async () => {
    await runWith({ status: 'failed', eventsProcessed: 5, failures: ['job:boom'] });

    expect(lastToast().description).toBe(`Deleted 5 Reaction events. ${RERUN} Reason: boom`);
  });

  it('drops "of at least 0" from a partial outcome against an incomplete zero', async () => {
    api.getBulkKindCounts.mockResolvedValue({ counts: { 1: 800 }, complete: false });
    api.getBulkJobStatus.mockResolvedValue(job({ kind: 34235, status: 'failed', eventsProcessed: 0, failures: ['job:boom'] }));
    renderDialog();
    open();
    await screen.findByRole('button', { name: /Text Note \(800\+\)/ });
    fireEvent.click(screen.getByRole('button', { name: 'Delete all Video (Addressable) events' }));
    await waitFor(() => expect(toast).toHaveBeenCalled());

    expect(lastToast().description).toBe(`Deleted 0 Video (Addressable) events. ${RERUN} Reason: boom`);
  });

  it('shows the dialog\'s account-scoped enumeration failures without the prefix', async () => {
    await runWith({
      eventsProcessed: 3,
      failures: [`enumeration:${PUBKEY}:still finding events after 20 passes; older versions may remain`],
    });

    expect(lastToast().description).toBe(
      `Deleted 3 of 3 Reaction events. ${RERUN} 1 failed or could not be listed: still finding events after 20 passes; older versions may remain`,
    );
  });

  it('reports a job that finished with failures without saying it is done, and says a re-run is safe', async () => {
    await runWith({ eventsProcessed: 1, failures: [`event:${EVENT_ID}:banevent failed`, '+1 more'] });

    expect(lastToast()).toEqual({
      title: 'Bulk delete finished with issues',
      description: `Deleted 1 of 3 Reaction events. ${RERUN} 2 failed or could not be listed: event ${EVENT_ID} failed: banevent failed; +1 more`,
      variant: 'destructive',
    });
    // The dialog stays open with the outcome.
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByText('Bulk delete finished with issues')).toBeInTheDocument();
  });

  it('counts the overflow marker when it reports how many failed', async () => {
    await runWith({ eventsProcessed: 0, failures: [`event:${EVENT_ID}:boom`, '+60 more'] });

    expect(lastToast().description).toMatch(/61 failed or could not be listed/);
  });

  it('reports a job that stopped early as stopped, with what it got through, in plain words', async () => {
    await runWith({ status: 'failed', eventsProcessed: 1, failures: ['job:abandoned (no terminal update; worker likely evicted mid-run)'] });

    expect(lastToast()).toEqual({
      title: 'Bulk delete stopped early',
      description: `Deleted 1 of 3 Reaction events. ${RERUN} Reason: the server stopped reporting progress`,
      variant: 'destructive',
    });
  });

  it('uses "at least" for the total when the count was not exact', async () => {
    api.getBulkKindCounts.mockResolvedValue({ counts: { 7: 3 }, complete: false });
    api.getBulkJobStatus.mockResolvedValue(job({ status: 'failed', eventsProcessed: 1, failures: ['job:boom'] }));
    renderDialog();
    open();
    fireEvent.click(await screen.findByRole('button', { name: /Reaction \(3\+\)/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete all Reaction events' }));
    await waitFor(() => expect(toast).toHaveBeenCalled());

    expect(lastToast().description).toMatch(/^Deleted 1 of at least 3 Reaction events\./);
  });

  // A lower bound supports neither "no longer listed" nor "older versions".
  it.each([
    ['fewer', 1],
    ['more', 5],
  ])('reports a clean job against a non-exact count plainly (%s than counted)', async (_label, deleted) => {
    api.getBulkKindCounts.mockResolvedValue({ counts: { 7: 3 }, complete: false });
    api.getBulkJobStatus.mockResolvedValue(job({ eventsProcessed: deleted }));
    renderDialog();
    open();
    fireEvent.click(await screen.findByRole('button', { name: /Reaction \(3\+\)/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete all Reaction events' }));
    await waitFor(() => expect(toast).toHaveBeenCalled());

    expect(lastToast()).toEqual({ title: 'Bulk delete complete', description: `Deleted ${deleted} Reaction events` });
  });

  it('lets the banned/suspended message stand in for "re-run" when the account is hidden now', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    api.getBulkJobStatus.mockResolvedValue(job({ status: 'running', eventsProcessed: 1 }));
    const { rerender } = renderDialog({ isBanned: null }, qc);
    await openAndPickReactions();
    fireEvent.click(screen.getByRole('button', { name: 'Delete 3 Reaction events' }));
    await screen.findByRole('status');
    api.getBulkJobStatus.mockResolvedValue(job({ status: 'failed', eventsProcessed: 1, failures: ['job:boom'] }));

    rerender(<QueryClientProvider client={qc}><BulkDeleteByKind pubkey={PUBKEY} isBanned={true} /></QueryClientProvider>);

    await waitFor(() => expect(toast).toHaveBeenCalled(), { timeout: 4000 });
    expect(lastToast().description).toBe(`Deleted 1 of 3 Reaction events. ${HIDDEN} Reason: boom`);
  });

  it('names the started kind when the finished job does not report one (an older worker)', async () => {
    await runWith({ kind: undefined, status: 'failed', eventsProcessed: 0, failures: ['job:abandoned (no terminal update; worker likely evicted mid-run)'] });

    expect(lastToast().description).toMatch(/^Deleted 0 of 3 Reaction events\./);
    expect(within(screen.getByRole('alertdialog')).getByText('Bulk delete stopped early')).toBeInTheDocument();
  });
});
