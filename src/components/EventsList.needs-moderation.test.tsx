// ABOUTME: listeventsneedingmoderation is a full relay scan that records no approvals, so
// ABOUTME: EventsList must skip the scan on load and refresh while hiding banned events

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
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
const visibleId = 'e'.repeat(64);
const bannedId = 'd'.repeat(64);

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
  rpc.fn.mockImplementation(async (method: string) => {
    if (method === METHOD) return [{ id: visibleId }];
    if (method === 'listbannedevents') return [{ id: bannedId, reason: 'banned by a moderator' }];
    return [];
  });
});

describe('EventsList does not use the needs-moderation scan', () => {
  it('loads and refreshes ordinary events without scanning for pending events', async () => {
    const note = { pubkey: 'b'.repeat(64), kind: 1, tags: [], created_at: 1_750_000_000, sig: 'f'.repeat(128) };
    let visibleContent = 'hello world';
    relayQuery.fn.mockImplementation(async ([filter]: [{ until?: number }]) => {
      if (filter.until !== undefined) return [];
      return [
        { ...note, id: visibleId, content: visibleContent },
        { ...note, id: bannedId, content: 'banned content' },
      ];
    });

    mount(createQueryClient());
    expect(await screen.findByText('hello world')).toBeInTheDocument();
    expect(await screen.findByText('1 events')).toBeInTheDocument();
    expect(screen.queryByText('banned content')).toBeNull();
    expect(scanCalls()).toBe(0);
    expect(screen.queryByText(/pending/i)).toBeNull();

    visibleContent = 'updated event feed';
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText('updated event feed')).toBeInTheDocument();
    expect(scanCalls()).toBe(0);
  });
});
