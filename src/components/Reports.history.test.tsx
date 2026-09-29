// ABOUTME: The resolved-history view: read a page at a time, listed with the queue, honest about where it stops.
// ABOUTME: Pins the footer's states, its resolved count, and how loaded pages combine with the feed.

import { act, render, screen, waitFor, within } from '@testing-library/react';
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

type Reply = () => Response | Promise<Response>;
interface WorkerStub {
  feed?: unknown[];
  bannedEvents?: string[];
  // The banned-posts read, when it should not answer with the list above.
  bannedEventsReply?: Reply;
  // The resolution-labels read, when it should not answer with no labels.
  labelsReply?: Reply;
  // Resolved-history replies by cursor; 'first' is the read with no cursor.
  pages: Record<string, Reply>;
  decisions?: Reply;
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
const ok = (body: unknown): Reply => () => jsonResponse(body);
const fail: Reply = () => jsonResponse({ success: false, error: 'Relay page unconfirmed' }, 502);
// A read that never answers.
const hang: Reply = () => new Promise<Response>(() => {});

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
      if (stub.labelsReply) return stub.labelsReply();
      return jsonResponse({ success: true, targets: [], truncated: false, oldest_covered: null });
    }
    if (url.pathname === '/api/resolution-state') {
      return stub.decisions ? stub.decisions() : jsonResponse({ success: true, resolved: [], states: [] });
    }
    if (url.pathname === '/api/relay-rpc') {
      const bannedEventsRead = String(init?.body ?? '').includes('listbannedevents');
      if (bannedEventsRead && stub.bannedEventsReply) return stub.bannedEventsReply();
      return jsonResponse({
        success: true,
        result: bannedEventsRead ? (stub.bannedEvents ?? [BANNED_EVENT]).map(id => ({ id })) : [],
      });
    }
    return jsonResponse({ success: true });
  }));
  return calls;
}

function renderQueue(selectedReportId?: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });
  render(
    <TestApp queryClient={queryClient}>
      <Reports relayUrl={RELAY_URL} selectedReportId={selectedReportId} />
    </TestApp>
  );
  return queryClient;
}

async function openHistory(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByText(note(hex('1')));
  await user.click(screen.getByRole('switch', { name: /hide resolved/i }));
}

// With an empty feed there is no open row to wait for; the empty list is.
async function openHistoryOverEmptyFeed(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByText('No reports found');
  await user.click(screen.getByRole('switch', { name: /hide resolved/i }));
}

const rowFor = (eventId: string) => document.querySelector(`[data-row-key="event:${eventId}"]`) as HTMLElement | null;
const key = (c: string) => `event:${hex(c)}`;
const rowKeys = () => Array.from(document.querySelectorAll('[data-row-key]')).map(el => el.getAttribute('data-row-key'));
const categoryChip = (name: string) =>
  within(screen.getByText('Category').parentElement as HTMLElement).getByText(name);
// The selected row carries the selection ring.
const isSelectedRow = (eventId: string) => !!rowFor(eventId)?.className.includes('ring-primary');

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

describe('an unfinished history never reads as an empty list', () => {
  // The queue itself is empty, and the moderator turns Hide resolved off to
  // look at past work. Until history is read to its end, the list says nothing
  // and the footer says where the read stands.
  it('does not say no reports were found while the first page is loading', async () => {
    stubWorker({ feed: [], pages: { first: hang } });
    const user = userEvent.setup();
    renderQueue();
    await openHistoryOverEmptyFeed(user);

    expect(await screen.findByText(/loading resolved history/i)).toBeInTheDocument();
    expect(screen.queryByText('No reports found')).not.toBeInTheDocument();
  });

  it('does not say no reports were found when the first page failed', async () => {
    stubWorker({ feed: [], pages: { first: fail } });
    const user = userEvent.setup();
    renderQueue();
    await openHistoryOverEmptyFeed(user);

    expect(await screen.findByText(/couldn't load resolved history/i)).toBeInTheDocument();
    expect(screen.queryByText('No reports found')).not.toBeInTheDocument();
  });

  it('does not say no reports were found when an empty page has more behind it', async () => {
    stubWorker({ feed: [], pages: { first: ok(resolvedPage([], { nextCursor: PAGE_ONE_CURSOR, done: false })) } });
    const user = userEvent.setup();
    renderQueue();
    await openHistoryOverEmptyFeed(user);

    expect(await screen.findByText('Showing 0 resolved. More further back.')).toBeInTheDocument();
    expect(screen.queryByText('No reports found')).not.toBeInTheDocument();
  });

  it('does not say no reports were found in the All tab either, while history is loading', async () => {
    stubWorker({ feed: [], pages: { first: hang } });
    const user = userEvent.setup();
    renderQueue();
    await openHistoryOverEmptyFeed(user);
    await user.click(screen.getByRole('tab', { name: /all \(/i }));

    expect(await screen.findByText(/loading resolved history/i)).toBeInTheDocument();
    expect(screen.queryByText('No reports found')).not.toBeInTheDocument();
  });

  it('says no reports were found once history is read to its end and holds none', async () => {
    stubWorker({ feed: [], pages: { first: ok(resolvedPage([], { nextCursor: null, done: true })) } });
    const user = userEvent.setup();
    renderQueue();
    await openHistoryOverEmptyFeed(user);

    expect(await screen.findByText('No resolved reports.')).toBeInTheDocument();
    expect(screen.getByText('No reports found')).toBeInTheDocument();
  });
});

// The history view's resolved count reads the ban lists and labels as much as
// the default view's filter does, so it waits on them, and names them when
// they failed, the same way (#186, #221).
describe('the history view never counts on a resolution source it lacks', () => {
  it('keeps the banned-posts warning in history, and never says there are no resolved reports', async () => {
    stubWorker({ bannedEventsReply: fail, pages: { first: ok(resolvedPage([], { nextCursor: null, done: true })) } });
    const user = userEvent.setup();
    renderQueue();
    await user.click(await screen.findByRole('button', { name: /show the queue anyway/i }));
    const overrideWarning = /Banned posts unavailable\), so some of these may already be handled/;
    expect(await screen.findByText(overrideWarning)).toBeInTheDocument();

    await openHistory(user);
    // The banned post is listed, but unconfirmed as resolved: its ban was never read.
    expect(await screen.findByText(note(BANNED_EVENT))).toBeInTheDocument();
    const footer = await screen.findByTestId('resolved-history-footer');
    await waitFor(() => expect(footer).not.toHaveTextContent(/Loading/));

    expect(screen.getByText(overrideWarning)).toBeInTheDocument();
    expect(footer).toHaveTextContent("Resolved count unavailable: Banned posts couldn't be read.");
    expect(footer).not.toHaveTextContent('No resolved reports.');
    expect(footer).not.toHaveTextContent(/Showing \d+ resolved|End of resolved history/);
  });

  it('names every source it went on without', async () => {
    stubWorker({ labelsReply: fail, bannedEventsReply: fail, pages: { first: ok(resolvedPage([], { nextCursor: null, done: true })) } });
    const user = userEvent.setup();
    renderQueue();
    await user.click(await screen.findByRole('button', { name: /show the queue anyway/i }));
    await openHistory(user);

    const footer = await screen.findByTestId('resolved-history-footer');
    await waitFor(() => expect(footer).not.toHaveTextContent(/Loading/));
    expect(footer).toHaveTextContent("Resolved count unavailable: Resolution labels and Banned posts couldn't be read.");
  });

  it('keeps Load more beside the unavailable count while more history remains', async () => {
    stubWorker({ bannedEventsReply: fail, pages: { first: ok(resolvedPage([H1], { nextCursor: PAGE_ONE_CURSOR, done: false })) } });
    const user = userEvent.setup();
    renderQueue();
    await user.click(await screen.findByRole('button', { name: /show the queue anyway/i }));
    await openHistory(user);
    await screen.findByText(note(hex('3')));

    // One history row is resolved; the banned post, unread, is not counted.
    // A count of 1 would be short. The rows are real, so paging goes on.
    const footer = screen.getByTestId('resolved-history-footer');
    expect(footer).toHaveTextContent("Resolved count unavailable: Banned posts couldn't be read.");
    expect(footer).not.toHaveTextContent(/Showing \d+ resolved/);
    expect(screen.getByRole('button', { name: /load more/i })).toBeEnabled();
  });

  it('states no count when a re-read of loaded history fails while a source is unread, and keeps Try again', async () => {
    // A relay outage can fail the ban list and the history re-read together.
    // The pages on screen are the last good read, but the count is taken live
    // from them without the unread source, so it would be short.
    let historyFails = false;
    stubWorker({
      bannedEventsReply: fail,
      pages: { first: () => (historyFails ? fail() : jsonResponse(resolvedPage([H1], { nextCursor: null, done: true }))) },
    });
    const user = userEvent.setup();
    const queryClient = renderQueue();
    await user.click(await screen.findByRole('button', { name: /show the queue anyway/i }));
    await openHistory(user);
    const footer = await screen.findByTestId('resolved-history-footer');
    await waitFor(() => expect(footer).toHaveTextContent("Resolved count unavailable: Banned posts couldn't be read."));

    historyFails = true;
    await act(async () => { await queryClient.refetchQueries({ queryKey: ['reports-resolved'] }); });

    await waitFor(() => expect(screen.getByTestId('resolved-history-footer')).toHaveTextContent(/Couldn't refresh resolved history/));
    const failedFooter = screen.getByTestId('resolved-history-footer');
    expect(failedFooter).toHaveTextContent("Resolved count unavailable: Banned posts couldn't be read.");
    expect(failedFooter).not.toHaveTextContent(/Showing \d+ resolved/);
    expect(within(failedFooter).getByRole('button', { name: /try again/i })).toBeEnabled();
  });

  it('keeps counting on a ban list whose refresh failed, under the stale banner', async () => {
    // A stale source still holds data, so the banned post is still known to be
    // resolved: the count stands, as the default view's filter does.
    let bannedEventsFail = false;
    stubWorker({
      bannedEventsReply: () => (bannedEventsFail
        ? fail()
        : jsonResponse({ success: true, result: [{ id: BANNED_EVENT }] })),
      pages: { first: ok(resolvedPage([H1], { nextCursor: null, done: true })) },
    });
    const user = userEvent.setup();
    const queryClient = renderQueue();
    await openHistory(user);
    await screen.findByText('Showing 2 resolved. End of resolved history.');

    bannedEventsFail = true;
    await act(async () => { await queryClient.refetchQueries({ queryKey: ['banned-events'] }); });

    expect(await screen.findByText(/showing resolution state from/i)).toBeInTheDocument();
    expect(screen.getByTestId('resolved-history-footer')).toHaveTextContent('Showing 2 resolved. End of resolved history.');
  });

  it('waits for the ban lists before listing history, rather than counting without them', async () => {
    // A link to a report the feed does not hold opens history as soon as the
    // feed answers, which can be before the ban lists do.
    const calls = stubWorker({ bannedEventsReply: hang, pages: { first: ok(resolvedPage([H1], { nextCursor: null, done: true })) } });
    const queryClient = renderQueue(H1.id);
    await waitFor(() => expect(calls.resolved).toHaveLength(1));
    await waitFor(() => expect(queryClient.getQueryState(['reports-resolved', RELAY_URL])?.status).toBe('success'));
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });

    expect(screen.getByTestId('reports-loading-skeleton')).toBeInTheDocument();
    expect(screen.queryByTestId('resolved-history-footer')).not.toBeInTheDocument();
  });
});

describe('a link to a resolved report opens it', () => {
  // /reports/<id> is what a row click writes to the address bar, so it is how
  // a report is shared and what a reload lands on. The needs-attention feed
  // does not carry a resolved report; resolved history does.
  it('opens a report from resolved history on arrival, with no click', async () => {
    const calls = stubWorker({ pages: { first: ok(resolvedPage([H1], { nextCursor: null, done: true })) } });
    renderQueue(H1.id);

    await waitFor(() => expect(isSelectedRow(hex('3'))).toBe(true));
    expect(screen.getByRole('switch', { name: /hide resolved/i })).not.toBeChecked();
    expect(calls.resolved).toEqual(['?limit=200']);
  });

  it('opens history once for a link it cannot find, and then leaves Hide resolved to the moderator', async () => {
    // An id older than page 1: history is opened for it once. Turning Hide
    // resolved back on must not be undone by another look for the same id.
    const calls = stubWorker({ pages: { first: ok(resolvedPage([H2], { nextCursor: PAGE_ONE_CURSOR, done: false })) } });
    const user = userEvent.setup();
    renderQueue(H4.id);
    expect(await screen.findByText('Showing 2 resolved. More further back.')).toBeInTheDocument();
    expect(calls.resolved).toEqual(['?limit=200']);

    await user.click(screen.getByRole('switch', { name: /hide resolved/i }));
    await screen.findByText(note(hex('1')));
    expect(screen.getByRole('switch', { name: /hide resolved/i })).toBeChecked();
    expect(screen.queryByTestId('resolved-history-footer')).not.toBeInTheDocument();
  });

  it('looks in history again for the same link in another environment', async () => {
    // Opening history once per id is per environment: the other relay's history
    // is a different read, and it may hold the report.
    const calls = stubWorker({ pages: { first: ok(resolvedPage([H2], { nextCursor: PAGE_ONE_CURSOR, done: false })) } });
    const user = userEvent.setup();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });
    const { rerender } = render(
      <TestApp queryClient={queryClient}>
        <Reports relayUrl={RELAY_URL} selectedReportId={H4.id} />
      </TestApp>
    );
    await screen.findByText('Showing 2 resolved. More further back.');
    await user.click(screen.getByRole('switch', { name: /hide resolved/i }));
    await screen.findByText(note(hex('1')));
    expect(calls.resolved).toHaveLength(1);

    rerender(
      <TestApp queryClient={queryClient}>
        <Reports relayUrl="wss://relay-two.example" selectedReportId={H4.id} />
      </TestApp>
    );

    await waitFor(() => expect(calls.resolved).toHaveLength(2));
    expect(await screen.findByText('Showing 2 resolved. More further back.')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: /hide resolved/i })).not.toBeChecked();
  });

  it('leaves Hide resolved alone for a report the feed holds', async () => {
    const calls = stubWorker({ pages: { first: ok(resolvedPage([H1], { nextCursor: null, done: true })) } });
    renderQueue(OPEN.id);

    await waitFor(() => expect(isSelectedRow(hex('1'))).toBe(true));
    expect(screen.getByRole('switch', { name: /hide resolved/i })).toBeChecked();
    expect(calls.resolved).toEqual([]);
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

  it('holds Load more while loaded history is being re-read, so the re-read is not thrown away', async () => {
    // Load more would cancel the re-read (query-core cancels an in-flight
    // fetch for the next one), and the resolution it was fetching would stay
    // missing from history until the next re-read.
    const X = eventReport(hex('0'), hex('7'), 1751000950);
    let firstReads = 0;
    let releaseReRead: (() => void) | undefined;
    stubWorker({
      pages: {
        first: () => {
          firstReads += 1;
          if (firstReads === 1) return jsonResponse(resolvedPage([H1, H2], { nextCursor: PAGE_ONE_CURSOR, done: false }));
          return new Promise<Response>(resolve => {
            releaseReRead = () => resolve(jsonResponse(resolvedPage([X, H1, H2], { nextCursor: PAGE_ONE_CURSOR, done: false })));
          });
        },
        [PAGE_ONE_CURSOR]: ok(resolvedPage([H3], { nextCursor: null, done: true })),
      },
    });
    const user = userEvent.setup();
    const queryClient = renderQueue();
    await openHistory(user);
    await screen.findByText('Showing 3 resolved. More further back.');
    expect(screen.getByRole('button', { name: /load more/i })).toBeEnabled();

    await act(async () => { queryClient.invalidateQueries({ queryKey: ['reports-resolved'] }); });
    await waitFor(() => expect(firstReads).toBe(2));

    await waitFor(() => expect(screen.getByRole('button', { name: /load more/i })).toBeDisabled());

    await act(async () => { releaseReRead?.(); });
    expect(await screen.findByText(note(hex('0')))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /load more/i })).toBeEnabled();
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
    // Every resolution source was read, so the count stands: the history row
    // and the feed's banned post.
    expect(screen.getByTestId('resolved-history-footer')).toHaveTextContent('Showing 2 resolved, as loaded earlier.');
    // What was loaded earlier stays listed.
    expect(screen.getByText(note(hex('3')))).toBeInTheDocument();

    historyFails = false;
    await user.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByText('Showing 2 resolved. End of resolved history.')).toBeInTheDocument();
  });

  it('shows Try again working while a failed first page is re-read', async () => {
    // With nothing loaded, a re-read puts the query back to pending
    // (query-core fetchState), so the footer shows loading, not the failure.
    let reply: Reply = fail;
    stubWorker({ pages: { first: () => reply() } });
    const user = userEvent.setup();
    renderQueue();
    await openHistory(user);
    expect(await screen.findByText(/couldn't load resolved history/i)).toBeInTheDocument();

    reply = hang;
    await user.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByText(/loading resolved history/i)).toBeInTheDocument();
    expect(screen.queryByText(/couldn't load resolved history/i)).not.toBeInTheDocument();
  });

  it('shows Try again working while a failed re-read of loaded history is retried', async () => {
    let reply: Reply = ok(resolvedPage([H1], { nextCursor: null, done: true }));
    stubWorker({ pages: { first: () => reply() } });
    const user = userEvent.setup();
    const queryClient = renderQueue();
    await openHistory(user);
    expect(await screen.findByText('Showing 2 resolved. End of resolved history.')).toBeInTheDocument();

    reply = fail;
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['reports-resolved'] });
    });
    expect(await screen.findByText(/couldn't refresh resolved history/i)).toBeInTheDocument();

    reply = hang;
    await user.click(screen.getByRole('button', { name: /try again/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /try again/i })).toBeDisabled());
  });
});

describe('the history view keeps what is on screen in order', () => {
  it('lists newest first, so a loaded page never reorders rows already shown', async () => {
    // Page two adds an older report on H2's post. Under "Most reports" that
    // post would jump to the top; newest-first leaves it where it was.
    const H2_AGAIN = eventReport(hex('4'), hex('7'), 1751000500);
    stubWorker({
      pages: {
        first: ok(resolvedPage([H1, H2], { nextCursor: PAGE_ONE_CURSOR, done: false })),
        [PAGE_ONE_CURSOR]: ok(resolvedPage([H2_AGAIN, H4], { nextCursor: null, done: true })),
      },
    });
    const user = userEvent.setup();
    renderQueue();
    await openHistory(user);
    await screen.findByText(note(hex('4')));

    const before = rowKeys();
    expect(before).toEqual([key('1'), key('3'), key('4'), key('2')]);

    await user.click(screen.getByRole('button', { name: /load more/i }));
    await screen.findByText(note(hex('6')));

    const after = rowKeys();
    // The banned post, at the bottom, moves down as older rows land above it;
    // nothing already shown changes order relative to anything else.
    expect(after.filter(k => before.includes(k))).toEqual(before);
    expect(after).toEqual([key('1'), key('3'), key('4'), key('6'), key('2')]);
  });

  it('fixes the sort control to Newest First while history is listed, and gives it back after', async () => {
    stubWorker({ pages: { first: ok(resolvedPage([H1], { nextCursor: null, done: true })) } });
    const user = userEvent.setup();
    renderQueue();
    await screen.findByText(note(hex('1')));
    expect(screen.getByRole('combobox')).not.toBeDisabled();

    await openHistory(user);
    expect(await screen.findByText(/newest first while resolved history is shown/i)).toBeInTheDocument();
    expect(screen.getByRole('combobox')).toBeDisabled();
    // The control shows the order the list is actually in.
    expect(screen.getByRole('combobox')).toHaveTextContent('Newest First');

    await user.click(screen.getByRole('switch', { name: /hide resolved/i }));
    expect(screen.getByRole('combobox')).not.toBeDisabled();
    expect(screen.getByRole('combobox')).toHaveTextContent('Most Reports');
  });

  it('re-reads loaded history when the moderator refreshes', async () => {
    // Another moderator's resolutions reach loaded history only when it is re-read.
    const calls = stubWorker({ pages: { first: ok(resolvedPage([H1], { nextCursor: null, done: true })) } });
    const user = userEvent.setup();
    renderQueue();
    await openHistory(user);
    await screen.findByText(note(hex('3')));
    expect(calls.resolved).toHaveLength(1);

    await user.click(screen.getByTitle(/last updated|refresh/i));

    await waitFor(() => expect(calls.resolved).toHaveLength(2));
  });
});

describe('loaded history survives the queue around it', () => {
  it('keeps loaded pages through a poll of the queue', async () => {
    const calls = stubWorker({
      pages: {
        first: ok(resolvedPage([H1, H2], { nextCursor: PAGE_ONE_CURSOR, done: false })),
        [PAGE_ONE_CURSOR]: ok(resolvedPage([H3, H4], { nextCursor: null, done: true })),
      },
    });
    const user = userEvent.setup();
    const queryClient = renderQueue();
    await openHistory(user);
    await user.click(await screen.findByRole('button', { name: /load more/i }));
    await screen.findByText(note(hex('5')));
    const historyReads = calls.resolved.length;
    const feedReads = calls.feed;

    // What the feed's poll does. React Query tells the screen about the new
    // data on a later tick, so wait one before looking: without it the checks
    // below run against the render from before the poll and cannot see
    // anything the poll set off.
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['reports', RELAY_URL], exact: true });
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    expect(calls.feed).toBeGreaterThan(feedReads);
    expect(screen.getByText(note(hex('5')))).toBeInTheDocument();
    expect(calls.resolved).toHaveLength(historyReads);
  });

  it('keeps loaded pages through a Retry of a failed resolution source', async () => {
    let decisionsFail = false;
    const calls = stubWorker({
      pages: {
        first: ok(resolvedPage([H1, H2], { nextCursor: PAGE_ONE_CURSOR, done: false })),
        [PAGE_ONE_CURSOR]: ok(resolvedPage([H3, H4], { nextCursor: null, done: true })),
      },
      decisions: () => (decisionsFail
        ? jsonResponse({ success: false, error: 'cold start timeout' }, 500)
        : jsonResponse({ success: true, resolved: [], states: [] })),
    });
    const user = userEvent.setup();
    const queryClient = renderQueue();
    await openHistory(user);
    await user.click(await screen.findByRole('button', { name: /load more/i }));
    await screen.findByText(note(hex('5')));
    const historyReads = calls.resolved.length;

    // The decisions read loses its data and fails, so the blocked pane
    // replaces the list and offers Retry.
    decisionsFail = true;
    await act(async () => { await queryClient.resetQueries({ queryKey: ['resolution-state'] }); });
    expect(await screen.findByText(/resolution state is unavailable/i)).toBeInTheDocument();

    decisionsFail = false;
    await user.click(screen.getByRole('button', { name: /^retry$/i }));

    // Back to the list with both pages, and history was not re-read.
    expect(await screen.findByText(note(hex('5')))).toBeInTheDocument();
    expect(calls.resolved).toHaveLength(historyReads);
  });
});

describe('Load more keeps the viewport on the row being read', () => {
  const ROW_HEIGHT = 100;
  let rects: MockInstance | undefined;
  afterEach(() => rects?.mockRestore());

  // jsdom does no layout. Lay list rows out in a column, ROW_HEIGHT each, in
  // document order, scrolled by the viewport's scrollTop.
  function layOutRows() {
    const box = (top: number, height: number) =>
      ({ top, bottom: top + height, left: 0, right: 0, width: 0, height, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
    rects = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const viewport = document.querySelector('[data-radix-scroll-area-viewport]') as HTMLElement | null;
      if (!viewport) return box(0, 0);
      if (this === viewport) return box(0, 300);
      if (this instanceof HTMLElement && this.dataset.rowKey) {
        const index = Array.from(viewport.querySelectorAll('[data-row-key]')).indexOf(this);
        return box(index * ROW_HEIGHT - viewport.scrollTop, ROW_HEIGHT);
      }
      return box(0, 0);
    });
  }

  it('keeps the row at the top of the viewport in place when older rows land above it', async () => {
    stubWorker({
      pages: {
        first: ok(resolvedPage([H1, H2], { nextCursor: PAGE_ONE_CURSOR, done: false })),
        [PAGE_ONE_CURSOR]: ok(resolvedPage([H3, H4], { nextCursor: null, done: true })),
      },
    });
    const user = userEvent.setup();
    renderQueue();
    await openHistory(user);
    await screen.findByText(note(hex('4')));
    layOutRows();

    // Rows: open, H1, H2, banned. Scroll so the banned post is the top row.
    const viewport = document.querySelector('[data-radix-scroll-area-viewport]') as HTMLElement;
    viewport.scrollTop = 3 * ROW_HEIGHT;

    await user.click(screen.getByRole('button', { name: /load more/i }));
    await screen.findByText(note(hex('6')));

    // H3 and H4 landed above the banned post, two rows further down. The
    // viewport followed it, so it is still the row at the top.
    expect(rowKeys()).toEqual([key('1'), key('3'), key('4'), key('5'), key('6'), key('2')]);
    expect(viewport.scrollTop).toBe(5 * ROW_HEIGHT);
  });
});
