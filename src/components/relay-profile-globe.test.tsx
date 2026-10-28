// ABOUTME: Tests that ReportedBy and ThreadModal show the no-relay-profile globe only once
// ABOUTME: the profile lookup has answered "none", never while it is still unresolved (#132).

import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NostrEvent } from '@nostrify/nostrify';
import { RELAY_PROFILE_BADGE } from '@/lib/constants';
import { ReportedBy } from './ReporterInfo';
import { ThreadModal } from './ThreadModal';

const authorState = vi.hoisted(() => ({
  result: { data: undefined, isLoading: true } as { data?: { isFunnelcakeUser?: boolean }; isLoading: boolean },
}));
vi.mock('@/hooks/useAuthor', () => ({ useAuthor: () => authorState.result }));

const POST: NostrEvent = {
  id: '2'.repeat(64), pubkey: 'b'.repeat(64), kind: 1, tags: [], content: 'thread post',
  created_at: 1_750_000_000, sig: 'f'.repeat(128),
};
vi.mock('@nostrify/react', () => ({
  useNostr: () => ({ nostr: { query: async (filters: { ids?: string[] }[]) => (filters[0]?.ids ? [POST] : []) } }),
}));
vi.mock('@/hooks/useAppContext', () => ({ useAppContext: () => ({ config: { apiUrl: 'https://api.example.test' } }) }));

const globe = () => screen.queryByRole('img', { name: RELAY_PROFILE_BADGE.absent.label });

beforeEach(() => {
  authorState.result = { data: undefined, isLoading: true };
});

describe('ReportedBy no-relay-profile globe', () => {
  it('shows no globe while the lookup is unresolved', () => {
    render(<ReportedBy pubkey={'a'.repeat(64)} timestamp={1_750_000_000} />);
    expect(globe()).not.toBeInTheDocument();
  });

  it('shows the globe once the lookup answers that the relay has no profile', () => {
    authorState.result = { data: { isFunnelcakeUser: false }, isLoading: false };
    render(<ReportedBy pubkey={'a'.repeat(64)} timestamp={1_750_000_000} />);
    expect(globe()).toBeInTheDocument();
  });
});

describe('ThreadModal no-relay-profile globe', () => {
  function renderModal() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={client}>
        <ThreadModal eventId={POST.id} open onOpenChange={() => {}} />
      </QueryClientProvider>,
    );
  }

  it('shows no globe while the lookup is unresolved', async () => {
    renderModal();
    await screen.findByText('thread post');
    expect(globe()).not.toBeInTheDocument();
  });

  it('shows the globe once the lookup answers that the relay has no profile', async () => {
    authorState.result = { data: { isFunnelcakeUser: false }, isLoading: false };
    renderModal();
    await screen.findByText('thread post');
    expect(globe()).toBeInTheDocument();
  });
});
