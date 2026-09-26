// ABOUTME: The resolved-history view: read a page at a time, listed with the queue, honest about where it stops.
// ABOUTME: Pins the footer's states, its resolved count, and how loaded pages combine with the feed.

import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { nip19 } from 'nostr-tools';
import TestApp from '@/test/TestApp';
import { resolvedPage } from '@/test/resolvedHistory';
import { Reports } from './Reports';

vi.mock('@/components/ReportDetail', () => ({ ReportDetail: () => null }));

const RELAY_URL = 'wss://relay.example';
const hex = (c: string) => c.repeat(64);
const note = (eventId: string) => nip19.noteEncode(eventId);

function eventReport(eventId: string, reportId: string, createdAt: number, category = 'NS-spam') {
  return {
    id: reportId,
    pubkey: hex('9'),
    created_at: createdAt,
    kind: 1984,
    tags: [['e', eventId, 'spam'], ['L', 'social.nos.ontology'], ['l', category, 'social.nos.ontology']],
    content: '',
    sig: 'e'.repeat(128),
  };
}

// The needs-attention feed: an open post, and an old post the relay has banned.
// The browser resolves the banned one itself, and being old it sits at the
// bottom of the history view, below every page loaded so far.
const OPEN = eventReport(hex('1'), hex('a'), 1751001000);
const BANNED_EVENT = hex('2');
const BANNED = eventReport(BANNED_EVENT, hex('b'), 1751000100);
// Resolved history, two pages.
const H1 = eventReport(hex('3'), hex('c'), 1751000900, 'NS-harassment');
const H2 = eventReport(hex('4'), hex('d'), 1751000800);
const H3 = eventReport(hex('5'), hex('e'), 1751000500);
const H4 = eventReport(hex('6'), hex('f'), 1751000400);
const PAGE_ONE_CURSOR = 1751000800;

type Reply = () => Response;
interface WorkerStub {
  feed?: unknown[];
  bannedEvents?: string[];
  // Resolved-history replies by cursor; 'first' is the read with no cursor.
  pages: Record<string, Reply>;
  decisions?: Reply;
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
const ok = (body: unknown): Reply => () => jsonResponse(body);
const fail: Reply = () => jsonResponse({ success: false, error: 'Relay page unconfirmed' }, 502);

function stubWorker(stub: WorkerStub) {
  const calls = { resolved: [] as string[], feed: 0 };
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.pathname === '/api/reports/resolved') {
      calls.resolved.push(url.search);
      const reply = stub.pages[url.searchParams.get('cursor') ?? 'first'];
      return reply ? reply() : jsonResponse({ success: false, error: `no page for ${url.search}` }, 500);
    }
    if (url.pathname === '/api/reports') {
      calls.feed += 1;
      return jsonResponse({ success: true, events: stub.feed ?? [OPEN, BANNED], truncated: false });
    }
    if (url.pathname === '/api/resolution-label-targets') {
      return jsonResponse({ success: true, targets: [], truncated: false, oldest_covered: null });
    }
    if (url.pathname === '/api/resolution-state') {
      return stub.decisions ? stub.decisions() : jsonResponse({ success: true, resolved: [], states: [] });
    }
    if (url.pathname === '/api/relay-rpc') {
      const bannedEventsRead = String(init?.body ?? '').includes('listbannedevents');
      return jsonResponse({
        success: true,
        result: bannedEventsRead ? (stub.bannedEvents ?? [BANNED_EVENT]).map(id => ({ id })) : [],
      });
    }
    return jsonResponse({ success: true });
  }));
  return calls;
}

function renderQueue() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });
  render(
    <TestApp queryClient={queryClient}>
      <Reports relayUrl={RELAY_URL} />
    </TestApp>
  );
  return queryClient;
}

async function openHistory(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByText(note(hex('1')));
  await user.click(screen.getByRole('switch', { name: /hide resolved/i }));
}

const rowFor = (eventId: string) => document.querySelector(`[data-row-key="event:${eventId}"]`) as HTMLElement | null;
const categoryChip = (name: string) =>
  within(screen.getByText('Category').parentElement as HTMLElement).getByText(name);

let consoleError: MockInstance;
beforeEach(() => {
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  consoleError.mockRestore();
});

describe('resolved history is read on demand', () => {
  it('reads no resolved history while resolved reports are hidden', async () => {
    const calls = stubWorker({ pages: { first: ok(resolvedPage([H1], { nextCursor: null, done: true })) } });
    renderQueue();

    await screen.findByText(note(hex('1')));
    expect(calls.resolved).toEqual([]);
  });

  it('reads the first page when Hide resolved goes off, and lists it with the feed', async () => {
    const calls = stubWorker({ pages: { first: ok(resolvedPage([H1, H2], { nextCursor: PAGE_ONE_CURSOR, done: false })) } });
    const user = userEvent.setup();
    renderQueue();
    await openHistory(user);

    expect(await screen.findByText(note(hex('3')))).toBeInTheDocument();
    expect(screen.getByText(note(hex('4')))).toBeInTheDocument();
    expect(screen.getByText(note(hex('1')))).toBeInTheDocument();
    expect(screen.getByText(note(BANNED_EVENT))).toBeInTheDocument();
    expect(calls.resolved).toEqual(['?limit=200']);
  });

  it('loads the next page from the cursor the last one returned, and says where history ends', async () => {
    const calls = stubWorker({
      pages: {
        first: ok(resolvedPage([H1, H2], { nextCursor: PAGE_ONE_CURSOR, done: false })),
        [PAGE_ONE_CURSOR]: ok(resolvedPage([H3, H4], { nextCursor: null, done: true })),
      },
    });
    const user = userEvent.setup();
    renderQueue();
    await openHistory(user);

    expect(await screen.findByText('Showing 3 resolved. More further back.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /load more/i }));

    expect(await screen.findByText('Showing 5 resolved. End of resolved history.')).toBeInTheDocument();
    expect(calls.resolved).toEqual(['?limit=200', `?cursor=${PAGE_ONE_CURSOR}&limit=200`]);
    expect(screen.queryByRole('button', { name: /load more/i })).not.toBeInTheDocument();
  });
});

describe('the history footer counts the rows on screen', () => {
  it('counts resolved rows from both the feed and loaded history, and follows the filters', async () => {
    stubWorker({ pages: { first: ok(resolvedPage([H1, H2], { nextCursor: PAGE_ONE_CURSOR, done: false })) } });
    const user = userEvent.setup();
    renderQueue();
    await openHistory(user);

    // H1 and H2 from history, plus the banned post from the feed. Not the open post.
    expect(await screen.findByText('Showing 3 resolved. More further back.')).toBeInTheDocument();

    // A filter narrows the count to the rows still shown, and the footer says
    // the filter searched only what is loaded.
    await user.click(categoryChip('Harassment'));
    expect(await screen.findByText('Showing 1 resolved. More further back.')).toBeInTheDocument();
    expect(screen.getByText(/filters only search the history loaded so far/i)).toBeInTheDocument();
  });

  it('lists a report once when the feed and a loaded page both hold it', async () => {
    // H1 was reopened after its page was read: it is back in the feed, and the
    // cached page still lists it.
    stubWorker({
      feed: [OPEN, H1, BANNED],
      pages: { first: ok(resolvedPage([H1, H2], { nextCursor: PAGE_ONE_CURSOR, done: false })) },
    });
    const user = userEvent.setup();
    renderQueue();
    await openHistory(user);

    await screen.findByText(note(hex('4')));
    expect(screen.getAllByText(note(hex('3')))).toHaveLength(1);
    expect(within(rowFor(hex('3'))!).getByText('1 report')).toBeInTheDocument();
    // H1 is in the feed and nothing in the browser resolves it: open, not resolved.
    expect(await screen.findByText('Showing 2 resolved. More further back.')).toBeInTheDocument();
  });

  it('keeps the pending-review badge to the targets that view lists, not loaded history', async () => {
    // H1 came back in resolved history and still carries a waiting auto-hide.
    // The pending-review view lists from the feed, which does not hold H1, so
    // counting it would put 2 over a view that lists 1.
    const PENDING = eventReport(hex('7'), hex('8'), 1751000950);
    stubWorker({
      feed: [OPEN, PENDING, BANNED],
      pages: { first: ok(resolvedPage([H1, H2], { nextCursor: PAGE_ONE_CURSOR, done: false })) },
      decisions: ok({
        success: true,
        resolved: [],
        states: [
          { target_type: 'event', target_id: hex('7'), action: 'auto_hidden' },
          { target_type: 'event', target_id: hex('3'), action: 'auto_hidden' },
        ],
      }),
    });
    const user = userEvent.setup();
    renderQueue();
    await openHistory(user);
    await screen.findByText(note(hex('4')));

    expect(document.querySelector('label[for="pending-review"]')).toHaveTextContent(/auto-hidden\)\s*1$/);
    await user.click(screen.getByRole('switch', { name: /pending review/i }));
    expect(await screen.findByText('Grouped (1)')).toBeInTheDocument();
  });

  it('says there are no resolved reports when history is empty and ended', async () => {
    stubWorker({ feed: [OPEN], bannedEvents: [], pages: { first: ok(resolvedPage([], { nextCursor: null, done: true })) } });
    const user = userEvent.setup();
    renderQueue();
    await openHistory(user);

    expect(await screen.findByText('No resolved reports.')).toBeInTheDocument();
  });

  it('does not call an empty page the end when more history exists', async () => {
    // The relay page this was read from held nothing resolved. Older pages may.
    stubWorker({
      feed: [OPEN],
      bannedEvents: [],
      pages: { first: ok(resolvedPage([], { nextCursor: PAGE_ONE_CURSOR, done: false })) },
    });
    const user = userEvent.setup();
    renderQueue();
    await openHistory(user);

    expect(await screen.findByText('Showing 0 resolved. More further back.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /load more/i })).toBeInTheDocument();
    expect(screen.queryByText(/no resolved reports/i)).not.toBeInTheDocument();
  });
});

describe('the history footer never mistakes a stop for an end', () => {
  it('keeps loaded rows and offers a retry when Load more fails', async () => {
    let nextPageFails = true;
    stubWorker({
      pages: {
        first: ok(resolvedPage([H1, H2], { nextCursor: PAGE_ONE_CURSOR, done: false })),
        [PAGE_ONE_CURSOR]: () => (nextPageFails
          ? fail()
          : jsonResponse(resolvedPage([H3, H4], { nextCursor: null, done: true }))),
      },
    });
    const user = userEvent.setup();
    renderQueue();
    await openHistory(user);

    await user.click(await screen.findByRole('button', { name: /load more/i }));
    expect(await screen.findByText(/couldn't load the next page/i)).toBeInTheDocument();
    expect(screen.getByText(note(hex('3')))).toBeInTheDocument();
    expect(screen.queryByText(/end of resolved history/i)).not.toBeInTheDocument();

    nextPageFails = false;
    await user.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByText(note(hex('5')))).toBeInTheDocument();
  });

  it('says resolved history failed to load rather than that there is none', async () => {
    stubWorker({ pages: { first: fail } });
    const user = userEvent.setup();
    renderQueue();
    await openHistory(user);

    expect(await screen.findByText(/couldn't load resolved history/i)).toBeInTheDocument();
    expect(screen.queryByText(/no resolved reports/i)).not.toBeInTheDocument();
    // The feed's rows are still listed.
    expect(screen.getByText(note(hex('1')))).toBeInTheDocument();
  });

  it('says when history cannot be followed further back, instead of that it ended', async () => {
    stubWorker({ pages: { first: ok(resolvedPage([H1], { nextCursor: null, done: false })) } });
    const user = userEvent.setup();
    renderQueue();
    await openHistory(user);

    expect(await screen.findByText(/can't be followed further back/i)).toBeInTheDocument();
    expect(screen.queryByText(/end of resolved history/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /load more/i })).not.toBeInTheDocument();
  });

  it('says when a page skipped reports or could not read every resolution label', async () => {
    stubWorker({
      pages: {
        first: ok(resolvedPage([H1], {
          nextCursor: PAGE_ONE_CURSOR, done: false, skippedWithinSecond: true, resolutionTruncated: true,
        })),
      },
    });
    const user = userEvent.setup();
    renderQueue();
    await openHistory(user);

    expect(await screen.findByText(/filed within the same second were skipped/i)).toBeInTheDocument();
    expect(screen.getByText(/not every resolution label could be read/i)).toBeInTheDocument();
  });

  it('says a failed re-read of loaded history failed, and never that history ended', async () => {
    let historyFails = false;
    stubWorker({
      pages: {
        first: () => (historyFails ? fail() : jsonResponse(resolvedPage([H1], { nextCursor: null, done: true }))),
      },
    });
    const user = userEvent.setup();
    const queryClient = renderQueue();
    await openHistory(user);
    expect(await screen.findByText('Showing 2 resolved. End of resolved history.')).toBeInTheDocument();

    // What a moderator's own resolve or reopen does (invalidateResolutionState):
    // every loaded page is re-read. This time the re-read fails.
    historyFails = true;
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['reports-resolved'] });
    });

    expect(await screen.findByText(/couldn't refresh resolved history/i)).toBeInTheDocument();
    expect(screen.queryByText(/end of resolved history/i)).not.toBeInTheDocument();
    // What was loaded earlier stays listed.
    expect(screen.getByText(note(hex('3')))).toBeInTheDocument();

    historyFails = false;
    await user.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByText('Showing 2 resolved. End of resolved history.')).toBeInTheDocument();
  });
});
