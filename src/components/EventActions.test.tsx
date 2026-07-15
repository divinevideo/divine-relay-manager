import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventActions } from './EventActions';

// Stable mocks so failure-path tests can control the audit log and assert on toasts.
const api = vi.hoisted(() => ({
  banEvent: vi.fn(),
  allowEvent: vi.fn(),
  deleteEvent: vi.fn(),
  moderateMedia: vi.fn(),
  deleteMedia: vi.fn(),
  callRelayRpc: vi.fn(),
  logDecision: vi.fn(),
}));
const toast = vi.hoisted(() => vi.fn());
const MOD_PUBKEY = 'e'.repeat(64);

vi.mock('@/hooks/useAdminApi', () => ({ useAdminApi: () => api }));
vi.mock('@/hooks/useToast', () => ({ useToast: () => ({ toast }) }));
// Logged-in moderator, so audit writes carry attribution (#178).
vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ user: { pubkey: MOD_PUBKEY }, getModeratorPubkey: async () => MOD_PUBKEY }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  api.banEvent.mockResolvedValue({ success: true });
  api.allowEvent.mockResolvedValue({ success: true });
  api.deleteEvent.mockResolvedValue({ success: true });
  api.moderateMedia.mockResolvedValue({ success: true });
  api.deleteMedia.mockResolvedValue({ success: true });
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

describe('EventActions', () => {
  it('renders ban and delete buttons for events without media', () => {
    renderWithProvider(
      <EventActions eventId="event-1" pubkey={'a'.repeat(64)} />
    );
    expect(screen.getByRole('button', { name: /Ban Event/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Delete Event/i })).toBeInTheDocument();
    expect(screen.queryByText(/Block Media/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Delete Media/i)).not.toBeInTheDocument();
  });

  it('renders media actions when mediaHashes provided', () => {
    renderWithProvider(
      <EventActions eventId="event-1" pubkey={'a'.repeat(64)} mediaHashes={['abc123']} />
    );
    expect(screen.getByRole('button', { name: /Block Media/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Age Restrict/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Delete Media/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Delete Event & Media/i })).toBeInTheDocument();
  });

  it('renders restore button when event is banned', () => {
    renderWithProvider(
      <EventActions eventId="event-1" pubkey={'a'.repeat(64)} isEventBanned={true} />
    );
    expect(screen.getByRole('button', { name: /Restore Event/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Ban Event/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Delete Event$/i })).not.toBeInTheDocument();
  });

  it('renders unblock when media is blocked', () => {
    renderWithProvider(
      <EventActions eventId="event-1" pubkey={'a'.repeat(64)} mediaHashes={['abc']} hasBlockedMedia={true} />
    );
    expect(screen.getByRole('button', { name: /Unblock Media/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Block Media/i })).not.toBeInTheDocument();
  });

  it('renders remove restriction when media is restricted', () => {
    renderWithProvider(
      <EventActions eventId="event-1" pubkey={'a'.repeat(64)} mediaHashes={['abc']} hasRestrictedMedia={true} />
    );
    expect(screen.getByRole('button', { name: /Remove Restriction/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Age Restrict/i })).not.toBeInTheDocument();
  });

  it('reports success on Ban Event even when the audit-log write fails', async () => {
    // Regression: logDecision used to be awaited in the mutation, so a failed
    // /api/decisions write made a SUCCEEDED banevent report "Failed to ban event".
    // Audit is now fire-and-forget, so the ban reports success regardless.
    api.logDecision.mockRejectedValue(new Error('audit down'));
    renderWithProvider(<EventActions eventId="event-1" pubkey={'a'.repeat(64)} />);

    fireEvent.click(screen.getByRole('button', { name: /Ban Event/i }));

    await waitFor(() => expect(api.banEvent).toHaveBeenCalledWith('event-1', 'Banned by moderator'));
    // #178: the audit write is attributed to the logged-in moderator.
    await waitFor(() =>
      expect(api.logDecision).toHaveBeenCalledWith(expect.objectContaining({ moderatorPubkey: MOD_PUBKEY })),
    );
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Event banned from relay' })),
    );
    expect(toast).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Failed to ban event' }),
    );
    // and the audit failure surfaces as a non-blocking toast, not an action failure
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: expect.stringMatching(/audit log not recorded/i) })),
    );
  });

  it('does not fire-and-forget when the audit write never settles — ban still reports success', async () => {
    // A hung /api/decisions write must not stall or fail the action.
    api.logDecision.mockReturnValue(new Promise(() => {})); // never settles
    renderWithProvider(<EventActions eventId="event-1" pubkey={'a'.repeat(64)} />);

    fireEvent.click(screen.getByRole('button', { name: /Ban Event/i }));

    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Event banned from relay' })),
    );
    expect(api.banEvent).toHaveBeenCalledTimes(1);
  });
});
