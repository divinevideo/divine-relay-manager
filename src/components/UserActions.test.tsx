import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';
import { describe, expect, it, vi } from 'vitest';
import { UserActions } from './UserActions';

vi.mock('@/hooks/useAdminApi', () => ({
  useAdminApi: () => ({
    bulkModerate: vi.fn().mockResolvedValue({ success: true, eventsProcessed: 3, mediaProcessed: 2, failures: [] }),
    banPubkey: vi.fn().mockResolvedValue({ success: true }),
    unbanPubkey: vi.fn().mockResolvedValue({ success: true }),
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

describe('UserActions', () => {
  it('renders ban, bulk age-restrict, and bulk delete', () => {
    renderWithProvider(
      <UserActions pubkey={'a'.repeat(64)} />
    );
    expect(screen.getByRole('button', { name: /Ban User/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Age Restrict All/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Delete All Content/i })).toBeInTheDocument();
  });

  it('renders unban when user is banned', () => {
    renderWithProvider(
      <UserActions pubkey={'a'.repeat(64)} isBanned={true} />
    );
    expect(screen.getByRole('button', { name: /Unban User/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Ban User/i })).not.toBeInTheDocument();
  });

  it('hides bulk actions in age-review context', () => {
    renderWithProvider(
      <UserActions pubkey={'a'.repeat(64)} context="age-review" />
    );
    expect(screen.getByRole('button', { name: /Ban User/i })).toBeInTheDocument();
    expect(screen.queryByText(/Age Restrict All/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Delete All Content/i)).not.toBeInTheDocument();
  });
});
