// ABOUTME: listeventsneedingmoderation is a full relay scan that records no approvals, so
// ABOUTME: EventsList must never call it and must show no pending count, badge or refresh

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { EventsList } from './EventsList';
import { createQueryClient } from '@/lib/queryClient';
import { withAsModerator } from '@/test/adminApiMock';

const relayQuery = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock('@/hooks/useNostr', () => ({ useNostr: () => ({ nostr: { query: relayQuery.fn } }) }));

const rpc = vi.hoisted(() => ({ fn: vi.fn() }));
const moderatorApi = withAsModerator({
  callRelayRpc: (...args: unknown[]) => rpc.fn(...args),
  listBannedEvents: () => rpc.fn('listbannedevents'),
});
vi.mock('@/hooks/useAdminApi', () => ({ useAdminApi: () => moderatorApi }));
vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ user: { pubkey: 'a'.repeat(64) }, getModeratorToken: () => 't' }),
}));
vi.mock('@/hooks/useDivineSession', () => ({ useDivineSession: () => ({ isSignedIn: true }) }));
vi.mock('@/hooks/useAuthor', () => ({ useAuthor: () => ({ data: undefined, isLoading: false }) }));
vi.mock('@/hooks/useToast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/components/EventDetail', () => ({ EventDetail: () => null }));
vi.mock('@/components/BulkDeleteByKind', () => ({ BulkDeleteByKind: () => null }));
vi.mock('@/hooks/useEventTitles', () => ({ useEventTitles: () => ({ titles: new Map(), isLoading: false }) }));

const METHOD = 'listeventsneedingmoderation';
const scanCalls = () => rpc.fn.mock.calls.filter(c => c[0] === METHOD).length;

function mount(client: QueryClient) {
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/events']}>
        <EventsList relayUrl="wss://relay.test" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  relayQuery.fn.mockReset();
  relayQuery.fn.mockResolvedValue([]);
  rpc.fn.mockReset();
  rpc.fn.mockImplementation(async (m: string) => (m === METHOD ? [{ id: 'e'.repeat(64) }] : []));
});

describe('EventsList does not use the needs-moderation scan', () => {
  it('never calls listeventsneedingmoderation and shows no pending badge', async () => {
    relayQuery.fn.mockResolvedValue([
      { id: 'e'.repeat(64), pubkey: 'b'.repeat(64), kind: 1, content: 'hello world', tags: [], created_at: 1_750_000_000, sig: 'f'.repeat(128) },
    ]);
    const client = createQueryClient();
    mount(client);
    await screen.findByText(/hello world/);
    await new Promise(r => setTimeout(r, 50));
    expect(scanCalls()).toBe(0);
    expect(screen.queryByText(/pending/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /refresh pending/i })).toBeNull();
  });
});
