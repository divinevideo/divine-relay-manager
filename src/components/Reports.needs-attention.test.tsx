// ABOUTME: The queue reads every report that needs attention, says when that read stopped early,
// ABOUTME: and keeps a deep-linked resolved report listed through the polls that do not carry it.

import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { QueryClient, useQuery } from '@tanstack/react-query';
import { nip19 } from 'nostr-tools';
import TestApp from '@/test/TestApp';
import { EMPTY_RESOLVED_PAGE } from '@/test/resolvedHistory';
import { Reports } from './Reports';

vi.mock('@/components/ReportDetail', () => ({ ReportDetail: () => null }));

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

function stubWorker(feed: Record<string, unknown>) {
  const counts = { feed: 0 };
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('/api/reports/resolved')) return jsonResponse(EMPTY_RESOLVED_PAGE);
    if (url.includes('/api/reports?event=')) return jsonResponse({ success: true, events: [RESOLVED_REPORT] });
    if (url.includes('/api/reports')) {
      counts.feed += 1;
      return jsonResponse({ success: true, events: [OPEN_REPORT], truncated: false, ...feed });
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

    expect(screen.queryByText(nip19.noteEncode(RESOLVED_EVENT))).not.toBeInTheDocument();
  });
});
