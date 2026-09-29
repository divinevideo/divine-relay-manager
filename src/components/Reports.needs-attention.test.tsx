// ABOUTME: The queue reads every report that needs attention, says when that read stopped early,
// ABOUTME: keeps a deep-linked resolved report listed through the polls that do not carry it,
// ABOUTME: and keeps that report reachable when the queue itself fails to load.

import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { QueryClient, useQuery } from '@tanstack/react-query';
import { nip19 } from 'nostr-tools';
import TestApp from '@/test/TestApp';
import { EMPTY_RESOLVED_PAGE } from '@/test/resolvedHistory';
import { Reports } from './Reports';

// Renders only which report the pane opened and how many reports it was given.
vi.mock('@/components/ReportDetail', () => ({
  ReportDetail: ({ report, allReportsForTarget, allReports }: {
    report: { id: string } | null;
    allReportsForTarget?: unknown[];
    allReports?: unknown[];
  }) =>
    report ? (
      <div
        data-testid="report-detail"
        data-target-reports={allReportsForTarget?.length ?? 'none'}
        data-all-reports={allReports?.length ?? 'none'}
      >
        {report.id}
      </div>
    ) : null,
}));

// Spy on the real hook to read the cadence each queue read asks for.
vi.mock('@tanstack/react-query', async (orig) => {
  const actual = await orig<typeof import('@tanstack/react-query')>();
  return { ...actual, useQuery: vi.fn(actual.useQuery) };
});

const RELAY_URL = 'wss://relay.example';

function eventReport(id: string, eventId: string) {
  return {
    id,
    pubkey: 'b'.repeat(64),
    created_at: 1751000000,
    kind: 1984,
    tags: [['e', eventId, 'spam']],
    content: '',
    sig: 'e'.repeat(128),
  };
}

const OPEN_EVENT = '6'.repeat(64);
const OPEN_REPORT = eventReport('5'.repeat(64), OPEN_EVENT);
const RESOLVED_EVENT = '4'.repeat(64);
const RESOLVED_REPORT = eventReport('3'.repeat(64), RESOLVED_EVENT);
const LATER_EVENT = '8'.repeat(64);
const LATER_REPORT = eventReport('7'.repeat(64), LATER_EVENT);

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function stubWorker(feed: Record<string, unknown>, feedStatus = 200) {
  const counts = { feed: 0 };
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('/api/reports/resolved')) return jsonResponse(EMPTY_RESOLVED_PAGE);
    if (url.includes('/api/reports?event=')) return jsonResponse({ success: true, events: [RESOLVED_REPORT] });
    if (url.includes('/api/reports?pubkey=')) return jsonResponse({ success: true, events: [] });
    if (url.includes('/api/reports')) {
      counts.feed += 1;
      return jsonResponse({ success: true, events: [OPEN_REPORT], truncated: false, ...feed }, feedStatus);
    }
    if (url.includes('/api/resolution-label-targets')) {
      return jsonResponse({ success: true, targets: [], truncated: false, oldest_covered: null });
    }
    if (url.includes('/api/resolution-state')) {
      return jsonResponse({ success: true, resolved: [{ target_type: 'event', target_id: RESOLVED_EVENT }], states: [] });
    }
    if (url.includes('/api/decisions')) return jsonResponse({ success: true, decisions: [] });
    if (url.includes('/api/relay-rpc')) return jsonResponse({ success: true, result: [] });
    return jsonResponse({ success: true });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, counts };
}

// A worker whose feed read waits until released, then answers with the open
// report. Every other read answers as stubWorker does.
function stubWorkerWithHeldFeed() {
  let release = () => {};
  const held = new Promise<void>(r => { release = r; });
  const { fetchMock } = stubWorker({});
  const answer = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    if (String(input instanceof Request ? input.url : input).includes('needs_attention=1')) await held;
    return answer(input);
  });
  return { release: () => act(async () => { release(); }) };
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

let consoleError: MockInstance;
beforeEach(() => {
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  consoleError.mockRestore();
  window.history.pushState({}, '', '/');
});

describe('the queue reads the needs-attention feed', () => {
  it('re-reads the feed once a minute while resolution state keeps its 15s poll', async () => {
    // The feed walks every report and every resolution label, so it polls
    // once a minute. Handled work still leaves within about 15s, through the
    // decisions read below.
    stubWorker({});
    renderQueue();
    await screen.findByText(nip19.noteEncode(OPEN_EVENT));

    const optionsFor = (root: string) => vi.mocked(useQuery).mock.calls
      .map(([options]) => options)
      .find(options => (options.queryKey as unknown[])[0] === root);
    expect(optionsFor('reports')?.refetchInterval).toBe(60 * 1000);
    expect(optionsFor('resolution-state')?.refetchInterval).toBe(15 * 1000);
  });

  it('re-reads resolution labels once a minute', async () => {
    // The label read walks every page of resolution labels, so it keeps its
    // 60s poll; a moderator's own label clears through invalidation, not this
    // poll.
    stubWorker({});
    renderQueue();
    await screen.findByText(nip19.noteEncode(OPEN_EVENT));

    const labelOptions = vi.mocked(useQuery).mock.calls
      .map(([options]) => options)
      .find(options => (options.queryKey as unknown[])[0] === 'resolution-label-targets');
    expect(labelOptions?.refetchInterval).toBe(60 * 1000);
  });

  it('asks for every report that needs attention, not the newest 200', async () => {
    const { fetchMock } = stubWorker({});
    renderQueue();

    await screen.findByText(nip19.noteEncode(OPEN_EVENT));
    const urls = fetchMock.mock.calls.map(([input]) => String(input));
    expect(urls.some(url => url.endsWith('/api/reports?needs_attention=1'))).toBe(true);
    expect(urls.some(url => url.endsWith('/api/reports'))).toBe(false);
  });

  it('says the queue may be missing reports when the walk stopped early, dated in UTC', async () => {
    // 04:53 UTC, so the date differs from the test runner's Pacific zone.
    stubWorker({ truncated: true, oldest_covered: 1751000000 });
    renderQueue();

    const banner = await screen.findByText(/stopped reading reports early/i);
    const text = banner.textContent ?? '';
    expect(text).toContain('Jun');
    expect(text).toContain('27');
    expect(text).toContain('2025');
    expect(text).toContain('UTC');
  });

  it('says nothing about missing reports when the walk completed', async () => {
    stubWorker({ truncated: false });
    renderQueue();

    await screen.findByText(nip19.noteEncode(OPEN_EVENT));
    expect(screen.queryByText(/stopped reading reports early/i)).not.toBeInTheDocument();
  });

  it('keeps a deep-linked resolved report listed after the next poll', async () => {
    // The usual way into a resolved report is a link from its closed ticket.
    // The feed never carries a resolved target, so the report arrives through
    // the targeted lookup and must stay listed through polls that omit it.
    const feed: Record<string, unknown> = {};
    const { counts } = stubWorker(feed);
    window.history.pushState({}, '', `/reports?event=${RESOLVED_EVENT}`);
    const queryClient = renderQueue();

    await waitFor(() => expect(window.location.pathname).toBe(`/reports/${RESOLVED_REPORT.id}`));
    // Resolved, so the queue turned Hide resolved off to list it.
    expect(await screen.findByText(nip19.noteEncode(RESOLVED_EVENT))).toBeInTheDocument();

    // The next poll also carries a new report. The query notifies the screen
    // on a later tick than the fetch settles, so waiting for that row is what
    // shows the poll's result has rendered before the check below.
    feed.events = [LATER_REPORT, OPEN_REPORT];
    const before = counts.feed;
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['reports', RELAY_URL], exact: true });
    });
    expect(counts.feed).toBeGreaterThan(before);
    expect(await screen.findByText(nip19.noteEncode(LATER_EVENT))).toBeInTheDocument();

    expect(screen.getByText(nip19.noteEncode(RESOLVED_EVENT))).toBeInTheDocument();
  });

  it('drops a deep-linked report from the list when the relay changes', async () => {
    // The screen stays mounted across an environment switch, so reports held
    // for a deep link must not follow the moderator onto the other relay.
    const feed: Record<string, unknown> = {};
    stubWorker(feed);
    window.history.pushState({}, '', `/reports?event=${RESOLVED_EVENT}`);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });
    const { rerender } = render(
      <TestApp queryClient={queryClient}>
        <Reports relayUrl={RELAY_URL} />
      </TestApp>
    );

    await waitFor(() => expect(window.location.pathname).toBe(`/reports/${RESOLVED_REPORT.id}`));
    expect(await screen.findByText(nip19.noteEncode(RESOLVED_EVENT))).toBeInTheDocument();

    // The other relay's feed carries a report this one did not, so its row on
    // screen shows that feed has rendered before the check below.
    feed.events = [LATER_REPORT, OPEN_REPORT];
    rerender(
      <TestApp queryClient={queryClient}>
        <Reports relayUrl="wss://relay-two.example" />
      </TestApp>
    );
    expect(await screen.findByText(nip19.noteEncode(LATER_EVENT))).toBeInTheDocument();

    // The resolved report is listed only because the deep link turned Hide
    // resolved off. Pinned so the row's absence below can come only from the
    // relay key, not from the resolution filter.
    expect(screen.getByRole('switch', { name: 'Hide resolved' })).not.toBeChecked();
    expect(screen.queryByText(nip19.noteEncode(RESOLVED_EVENT))).not.toBeInTheDocument();
  });

  it('opens a deep-linked report while the queue fails to load, and still says the queue failed', async () => {
    // A moderator following a ticket's link during a feed outage can still act
    // on the report the lookup found. The queue is not listed: it never
    // loaded, and an empty or partial list would read as nothing to do.
    stubWorker({ success: false, error: 'Relay query timed out before EOSE' }, 502);
    window.history.pushState({}, '', `/reports?event=${RESOLVED_EVENT}`);
    renderQueue();

    const pane = await screen.findByTestId('report-detail');
    expect(pane).toHaveTextContent(RESOLVED_REPORT.id);
    // The pane still gets the target's reports from the lookup, so "Why This
    // Was Reported" is not blank.
    expect(pane).toHaveAttribute('data-target-reports', '1');
    expect(pane).toHaveAttribute('data-all-reports', '1');
    expect(screen.getByText(/Failed to load reports/)).toBeInTheDocument();
    expect(screen.queryByText(nip19.noteEncode(RESOLVED_EVENT))).not.toBeInTheDocument();
    expect(screen.queryByText('No reports found')).not.toBeInTheDocument();
    expect(screen.queryByText(/^\d+ pending/)).not.toBeInTheDocument();
  });

  it("shows a deep link's gone pane while the queue fails to load, beside the failure", async () => {
    // The lookup answers even when the queue does not, so its verdict on the
    // target is shown rather than hidden behind the queue's failure.
    stubWorker({ success: false, error: 'Relay query timed out before EOSE' }, 502);
    window.history.pushState({}, '', `/reports?pubkey=${'c'.repeat(64)}`);
    renderQueue();

    expect(await screen.findByText('Report no longer on relay')).toBeInTheDocument();
    expect(screen.getByText(/Failed to load reports/)).toBeInTheDocument();
  });

  it('lists the queue once Try again re-reads a feed that failed to load', async () => {
    // Nothing else re-reads a failed feed for up to a minute: the header's
    // Refresh is not on screen in this state.
    stubWorker({ success: false, error: 'Relay query timed out before EOSE' }, 502);
    renderQueue();
    const failure = (await screen.findByText(/Failed to load reports/)).closest('[role="alert"]') as HTMLElement;

    stubWorker({});
    await userEvent.setup().click(within(failure).getByRole('button', { name: 'Try again' }));

    expect(await screen.findByText(nip19.noteEncode(OPEN_EVENT))).toBeInTheDocument();
    expect(screen.queryByText(/Failed to load reports/)).not.toBeInTheDocument();
  });

  it('lists the queue once Try again re-reads a failed feed beside a deep-linked report', async () => {
    stubWorker({ success: false, error: 'Relay query timed out before EOSE' }, 502);
    window.history.pushState({}, '', `/reports?event=${RESOLVED_EVENT}`);
    renderQueue();
    await screen.findByTestId('report-detail');
    const failure = screen.getByText(/Failed to load reports/).closest('[role="alert"]') as HTMLElement;

    stubWorker({});
    await userEvent.setup().click(within(failure).getByRole('button', { name: 'Try again' }));

    expect(await screen.findByText(nip19.noteEncode(OPEN_EVENT))).toBeInTheDocument();
    expect(screen.queryByText(/Failed to load reports/)).not.toBeInTheDocument();
  });

  it('keeps the deep-linked report open beside the failure while Try again re-reads the feed', async () => {
    // With no data, a re-read puts the feed back to pending with no error
    // (query-core fetchState). The report the moderator is working in, and any
    // dialog open in it, must not be swapped for the loading skeleton.
    stubWorker({ success: false, error: 'Relay query timed out before EOSE' }, 502);
    window.history.pushState({}, '', `/reports?event=${RESOLVED_EVENT}`);
    renderQueue();
    await screen.findByTestId('report-detail');
    const failure = screen.getByText(/Failed to load reports/).closest('[role="alert"]') as HTMLElement;

    const feed = stubWorkerWithHeldFeed();
    await userEvent.setup().click(within(failure).getByRole('button', { name: 'Try again' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Try again' })).toBeDisabled());
    expect(screen.getByTestId('report-detail')).toHaveTextContent(RESOLVED_REPORT.id);
    expect(screen.getByText('Failed to load reports. Trying again…')).toBeInTheDocument();
    expect(screen.queryByTestId('reports-loading-skeleton')).not.toBeInTheDocument();

    // A re-read that succeeds lists the queue, and the report stays open.
    await feed.release();
    expect(await screen.findByText(nip19.noteEncode(OPEN_EVENT))).toBeInTheDocument();
    expect(screen.getByTestId('report-detail')).toHaveTextContent(RESOLVED_REPORT.id);
    expect(screen.queryByText(/Failed to load reports/)).not.toBeInTheDocument();
  });

  it('keeps the deep-linked report open beside the failure while the poll re-reads the feed', async () => {
    // The minute poll keeps firing on a failed feed, unasked, for as long as
    // the outage lasts. refetchQueries stands in for it.
    stubWorker({ success: false, error: 'Relay query timed out before EOSE' }, 502);
    window.history.pushState({}, '', `/reports?event=${RESOLVED_EVENT}`);
    const queryClient = renderQueue();
    await screen.findByTestId('report-detail');

    stubWorkerWithHeldFeed();
    await act(async () => { void queryClient.refetchQueries({ queryKey: ['reports'] }); });

    await waitFor(() => expect(screen.getByRole('button', { name: 'Try again' })).toBeDisabled());
    expect(screen.getByTestId('report-detail')).toHaveTextContent(RESOLVED_REPORT.id);
    expect(screen.getByText('Failed to load reports. Trying again…')).toBeInTheDocument();
    expect(screen.queryByTestId('reports-loading-skeleton')).not.toBeInTheDocument();
  });
});
