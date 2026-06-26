import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UserActions } from './UserActions';

// Stable mock so individual tests can control resolution timing (e.g. make the
// audit log hang) and assert on the same fn instances.
const api = vi.hoisted(() => ({
  bulkModerate: vi.fn(),
  banPubkey: vi.fn(),
  unbanPubkey: vi.fn(),
  suspendPubkey: vi.fn(),
  unsuspendPubkey: vi.fn(),
  logDecision: vi.fn(),
}));
const toast = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/useAdminApi', () => ({
  useAdminApi: () => api,
}));

vi.mock('@/hooks/useToast', () => ({
  useToast: () => ({ toast }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  api.bulkModerate.mockResolvedValue({ success: true, eventsProcessed: 3, mediaProcessed: 2, failures: [] });
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
    renderWithProvider(
      <UserActions pubkey={'a'.repeat(64)} />
    );
    expect(screen.getByRole('button', { name: /Suspend User/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Ban User/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Age Restrict All/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Delete All Content/i })).toBeInTheDocument();
  });

  it('renders unsuspend and ban when user is suspended', () => {
    renderWithProvider(
      <UserActions pubkey={'a'.repeat(64)} isSuspended={true} />
    );
    expect(screen.getByRole('button', { name: /Unsuspend User/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Ban User/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Suspend User/i })).not.toBeInTheDocument();
  });

  it('renders unban when user is banned', () => {
    renderWithProvider(
      <UserActions pubkey={'a'.repeat(64)} isBanned={true} />
    );
    expect(screen.getByRole('button', { name: /Unban User/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Ban User/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Suspend User/i })).not.toBeInTheDocument();
  });

  it('hides bulk actions in age-review context', () => {
    renderWithProvider(
      <UserActions pubkey={'a'.repeat(64)} context="age-review" />
    );
    expect(screen.getByRole('button', { name: /Suspend User/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Ban User/i })).toBeInTheDocument();
    expect(screen.queryByText(/Age Restrict All/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Delete All Content/i)).not.toBeInTheDocument();
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
