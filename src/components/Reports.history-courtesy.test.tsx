// ABOUTME: A /reports/<id> link the feed does not hold turns Hide resolved off to look in history;
// ABOUTME: a switch that opens for it later hands back the moderator's Hide resolved, not that "off".

import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { useLocation } from 'react-router-dom';
import TestApp from '@/test/TestApp';
import { resolvedPage } from '@/test/resolvedHistory';
import { Reports } from './Reports';

const RELAY_URL = 'wss://relay.example';

vi.mock('@/components/ReportDetail', () => ({
  ReportDetail: ({ report }: { report: { id: string } }) => <div data-testid="detail" data-report-id={report.id} />,
}));

const HANDLED_EVENT = '1'.repeat(64);
const SPAM_EVENT = '3'.repeat(64);

function report(id: string, createdAt: number, tags: string[][]) {
  return { id, pubkey: '5'.repeat(64), created_at: createdAt, kind: 1984, tags, content: '', sig: 'f'.repeat(128) };
}
// A post a person already handled: only resolved history holds its report.
const HANDLED_REPORT = report('a'.repeat(64), 1751000100, [['e', HANDLED_EVENT, 'spam'], ['p', '8'.repeat(64)]]);
const SPAM_REPORT = report('c'.repeat(64), 1751000050, [['e', SPAM_EVENT, 'spam'], ['p', '9'.repeat(64)]]);

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function RoutedReports() {
  const { pathname } = useLocation();
  const reportId = pathname.match(/^\/reports\/([0-9a-f]{64})$/)?.[1];
  return <Reports relayUrl={RELAY_URL} selectedReportId={reportId} />;
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

describe('a /reports/<id> link found only in resolved history', () => {
  it('hands back Hide resolved on when a switch the link opened later closes', async () => {
    // The post is auto-hidden after the link landed, so it joins the switch.
    const state = { autoHidden: false };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes('/api/reports?needs_attention=1')) return jsonResponse({ success: true, events: [SPAM_REPORT], truncated: false });
      if (url.includes('/api/reports/resolved')) {
        return jsonResponse(resolvedPage([HANDLED_REPORT], { nextCursor: null, done: true }));
      }
      if (url.includes('/api/resolution-label-targets')) {
        return jsonResponse({ success: true, targets: [], truncated: false, oldest_covered: null });
      }
      if (url.includes('/api/resolution-state')) {
        return jsonResponse({
          success: true,
          resolved: [{ target_type: 'event', target_id: HANDLED_EVENT }],
          states: state.autoHidden ? [{ target_type: 'event', target_id: HANDLED_EVENT, action: 'auto_hidden' }] : [],
        });
      }
      if (url.includes('/api/relay-rpc')) return jsonResponse({ success: true, result: [] });
      return jsonResponse({ success: true });
    }));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });
    const user = userEvent.setup();
    window.history.pushState({}, '', `/reports/${HANDLED_REPORT.id}`);
    render(<TestApp queryClient={queryClient}><RoutedReports /></TestApp>);

    const hideResolved = () => screen.getByRole('switch', { name: /hide resolved/i });
    await waitFor(() => expect(screen.getByTestId('detail').dataset.reportId).toBe(HANDLED_REPORT.id));
    expect(hideResolved()).not.toBeChecked();

    state.autoHidden = true;
    await act(async () => { await queryClient.invalidateQueries({ queryKey: ['resolution-state'] }); });
    const pending = await screen.findByRole('switch', { name: /pending review/i });
    await waitFor(() => expect(pending).toBeChecked());

    // Off, the switch leaves the toolbar: no feed row sits behind it.
    await user.click(pending);
    await waitFor(() => expect(screen.queryByRole('switch', { name: /pending review/i })).not.toBeInTheDocument());
    expect(hideResolved()).toBeChecked();
  });
});

// A cached feed old enough that the visit re-reads it, and a re-read held
// until the test releases it, answering with `reread`.
function holdFeedReRead(reread: unknown[]) {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const reads = { feed: 0, history: 0 };
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('/api/reports?needs_attention=1')) {
      reads.feed += 1;
      await gate;
      return jsonResponse({ success: true, events: reread, truncated: false });
    }
    if (url.includes('/api/reports/resolved')) {
      reads.history += 1;
      return jsonResponse(resolvedPage([HANDLED_REPORT], { nextCursor: null, done: true }));
    }
    if (url.includes('/api/resolution-label-targets')) {
      return jsonResponse({ success: true, targets: [], truncated: false, oldest_covered: null });
    }
    if (url.includes('/api/resolution-state')) {
      return jsonResponse({ success: true, resolved: [{ target_type: 'event', target_id: HANDLED_EVENT }], states: [] });
    }
    if (url.includes('/api/relay-rpc')) return jsonResponse({ success: true, result: [] });
    return jsonResponse({ success: true });
  }));
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });
  queryClient.setQueryData(['reports', RELAY_URL], {
    events: [SPAM_REPORT], truncated: false, oldestCovered: null, automatedTargets: [],
  }, { updatedAt: Date.now() - 120_000 });
  return { queryClient, reads, release };
}

describe('a /reports/<id> link while the cached feed is re-read', () => {
  const hideResolved = () => screen.getByRole('switch', { name: /hide resolved/i });

  it('selects a report filed since the cached read without looking in history', async () => {
    // Still unhandled, so only the re-read the visit starts holds it.
    const NEW_REPORT = report('d'.repeat(64), 1751000900, [['e', '4'.repeat(64), 'spam'], ['p', '7'.repeat(64)]]);
    const { queryClient, reads, release } = holdFeedReRead([NEW_REPORT, SPAM_REPORT]);
    window.history.pushState({}, '', `/reports/${NEW_REPORT.id}`);
    render(<TestApp queryClient={queryClient}><RoutedReports /></TestApp>);

    await waitFor(() => expect(reads.feed).toBe(1));
    expect(await screen.findByRole('switch', { name: /hide resolved/i })).toBeChecked();
    expect(reads.history).toBe(0);

    await act(async () => { release(); });
    await waitFor(() => expect(screen.getByTestId('detail').dataset.reportId).toBe(NEW_REPORT.id));
    expect(hideResolved()).toBeChecked();
    expect(reads.history).toBe(0);
  });

  it('still looks in history once a re-read that changes nothing settles', async () => {
    // The re-read answers with the cached events, so the feed keeps its
    // identity: only the settling fetch can re-run the check.
    const { queryClient, reads, release } = holdFeedReRead([SPAM_REPORT]);
    window.history.pushState({}, '', `/reports/${HANDLED_REPORT.id}`);
    render(<TestApp queryClient={queryClient}><RoutedReports /></TestApp>);

    await waitFor(() => expect(reads.feed).toBe(1));
    expect(await screen.findByRole('switch', { name: /hide resolved/i })).toBeChecked();
    expect(reads.history).toBe(0);

    await act(async () => { release(); });
    await waitFor(() => expect(screen.getByTestId('detail').dataset.reportId).toBe(HANDLED_REPORT.id));
    expect(hideResolved()).not.toBeChecked();
  });
});
