import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';
import { describe, expect, it, vi } from 'vitest';
import { EventActions } from './EventActions';

vi.mock('@/hooks/useAdminApi', () => ({
  useAdminApi: () => ({
    deleteEvent: vi.fn().mockResolvedValue({ success: true }),
    moderateMedia: vi.fn().mockResolvedValue({ success: true }),
    deleteMedia: vi.fn().mockResolvedValue({ success: true }),
    publishDeletionRequest: vi.fn().mockResolvedValue({ success: true }),
    callRelayRpc: vi.fn().mockResolvedValue({ success: true }),
    logDecision: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('@/hooks/useToast', () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

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
});
