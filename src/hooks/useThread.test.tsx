// ABOUTME: Pins which events useThread treats as the reported event's ancestors.
// ABOUTME: A list's e tags are its items, never a parent post.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { NostrEvent, NostrFilter } from '@nostrify/nostrify';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const query = vi.hoisted(() => vi.fn());
// The REST API and the external relay hint are the other two places an original
// can come from. Both find nothing unless a test sets them up.
const fetchRest = vi.hoisted(() => vi.fn());
const hintQuery = vi.hoisted(() => vi.fn());

vi.mock('@nostrify/react', () => ({
  useNostr: () => ({ nostr: { query } }),
}));
vi.mock('@/lib/funnelcakeApi', () => ({ fetchFunnelcakeEvent: fetchRest }));
vi.mock('@nostrify/nostrify', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@nostrify/nostrify')>()),
  NRelay1: class { query = hintQuery; close = vi.fn(); },
}));

// nostr-tools cannot verify under jsdom; this accepts exactly the pre-signed fixtures.
vi.mock('nostr-tools', async (importOriginal) => {
  const { verifyKnownSignedEvent } = await import('@/test/signedEvents');
  return { ...(await importOriginal<typeof import('nostr-tools')>()), verifyEvent: verifyKnownSignedEvent };
});

import { useThread } from './useThread';
import { SIGNED_VIDEO } from '@/test/signedEvents';

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const AUTHOR = 'a'.repeat(64);
const OTHER_AUTHOR = 'b'.repeat(64);
const LIST_ID = 'c'.repeat(64);
const FIRST_ITEM_ID = '1'.repeat(64);
const SECOND_ITEM_ID = '2'.repeat(64);

function makeEvent(id: string, kind: number, pubkey: string, tags: string[][]): NostrEvent {
  return { id, pubkey, created_at: 1751000000, kind, tags, content: '', sig: 'f'.repeat(128) };
}

/** Serves the events by id; any reply or comment filter finds nothing. */
function serve(events: NostrEvent[]) {
  query.mockImplementation(async (filters: NostrFilter[]) => {
    const ids = filters.flatMap((filter) => filter.ids ?? []);
    return events.filter((event) => ids.includes(event.id));
  });
}

/** Every event id the hook asked the relay for by id. */
function requestedIds(): string[] {
  return query.mock.calls.flatMap(([filters]) =>
    (filters as NostrFilter[]).flatMap((filter) => filter.ids ?? []));
}

describe('useThread ancestors', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not treat the first video of a reported list as its parent post', async () => {
    const list = makeEvent(LIST_ID, 30005, AUTHOR, [
      ['d', 'faves'],
      ['e', FIRST_ITEM_ID],
      ['e', SECOND_ITEM_ID],
    ]);
    serve([list, makeEvent(FIRST_ITEM_ID, 34236, OTHER_AUTHOR, [['d', 'clip']])]);

    const { result } = renderHook(() => useThread(LIST_ID), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data?.event?.id).toBe(LIST_ID);
    expect(result.current.data?.ancestors).toEqual([]);
    expect(requestedIds()).not.toContain(FIRST_ITEM_ID);
  });

  it('still reads the first e tag of an unmarked reply as its parent', async () => {
    const parent = makeEvent(FIRST_ITEM_ID, 1, OTHER_AUTHOR, []);
    const reply = makeEvent(LIST_ID, 1, AUTHOR, [['e', FIRST_ITEM_ID]]);
    serve([reply, parent]);

    const { result } = renderHook(() => useThread(LIST_ID), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data?.ancestors.map((event) => event.id)).toEqual([FIRST_ITEM_ID]);
  });
});

// The repost's embedded copy is the reposter's writing, and the media buttons
// act on the original's files, so the original counts only once it checks out
// as the event the repost's e tag names (#337).
describe('useThread repost original', () => {
  const REPOST_ID = '9'.repeat(64);
  const repostWith = (content: string): NostrEvent => ({
    ...makeEvent(REPOST_ID, 6, AUTHOR, [['e', SIGNED_VIDEO.id], ['p', SIGNED_VIDEO.pubkey]]),
    content,
  });
  // The copy with its files swapped, keeping the original's id and signature.
  const forged: NostrEvent = {
    ...SIGNED_VIDEO,
    tags: [['imeta', `url https://media.divine.video/${'e'.repeat(64)}`, 'm video/mp4']],
  };

  const API_URL = 'https://api.example';
  const RELAY_HINT = 'wss://hint.example';

  beforeEach(() => {
    vi.clearAllMocks();
    fetchRest.mockReset().mockResolvedValue(null);
    hintQuery.mockReset().mockResolvedValue([]);
  });

  it.each([
    ['text', 'not-a-hex-id/../x?y'],
    ['hex that is too short', 'abc123'],
    ['empty', ''],
  ])('looks up nothing for a repost whose e tag is %s', async (_, value) => {
    // The id goes into a request URL and a relay filter. Only an event id can
    // be the original, so anything else is never sent anywhere.
    serve([{ ...makeEvent(REPOST_ID, 6, AUTHOR, [['e', value]]), content: '' }]);

    const { result } = renderHook(() => useThread(REPOST_ID, 3, API_URL, RELAY_HINT), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data?.repostedEvent).toBeNull();
    expect(fetchRest.mock.calls.map(([, id]) => id)).not.toContain(value);
    expect(requestedIds()).not.toContain(value);
    expect(hintQuery.mock.calls.flatMap(([filters]) => (filters as NostrFilter[]).flatMap((filter) => filter.ids ?? [])))
      .not.toContain(value);
  });

  it('asks for the original by its lower-case id when the e tag is in upper case', async () => {
    // Event ids are lower-case hex and a relay matches them exactly, so an id
    // sent as the tag wrote it finds nothing. The tag still names the event.
    const upper = SIGNED_VIDEO.id.toUpperCase();
    serve([{ ...makeEvent(REPOST_ID, 6, AUTHOR, [['e', upper]]), content: '' }, SIGNED_VIDEO]);

    const { result } = renderHook(() => useThread(REPOST_ID), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data?.repostedEvent).toEqual(SIGNED_VIDEO);
    expect(requestedIds()).not.toContain(upper);
  });

  it('takes an embedded copy that is the signed event the e tag names', async () => {
    serve([repostWith(JSON.stringify(SIGNED_VIDEO))]);

    const { result } = renderHook(() => useThread(REPOST_ID), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data?.repostedEvent).toEqual(SIGNED_VIDEO);
  });

  it('fetches the original when the embedded copy does not check out', async () => {
    serve([repostWith(JSON.stringify(forged)), SIGNED_VIDEO]);

    const { result } = renderHook(() => useThread(REPOST_ID), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data?.repostedEvent).toEqual(SIGNED_VIDEO);
  });

  it('has no original when the fetched one does not check out either', async () => {
    serve([repostWith(JSON.stringify(forged)), forged]);

    const { result } = renderHook(() => useThread(REPOST_ID), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data?.repostedEvent).toBeNull();
    expect(result.current.data?.isRepost).toBe(true);
    // A repost is not a reply: its e tag names what it reposts, so the rejected
    // original must not come back in, unchecked, as the post it replies to.
    expect(result.current.data?.ancestors).toEqual([]);
  });

  it.each([
    ['marked root', ['e', 'TARGET', '', 'root']],
    ['marked reply', ['e', 'TARGET', '', 'reply']],
    ['as an upper-case E tag', ['E', 'TARGET']],
  ])('collects no ancestors from a repost whose e tag is %s', async (_, shape) => {
    const tag = (shape as string[]).map((part) => (part === 'TARGET' ? SIGNED_VIDEO.id : part));
    const repost: NostrEvent = {
      ...makeEvent(REPOST_ID, 6, AUTHOR, [tag, ['e', SIGNED_VIDEO.id], ['p', SIGNED_VIDEO.pubkey]]),
      content: JSON.stringify(forged),
    };
    serve([repost, forged]);

    const { result } = renderHook(() => useThread(REPOST_ID), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data?.repostedEvent).toBeNull();
    expect(result.current.data?.ancestors).toEqual([]);
  });

  // Each place the original can be fetched from, holding only the event it is given.
  const SOURCES: Array<[string, (held: NostrEvent) => void]> = [
    ['the REST API', (held) => {
      fetchRest.mockImplementation(async (_url: string, id: string) => (id === SIGNED_VIDEO.id ? held : null));
    }],
    ['the external relay hint', (held) => {
      hintQuery.mockImplementation(async (filters: NostrFilter[]) =>
        (filters.some((filter) => filter.ids?.includes(SIGNED_VIDEO.id)) ? [held] : []));
    }],
  ];

  it.each(SOURCES)('takes an original fetched from %s when it checks out', async (_, hold) => {
    serve([repostWith('')]);
    hold(SIGNED_VIDEO);

    const { result } = renderHook(() => useThread(REPOST_ID, 3, API_URL, RELAY_HINT), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data?.repostedEvent).toEqual(SIGNED_VIDEO);
  });

  it.each(SOURCES)('refuses an original fetched from %s whose files were changed', async (_, hold) => {
    // The hint comes from the reporter, and the REST API and relays are only as
    // honest as what they hold: a fetched original is checked like a copy.
    serve([repostWith('')]);
    hold(forged);

    const { result } = renderHook(() => useThread(REPOST_ID, 3, API_URL, RELAY_HINT), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data?.repostedEvent).toBeNull();
  });

  it('accepts a fetched original whose id arrives in upper case', async () => {
    serve([repostWith('')]);
    query.mockImplementation(async (filters: NostrFilter[]) => {
      const ids = filters.flatMap((filter) => filter.ids ?? []);
      const events: NostrEvent[] = [repostWith(''), { ...SIGNED_VIDEO, id: SIGNED_VIDEO.id.toUpperCase() }];
      return events.filter((event) => ids.includes(event.id.toLowerCase()));
    });

    const { result } = renderHook(() => useThread(REPOST_ID), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // The whole event, so the id comes back in lower case.
    expect(result.current.data?.repostedEvent).toEqual(SIGNED_VIDEO);
  });
});
