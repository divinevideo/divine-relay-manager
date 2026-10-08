// ABOUTME: Pins which events useThread treats as the reported event's ancestors.
// ABOUTME: A list's e tags are its items, never a parent post.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { NostrEvent, NostrFilter } from '@nostrify/nostrify';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const query = vi.hoisted(() => vi.fn());

vi.mock('@nostrify/react', () => ({
  useNostr: () => ({ nostr: { query } }),
}));

import { useThread } from './useThread';

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
