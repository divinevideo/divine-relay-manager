// ABOUTME: The needs-attention feed is grouped once per read, not once per consumer.
// ABOUTME: A feed can hold tens of thousands of reports, so each extra grouping is a visible stall on every poll.

import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { nip19 } from 'nostr-tools';
import TestApp from '@/test/TestApp';
import { EMPTY_RESOLVED_PAGE } from '@/test/resolvedHistory';
import { consolidateReports } from '@/lib/consolidateReports';
import { datedHandling, groupResolutionStatus, reportResolutionStatus } from '@/lib/reportResolution';
import { Reports } from './Reports';

vi.mock('@/components/ReportDetail', () => ({ ReportDetail: () => null }));
// Real behaviour, with calls recorded.
vi.mock('@/lib/consolidateReports', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/consolidateReports')>();
  return { ...actual, consolidateReports: vi.fn(actual.consolidateReports) };
});
vi.mock('@/lib/reportResolution', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/reportResolution')>();
  // The screen's two ways in: a target's group, and a single report. And the
  // reading of the whole decision log, which only that log and the labels
  // should rebuild.
  return {
    ...actual,
    groupResolutionStatus: vi.fn(actual.groupResolutionStatus),
    reportResolutionStatus: vi.fn(actual.reportResolutionStatus),
    datedHandling: vi.fn(actual.datedHandling),
  };
});

function report(id: string, createdAt: number, targetTag: string[]) {
  return {
    id,
    pubkey: 'b'.repeat(64),
    created_at: createdAt,
    kind: 1984,
    tags: [targetTag, ['L', 'social.nos.ontology'], ['l', 'NS-spam', 'social.nos.ontology']],
    content: '',
    sig: 'e'.repeat(128),
  };
}

const FIRST_EVENT = '1'.repeat(64);
const SECOND_EVENT = '2'.repeat(64);
const FEED = [
  report('a'.repeat(64), 1751000400, ['e', FIRST_EVENT, 'spam']),
  report('c'.repeat(64), 1751000300, ['e', SECOND_EVENT, 'spam']),
  report('d'.repeat(64), 1751000200, ['p', '3'.repeat(64), 'spam']),
];
const FEED_IDS = FEED.map(r => r.id);

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

let consoleError: MockInstance;
beforeEach(() => {
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.mocked(consolidateReports).mockClear();
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('/api/reports/resolved')) return jsonResponse(EMPTY_RESOLVED_PAGE);
    if (url.includes('/api/reports')) return jsonResponse({ success: true, events: FEED, truncated: false });
    if (url.includes('/api/resolution-label-targets')) {
      return jsonResponse({ success: true, targets: [], truncated: false, oldest_covered: null });
    }
    if (url.includes('/api/resolution-state')) return jsonResponse({ success: true, resolved: [], states: [] });
    if (url.includes('/api/relay-rpc')) return jsonResponse({ success: true, result: [] });
    return jsonResponse({ success: true });
  }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  consoleError.mockRestore();
});

function renderQueue() {
  render(
    <TestApp queryClient={new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } })}>
      <Reports relayUrl="wss://relay.example" />
    </TestApp>
  );
}

describe('grouping the needs-attention feed', () => {
  it('groups the feed once, however many views of the queue read it', async () => {
    renderQueue();
    // Both posts are listed, so the feed has landed and every view of it has rendered.
    expect(await screen.findByText(nip19.noteEncode(FIRST_EVENT))).toBeInTheDocument();
    expect(screen.getByText(nip19.noteEncode(SECOND_EVENT))).toBeInTheDocument();

    const feedGroupings = vi.mocked(consolidateReports).mock.calls
      .filter(([events]) => FEED_IDS.every(id => events.some(event => event.id === id)));
    expect(feedGroupings).toHaveLength(1);
  });

  it('does not scan the rows again when only the freshness text changes', async () => {
    // The "updated Ns ago" text ticks every five seconds and re-renders the whole
    // screen. Faking the clock and the interval lets the test make it tick.
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    renderQueue();
    expect(await screen.findByText(nip19.noteEncode(FIRST_EVENT))).toBeInTheDocument();
    expect(screen.getByText('just now')).toBeInTheDocument();
    expect(vi.mocked(groupResolutionStatus)).toHaveBeenCalled();

    vi.mocked(groupResolutionStatus).mockClear();
    vi.mocked(reportResolutionStatus).mockClear();
    await act(async () => { vi.advanceTimersByTime(5000); });

    expect(screen.getByText('5s ago')).toBeInTheDocument();
    expect(vi.mocked(groupResolutionStatus)).not.toHaveBeenCalled();
    expect(vi.mocked(reportResolutionStatus)).not.toHaveBeenCalled();
  });

  // The handled-before rule (#324) reads every decision row on record. A feed
  // poll brings new arrivals every minute; it must not rebuild that reading.
  it('does not re-read the decision log when a feed poll brings new arrivals', async () => {
    let polls = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes('/api/reports/resolved')) return jsonResponse(EMPTY_RESOLVED_PAGE);
      if (url.includes('/api/reports')) {
        polls += 1;
        return jsonResponse({ success: true, events: FEED, truncated: false, report_arrivals: { [FEED_IDS[0]]: 1751000400 + polls } });
      }
      if (url.includes('/api/resolution-label-targets')) {
        return jsonResponse({ success: true, targets: [], truncated: false, oldest_covered: null });
      }
      if (url.includes('/api/resolution-state')) {
        return jsonResponse({
          success: true, resolved: [], states: [],
          handling_rows: [{ target_type: 'event', target_id: SECOND_EVENT, action: 'reviewed', moderator_pubkey: 'f'.repeat(64), at: 1751000000 }],
        });
      }
      if (url.includes('/api/relay-rpc')) return jsonResponse({ success: true, result: [] });
      return jsonResponse({ success: true });
    }));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });
    render(<TestApp queryClient={queryClient}><Reports relayUrl="wss://relay.example" /></TestApp>);
    expect(await screen.findByText(nip19.noteEncode(FIRST_EVENT))).toBeInTheDocument();
    expect(vi.mocked(datedHandling)).toHaveBeenCalled();

    vi.mocked(datedHandling).mockClear();
    vi.mocked(groupResolutionStatus).mockClear();
    await act(async () => { await queryClient.refetchQueries({ queryKey: ['reports', 'wss://relay.example'] }); });

    // The poll did land and was read: the rows were re-dated by it.
    expect(polls).toBeGreaterThan(1);
    await waitFor(() => expect(vi.mocked(groupResolutionStatus)).toHaveBeenCalled());
    expect(vi.mocked(datedHandling)).not.toHaveBeenCalled();
  });
});
