// ABOUTME: Tests EventsList search parsing plus the #164 A runtime paths:
// ABOUTME: ?event= internal nav, naddr lookup, banned id-fallback, parent links

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { nip19 } from 'nostr-tools';
import type { NostrEvent, NostrFilter } from '@nostrify/nostrify';
import { EventsList } from './EventsList';
import { parseSearchInput } from '@/lib/searchInput';

const PK = 'b'.repeat(64);

describe('parseSearchInput naddr', () => {
  it('parses an naddr into an address search mode', () => {
    const naddr = nip19.naddrEncode({ kind: 34236, pubkey: PK, identifier: 'vid1' });
    expect(parseSearchInput(naddr)).toEqual({
      type: 'address', addressKind: 34236, pubkey: PK, identifier: 'vid1',
    });
  });

  it('still parses nevent as event_id', () => {
    const nevent = nip19.neventEncode({ id: 'c'.repeat(64) });
    expect(parseSearchInput(nevent)).toEqual({ type: 'event_id', hex: 'c'.repeat(64) });
  });

  it('still parses npub as pubkey', () => {
    const npub = nip19.npubEncode(PK);
    expect(parseSearchInput(npub)).toEqual({ type: 'pubkey', hex: PK });
  });
});

// ---------------------------------------------------------------------------
// Render tests: the internal-nav lookup paths (#164 A, plan Task 8)
// ---------------------------------------------------------------------------

const relayQuery = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock('@/hooks/useNostr', () => ({
  useNostr: () => ({ nostr: { query: relayQuery.fn } }),
}));

const rpc = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock('@/hooks/useAdminApi', () => ({
  useAdminApi: () => ({
    callRelayRpc: rpc.fn,
    banEvent: vi.fn(),
    allowEvent: vi.fn(),
    verifyEventDeleted: vi.fn(),
  }),
}));

vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ user: { pubkey: 'a'.repeat(64) } }),
}));

// Profile loading is useAuthor's concern (tested elsewhere)
vi.mock('@/hooks/useAuthor', () => ({
  useAuthor: () => ({ data: undefined, isLoading: false }),
}));

vi.mock('@/hooks/useToast', () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

// Heavy children irrelevant to lookup/nav behavior
vi.mock('@/components/EventDetail', () => ({ EventDetail: () => null }));
vi.mock('@/components/BulkDeleteByKind', () => ({ BulkDeleteByKind: () => null }));

// The batched parent-title hook is mocked so comment-row links are
// deterministic; calls are recorded to assert what resolution was requested
const titleCalls = vi.hoisted(() => ({ targets: [] as string[][] }));
vi.mock('@/hooks/useEventTitles', () => ({
  useEventTitles: (targets: string[]) => {
    titleCalls.targets.push(targets);
    return {
      titles: new Map(targets.map(t => [t, { target: t, title: 'Parent Video', encoded: 'nevent1parent' }])),
      isLoading: false,
    };
  },
}));

function event(over: Partial<NostrEvent>): NostrEvent {
  return {
    id: 'e'.repeat(64), pubkey: PK, kind: 1, content: '', tags: [],
    created_at: 1_750_000_000, sig: 'f'.repeat(128), ...over,
  };
}

// Route the relay mock by filter shape: the direct lookup queries by ids or
// by kind+author+#d; everything else is the infinite list query.
function setRelay({ byId = [], byAddress = [], list = [] }: {
  byId?: NostrEvent[]; byAddress?: NostrEvent[]; list?: NostrEvent[];
}) {
  relayQuery.fn.mockImplementation(async (filters: NostrFilter[]) => {
    const f = filters[0] ?? {};
    if (f.ids) return [...byId];
    if (f['#d']) return [...byAddress];
    if (f.until) return []; // pagination: pages after the first are empty
    return [...list];
  });
}

// Probe MemoryRouter's current query string so tests can pin param consumption
const location = { search: '' };
function LocationProbe() {
  location.search = useLocation().search;
  return null;
}

function renderEvents(initialEntry: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <EventsList relayUrl="wss://relay.test" />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  relayQuery.fn.mockReset();
  rpc.fn.mockReset();
  rpc.fn.mockResolvedValue([]);
  titleCalls.targets.length = 0;
  setRelay({});
});

describe('EventsList internal navigation (#164 A)', () => {
  it('consumes ?event=<naddr> into an address lookup with the kind+author+d filter', async () => {
    const naddr = nip19.naddrEncode({ kind: 34236, pubkey: PK, identifier: 'vid1' });
    setRelay({ byAddress: [event({ id: 'd'.repeat(64), kind: 34236, content: 'the video', tags: [['d', 'vid1'], ['title', 'My Video']] })] });

    renderEvents(`/events?event=${naddr}`);

    await waitFor(() => {
      const addressFilter = relayQuery.fn.mock.calls
        .map(args => args[0]?.[0])
        .find((f: NostrFilter) => f?.['#d']);
      expect(addressFilter).toEqual({ kinds: [34236], authors: [PK], '#d': ['vid1'], limit: 1 });
    });

    // The param seeds the search box (visible, clearable), the status strip
    // reports the hit, and the resolved video renders in the detail pane
    expect(screen.getByDisplayValue(naddr)).toBeInTheDocument();
    expect(await screen.findByText('Event found')).toBeInTheDocument();
    expect(await screen.findByText(/the video/)).toBeInTheDocument();

    // The param is consumed from the URL — left in place, the effect would
    // re-fire and revert every later clear/re-search back to this event
    expect(location.search).not.toContain('event=');
  });

  it('shows a removed/banned parent for an event-id target via the getbannedevent fallback', async () => {
    const id = 'c'.repeat(64);
    const nevent = nip19.neventEncode({ id });
    setRelay({ byId: [] }); // gone from the live relay
    rpc.fn.mockImplementation(async (method: string) =>
      method === 'getbannedevent' ? event({ id, kind: 1, content: 'the banned parent' }) : []);

    renderEvents(`/events?event=${nevent}`);

    expect(await screen.findByText('Event found (banned)')).toBeInTheDocument();
    expect(screen.getByText('Banned event')).toBeInTheDocument();
    expect(rpc.fn).toHaveBeenCalledWith('getbannedevent', [id]);
  });

  it('labels an address-mode miss with the id-only banned-lookup caveat', async () => {
    const naddr = nip19.naddrEncode({ kind: 34236, pubkey: PK, identifier: 'gone' });
    setRelay({ byAddress: [] });

    renderEvents(`/events?event=${naddr}`);

    expect(await screen.findByText(/Banned events can only be retrieved by event id/i)).toBeInTheDocument();
  });

  it('renders an "on <parent>" link on a kind-1111 row and resolves only surviving rows', async () => {
    const shownTarget = '1'.repeat(64);
    const bannedTarget = '2'.repeat(64);
    const bannedId = '9'.repeat(64);
    setRelay({
      list: [
        event({ id: '8'.repeat(64), kind: 1111, content: 'visible comment', tags: [['E', shownTarget], ['K', '34236']] }),
        event({ id: bannedId, kind: 1111, content: 'banned comment', tags: [['E', bannedTarget], ['K', '34236']] }),
      ],
    });
    // The banned row is filtered out of the list before rendering
    rpc.fn.mockImplementation(async (method: string) =>
      method === 'listbannedevents' ? [{ id: bannedId }] : []);

    renderEvents('/events');

    const link = await screen.findByRole('link', { name: /on Parent Video/ });
    expect(link).toHaveAttribute('href', '/events?event=nevent1parent');

    // Only the rendered row's target is resolved — the filtered-out banned
    // row must not feed the batched title query (#165 review)
    await waitFor(() => {
      expect(titleCalls.targets.at(-1)).toEqual([shownTarget]);
    });
  });
});
