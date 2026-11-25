// ABOUTME: Tests EventsList search parsing plus the #164 A runtime paths:
// ABOUTME: ?event= internal nav, naddr lookup, banned id-fallback, parent links

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { QueryClientProvider, focusManager } from '@tanstack/react-query';
import { createQueryClient } from '@/lib/queryClient';
import { nip19 } from 'nostr-tools';
import type { NostrEvent, NostrFilter } from '@nostrify/nostrify';
import { EventsList } from './EventsList';
import { parseSearchInput } from '@/lib/searchInput';
import { RELAY_PROFILE_BADGE, RECENT_CONTENT_KINDS } from '@/lib/constants';
import { VIDEO_KINDS } from '@/lib/kindNames';
import { tokensFor, withAsModerator } from '@/test/adminApiMock';

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
const eventModeration = vi.hoisted(() => ({
  hide: vi.fn(),
  restore: vi.fn(),
  verifyDeleted: vi.fn(),
}));
const moderatorApi = withAsModerator({
  callRelayRpc: (...args: unknown[]) => rpc.fn(...args),
  // Banned posts are read through the shared useBannedEvents definition, which
  // calls listBannedEvents rather than callRelayRpc('listbannedevents'). Route it
  // to the same mock so the assertions below keep one source of relay data.
  listBannedEvents: () => rpc.fn('listbannedevents'),
  hideEvent: (...args: unknown[]) => eventModeration.hide(...args),
  restoreEvent: (...args: unknown[]) => eventModeration.restore(...args),
  verifyEventDeleted: (...args: unknown[]) => eventModeration.verifyDeleted(...args),
});
vi.mock('@/hooks/useAdminApi', () => ({
  useAdminApi: () => moderatorApi,
}));

const MOD_TOKEN = 'moderator-login-token';
vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({
    user: { pubkey: 'a'.repeat(64) },
    getModeratorToken: () => MOD_TOKEN,
  }),
}));

// EventsList gates its banned-event lookups on session presence, not on the
// resolved moderator identity: those lookups go through the worker, which
// authorizes them without a pubkey.
vi.mock('@/hooks/useDivineSession', () => ({
  useDivineSession: () => ({ isSignedIn: true }),
}));

// Profile loading is useAuthor's concern (tested elsewhere); tests set what it answered.
const authorState = vi.hoisted(() => ({
  result: { data: undefined, isLoading: false } as { data?: { isFunnelcakeUser?: boolean }; isLoading: boolean },
}));
vi.mock('@/hooks/useAuthor', () => ({
  useAuthor: () => authorState.result,
}));

vi.mock('@/hooks/useToast', () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

// Heavy children irrelevant to lookup/nav behavior
vi.mock('@/components/EventDetail', () => ({
  EventDetail: ({ event, onSelectPubkey }: { event: NostrEvent; onSelectPubkey: (pubkey: string) => void }) => (
    <button onClick={() => onSelectPubkey(event.pubkey)}>View All by User</button>
  ),
}));
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
const navigation = { go: (() => {}) as (delta: number) => void };
function LocationProbe() {
  location.search = useLocation().search;
  navigation.go = useNavigate();
  return null;
}

function renderEvents(initialEntry: string) {
  // The app's own defaults (focus refetch on, 60s staleTime) so a missing
  // per-query override shows up here the way it would in the app.
  const client = createQueryClient();
  client.setDefaultOptions({
    ...client.getDefaultOptions(),
    queries: { ...client.getDefaultOptions().queries, retry: false },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <EventsList relayUrl="wss://relay.test" />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>
  );
  return { ...view, client };
}

function eventListViewport(container: HTMLElement): HTMLElement {
  const viewport = container.querySelector<HTMLElement>('[data-radix-scroll-area-viewport]');
  if (!viewport) throw new Error('Missing event list viewport');
  return viewport;
}

beforeEach(() => {
  moderatorApi.moderatorCall.mockClear();
  authorState.result = { data: undefined, isLoading: false };
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  relayQuery.fn.mockReset();
  rpc.fn.mockReset();
  rpc.fn.mockResolvedValue([]);
  eventModeration.hide.mockReset();
  eventModeration.hide.mockResolvedValue({ success: true, recorded: true });
  eventModeration.restore.mockReset();
  eventModeration.restore.mockResolvedValue({ success: true, recorded: true });
  eventModeration.verifyDeleted.mockReset();
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

describe('EventsList recorded moderation', () => {
  it('routes an approved event through allow_event instead of raw relay RPC', async () => {
    const target = event({ id: 'd'.repeat(64), content: 'review me' });
    setRelay({ list: [target] });
    renderEvents('/events');

    await screen.findByText('review me');
    const actions = screen.getByRole('button', { name: 'Event actions' });
    actions.focus();
    fireEvent.keyDown(actions, { key: 'Enter', code: 'Enter' });
    fireEvent.click(await screen.findByText('Moderate Event'));

    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('combobox'));
    fireEvent.click(await screen.findByRole('option', { name: 'Allow Event' }));
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Allow Event' }));

    await waitFor(() => expect(eventModeration.restore).toHaveBeenCalledWith(
      target.id,
      'Allowed from event list',
    ));
    expect(eventModeration.hide).not.toHaveBeenCalled();
    // Through asModerator(token) (#178).
    expect(tokensFor(moderatorApi, 'restoreEvent')).toEqual([MOD_TOKEN]);
  });
});

describe('EventsList no-relay-profile globe', () => {
  const globe = () => screen.queryByRole('img', { name: RELAY_PROFILE_BADGE.absent.label });

  it('shows no globe while the author lookup has not answered', async () => {
    setRelay({ list: [event({ id: 'd'.repeat(64), content: 'listed event' })] });
    renderEvents('/events');
    await screen.findByText('listed event');
    expect(globe()).not.toBeInTheDocument();
  });

  it('shows the globe once the lookup answers that the relay has no profile', async () => {
    authorState.result = { data: { isFunnelcakeUser: false }, isLoading: false };
    setRelay({ list: [event({ id: 'd'.repeat(64), content: 'listed event' })] });
    renderEvents('/events');
    await screen.findByText('listed event');
    expect(globe()).toBeInTheDocument();
  });
});

// Kind 0 content is whatever the profile's author published, so a field can
// hold any JSON value and the content need not be an object at all.
describe('EventsList profile row', () => {
  function renderProfileRow(content: string) {
    setRelay({ list: [event({ id: 'd'.repeat(64), kind: 0, content })] });
    renderEvents('/events');
  }

  it('shows the name and about when they are text', async () => {
    renderProfileRow(JSON.stringify({ display_name: 'Synthetic Name', about: 'synthetic about' }));
    expect(await screen.findByText('Synthetic Name — synthetic about')).toBeInTheDocument();
  });

  it('leaves out fields that are not text', async () => {
    renderProfileRow(JSON.stringify({
      display_name: { nested: true },
      about: ['about-as-a-list', 'second-item'],
      nip05: 'synthetic@example.test',
    }));
    expect(await screen.findByText('synthetic@example.test')).toBeInTheDocument();
    expect(screen.queryByText(/\[object Object\]/)).not.toBeInTheDocument();
    expect(screen.queryByText(/about-as-a-list/)).not.toBeInTheDocument();
  });

  it('says "Profile update" when no field is text', async () => {
    renderProfileRow(JSON.stringify({ display_name: 4205, about: { a: 1 }, nip05: ['n'] }));
    expect(await screen.findByText('Profile update')).toBeInTheDocument();
    expect(screen.queryByText(/4205/)).not.toBeInTheDocument();
  });

  it('shows the content as written when it is JSON but not an object', async () => {
    renderProfileRow('["not","a","profile"]');
    expect(await screen.findByText('["not","a","profile"]')).toBeInTheDocument();
  });
});

// A report's tag is reporter-written and can spell its target in uppercase
// (#315); relay events carry the lowercase id, so the tag is lowercased.
describe('EventsList "Has reports" filter', () => {
  it.each([
    ['lowercase (control)', (id: string) => id],
    ['uppercase', (id: string) => id.toUpperCase()],
  ])('counts a report that spells the event in %s', async (_label, spell) => {
    const reported = event({ id: 'ab'.repeat(32), pubkey: 'cd'.repeat(32), content: 'reported post' });
    const quiet = event({ id: '12'.repeat(32), pubkey: '34'.repeat(32), content: 'quiet post' });
    const report = event({ id: '9'.repeat(64), kind: 1984, pubkey: '5'.repeat(64), tags: [['e', spell(reported.id), 'spam']] });
    relayQuery.fn.mockImplementation(async (filters: NostrFilter[]) => {
      const f = filters[0] ?? {};
      if (f.kinds?.includes(1984)) return [report];
      if (f.ids || f['#d'] || f.until) return [];
      return [reported, quiet];
    });
    rpc.fn.mockImplementation(async () => []);

    renderEvents('/events');
    expect(await screen.findByText('quiet post')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: /Has reports/ }));

    // Every row is filtered out until the reports read lands, so wait for the
    // reported row to come back rather than for the quiet one to go.
    expect(await screen.findByText('reported post')).toBeInTheDocument();
    expect(screen.queryByText('quiet post')).not.toBeInTheDocument();
  });
});

// The unfiltered `{ limit }` query is the relay's most expensive shape (no
// kinds -> full-table merge), so the tab must not send it by default, on a
// timer, or by accident. Paged (`until`) requests count: they are list queries.
describe('EventsList list query cost', () => {
  const listFilters = () =>
    relayQuery.fn.mock.calls
      .map(args => args[0]?.[0] as NostrFilter | undefined)
      .filter((f): f is NostrFilter => !!f && !f.ids && !f['#d'] && !f.kinds?.includes(1984));
  const video = () => event({ kind: 34236, content: 'a video' });
  const pickKind = async (name: string) => {
    fireEvent.click(screen.getByLabelText('Event Kind'));
    fireEvent.click(await screen.findByRole('option', { name }));
  };

  it('defaults every list request, paged ones included, to the video kinds', async () => {
    relayQuery.fn.mockImplementation(async (filters: NostrFilter[]) =>
      filters[0]?.until ? [event({ kind: 34236, content: 'older', created_at: 1_700_000_000 })] : [video()]);
    renderEvents('/events');
    expect(await screen.findByText('older')).toBeInTheDocument();
    const filters = listFilters();
    expect(filters.some(f => f.until)).toBe(true);
    for (const f of filters) expect(f.kinds).toEqual([...VIDEO_KINDS]);
  });

  it('does not refetch the list on a timer', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    try {
      setRelay({ list: [video()] });
      renderEvents('/events');
      await vi.advanceTimersByTimeAsync(100);
      const before = listFilters().length;
      expect(before).toBeGreaterThan(0);
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      expect(listFilters().length).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not refetch the list when the window regains focus', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      setRelay({ list: [video()] });
      renderEvents('/events');
      await screen.findByText('a video');
      const before = listFilters().length;
      vi.setSystemTime(Date.now() + 5 * 60 * 1000); // data is now stale
      focusManager.setFocused(false);
      focusManager.setFocused(true);
      await new Promise(r => setTimeout(r, 50));
      expect(listFilters().length).toBe(before);
    } finally {
      focusManager.setFocused(undefined);
      vi.useRealTimers();
    }
  });

  it('sends no kinds once "All Events" is chosen explicitly', async () => {
    setRelay({ list: [video()] });
    renderEvents('/events');
    await screen.findByText('a video');
    expect(listFilters().every(f => f.kinds)).toBe(true);
    await pickKind('All Events');
    await waitFor(() => expect(listFilters().some(f => f.kinds === undefined)).toBe(true));
  });

  it('aborts the in-flight list request when the kind filter changes', async () => {
    relayQuery.fn.mockImplementation(() => new Promise(() => {})); // never answers
    renderEvents('/events');
    await waitFor(() => expect(relayQuery.fn).toHaveBeenCalled());
    const signal = relayQuery.fn.mock.calls[0][1]?.signal as AbortSignal;
    await pickKind('All Events');
    await waitFor(() => expect(signal.aborted).toBe(true));
  });

  it('does not run the list query in direct-lookup mode', async () => {
    // Not on the relay and not banned. The shared rpc mock answers `[]`, which is
    // truthy, so the lookup would take it for a banned event with no pubkey and
    // crash EventCard; a real miss is an RPC error (the lookup's catch turns it
    // into "not found").
    rpc.fn.mockRejectedValue(new Error('Event not found or not banned'));
    renderEvents(`/events?event=${nip19.neventEncode({ id: 'c'.repeat(64) })}`);
    expect(await screen.findByText('No event found on relay', { selector: 'span' })).toBeInTheDocument();
    expect(listFilters()).toEqual([]);
  });

  it('does not fetch another page while scrolling a direct lookup after using the list', async () => {
    const id = 'c'.repeat(64);
    setRelay({ list: [video()], byId: [event({ id, content: 'looked up' })] });
    const { container } = renderEvents('/events');
    const viewport = eventListViewport(container);
    Object.defineProperties(viewport, { scrollHeight: { value: 800 }, clientHeight: { value: 300 } });
    await screen.findByText('a video');

    const search = screen.getByPlaceholderText(/Search by event ID/);
    fireEvent.change(search, { target: { value: id } });
    fireEvent.keyDown(search, { key: 'Enter' });
    await screen.findByText('Event found');
    relayQuery.fn.mockClear();
    fireEvent.scroll(viewport, { target: { scrollTop: 480 } });
    expect(listFilters()).toEqual([]);
  });

  it('can open the author activity from a direct lookup', async () => {
    const id = 'c'.repeat(64);
    setRelay({ list: [video()], byId: [event({ id, content: 'looked up' })] });
    renderEvents(`/events?event=${nip19.neventEncode({ id })}`);
    fireEvent.click(await screen.findByRole('button', { name: 'View All by User' }));

    expect(await screen.findByText('a video')).toBeInTheDocument();
    expect(screen.queryByText('Event found')).not.toBeInTheDocument();
    expect(listFilters().every(f => f.authors?.[0] === PK)).toBe(true);
  });

  describe('Refresh', () => {
    it('does not run the hidden list query in direct-lookup mode', async () => {
      setRelay({ byId: [event({ id: 'c'.repeat(64), kind: 1, content: 'looked up' })] });
      renderEvents(`/events?event=${nip19.neventEncode({ id: 'c'.repeat(64) })}`);
      await screen.findByText('Event found');
      relayQuery.fn.mockClear();
      expect(screen.getByRole('button', { name: /Refresh/ })).toBeDisabled();
      expect(listFilters()).toEqual([]);
    });

    it('refetches the list when clicked', async () => {
      setRelay({ list: [video()] });
      renderEvents('/events');
      await screen.findByText('a video');
      const before = listFilters().length;
      fireEvent.click(screen.getByRole('button', { name: /Refresh/ }));
      await waitFor(() => expect(listFilters().length).toBeGreaterThan(before));
    });

    it('spins and disables while a refresh is in flight', async () => {
      setRelay({ list: [video()] });
      renderEvents('/events');
      await screen.findByText('a video');
      let release: () => void = () => {};
      relayQuery.fn.mockImplementation(() => new Promise(r => { release = () => r([video()]); }));
      const button = screen.getByRole('button', { name: /Refresh/ });
      fireEvent.click(button);
      await waitFor(() => expect(button).toBeDisabled());
      release();
      await waitFor(() => expect(button).not.toBeDisabled());
    });

    it('reloads from the first page instead of every loaded page', async () => {
      relayQuery.fn.mockImplementation(async (filters: NostrFilter[]) => {
        const until = filters[0]?.until;
        if (!until) return [video()];
        return until > 1_700_000_000 ? [event({ kind: 34236, content: 'older', created_at: 1_700_000_000 })] : [];
      });
      const { client } = renderEvents('/events');
      await screen.findByText('older');
      const pagesOf = () =>
        (client.getQueriesData<{ pages: unknown[] }>({ queryKey: ['relay-events'] })[0][1])?.pages.length ?? 0;
      expect(pagesOf()).toBeGreaterThan(1);
      fireEvent.click(screen.getByRole('button', { name: /Refresh/ }));
      expect(pagesOf()).toBe(1); // synchronously after the click, before the refetch lands
    });
  });

  describe('author view', () => {
    it('defaults to the recent content kinds, not the video-only default', async () => {
      setRelay({ list: [event({ kind: 1111, content: 'spam comment' })] });
      renderEvents(`/events?pubkey=${PK}`);
      expect(await screen.findByText('spam comment')).toBeInTheDocument();
      const filters = listFilters();
      expect(filters.length).toBeGreaterThan(0);
      for (const f of filters) {
        expect(f.authors).toEqual([PK]);
        expect(f.kinds).toEqual([...RECENT_CONTENT_KINDS]);
      }
    });

    it('says which kinds are shown and offers one click to show all', async () => {
      setRelay({ list: [event({ kind: 1111, content: 'spam comment' })] });
      renderEvents(`/events?pubkey=${PK}`);
      await screen.findByText('spam comment');
      expect(screen.getByText(/Showing recent content kinds/)).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: /Show all kinds/ }));
      await waitFor(() => expect(listFilters().some(f => f.authors && f.kinds === undefined)).toBe(true));
    });

    it('returns to kinds-scoped queries once the author filter is cleared after Show all kinds', async () => {
      setRelay({ list: [event({ kind: 1111, content: 'spam comment' })] });
      renderEvents(`/events?pubkey=${PK}`);
      await screen.findByText('spam comment');
      fireEvent.click(screen.getByRole('button', { name: /Show all kinds/ }));
      await waitFor(() => expect(listFilters().some(f => f.authors && f.kinds === undefined)).toBe(true));
      relayQuery.fn.mockClear();
      fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
      await waitFor(() => expect(listFilters().length).toBeGreaterThan(0));
      await new Promise(r => setTimeout(r, 50));
      for (const f of listFilters()) expect(f.kinds).toEqual([...VIDEO_KINDS]);
    });

    it('returns to kinds-scoped queries when browser Back leaves the author view after Show all kinds', async () => {
      setRelay({ list: [event({ kind: 1111, content: 'spam comment' })] });
      renderEvents('/events');
      const box = screen.getByPlaceholderText(/Search by event ID/);
      fireEvent.change(box, { target: { value: nip19.npubEncode(PK) } });
      fireEvent.keyDown(box, { key: 'Enter' }); // pushes ?pubkey=
      await screen.findByRole('button', { name: /Show all kinds/ });
      fireEvent.click(screen.getByRole('button', { name: /Show all kinds/ }));
      await waitFor(() => expect(listFilters().some(f => f.authors && f.kinds === undefined)).toBe(true));
      relayQuery.fn.mockClear();
      act(() => navigation.go(-1));
      await waitFor(() => expect(location.search).not.toContain('pubkey'));
      await waitFor(() => expect(listFilters().length).toBeGreaterThan(0));
      await new Promise(r => setTimeout(r, 50));
      for (const f of listFilters()) expect(f.kinds ?? f.authors).toBeTruthy();
    });

    it('keeps the plain list on the video kinds', async () => {
      setRelay({ list: [video()] });
      renderEvents('/events');
      await screen.findByText('a video');
      expect(screen.queryByText(/Showing recent content kinds/)).not.toBeInTheDocument();
    });
  });

  describe('Custom Kind', () => {
    it('sends nothing until a valid kind number is entered, then scopes to it', async () => {
      setRelay({ list: [video()] });
      renderEvents('/events');
      await screen.findByText('a video');
      relayQuery.fn.mockClear();
      await pickKind('Custom Kind');
      expect(await screen.findByText('Enter a kind number')).toBeInTheDocument();
      const input = screen.getByLabelText('Kind #');
      fireEvent.change(input, { target: { value: '-5' } });
      await new Promise(r => setTimeout(r, 50));
      expect(listFilters()).toEqual([]);
      fireEvent.change(input, { target: { value: '70000' } }); // above NIP-01's 65535
      expect(screen.getByRole('button', { name: /Refresh/ })).toBeDisabled();
      await new Promise(r => setTimeout(r, 50));
      expect(listFilters()).toEqual([]);
      fireEvent.change(input, { target: { value: '1111' } });
      await waitFor(() => expect(listFilters().some(f => f.kinds?.[0] === 1111)).toBe(true));
      expect(listFilters().every(f => f.kinds)).toBe(true);
    });
  });
});
