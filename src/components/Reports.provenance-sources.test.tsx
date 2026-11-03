// ABOUTME: The reporting-app line on queue cards built from resolved history pages and from a
// ABOUTME: deep link's targeted lookup, not only from the needs-attention feed (#132 on #284).

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import TestApp from '@/test/TestApp';
import { resolvedPage } from '@/test/resolvedHistory';
import { appLine } from '@/test/appLine';
import { Reports } from './Reports';

vi.mock('@/components/ReportDetail', () => ({ ReportDetail: () => null }));

const FEED_EVENT = 'c'.repeat(64);
const HISTORY_EVENT = '1'.repeat(64);
const LINKED_EVENT = '2'.repeat(64);

function report(id: string, event: string, createdAt: number, client: string) {
  return {
    id, pubkey: '5'.repeat(64), created_at: createdAt, kind: 1984,
    tags: [['e', event, 'spam'], ['p', 'd'.repeat(64), 'spam'], ['client', client]],
    content: 'spam', sig: 'e'.repeat(128),
  };
}
const FEED_REPORT = report('a'.repeat(64), FEED_EVENT, 1751000300, 'Feed App');
const HISTORY_REPORT = report('b'.repeat(64), HISTORY_EVENT, 1751000200, 'History App');
const LINKED_REPORT = report('f'.repeat(64), LINKED_EVENT, 1751000100, 'Linked App');

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function stubWorker() {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('/api/reports/resolved')) {
      return jsonResponse(resolvedPage([HISTORY_REPORT], { nextCursor: null, done: true }));
    }
    if (url.includes('/api/reports?needs_attention=1')) return jsonResponse({ success: true, events: [FEED_REPORT], truncated: false });
    if (url.includes('/api/reports?')) {
      return jsonResponse({ success: true, events: url.includes(LINKED_EVENT) ? [LINKED_REPORT] : [], truncated: false });
    }
    if (url.includes('/api/resolution-label-targets')) return jsonResponse({ success: true, targets: [], truncated: false, oldest_covered: null });
    if (url.includes('/api/resolution-state')) return jsonResponse({ success: true, resolved: [], states: [] });
    if (url.includes('/api/relay-rpc')) return jsonResponse({ success: true, result: [] });
    return jsonResponse({ success: true });
  }));
}

const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.pushState({}, '', '/');
});

describe('the reporting-app line beyond the feed', () => {
  it('names the app on a row from a resolved-history page', async () => {
    stubWorker();
    const user = userEvent.setup();
    render(<TestApp queryClient={newClient()}><Reports relayUrl="wss://relay.example" /></TestApp>);
    expect(await screen.findByText(appLine('Filed via Feed App'))).toBeInTheDocument();

    await user.click(screen.getByRole('switch', { name: /hide resolved/i }));
    expect(await screen.findByText(appLine('Filed via History App'))).toBeInTheDocument();
  });

  it("names the app on a row a deep link's targeted lookup found", async () => {
    stubWorker();
    window.history.pushState({}, '', `/reports?event=${LINKED_EVENT}`);
    render(<TestApp queryClient={newClient()}><Reports relayUrl="wss://relay.example" /></TestApp>);
    expect(await screen.findByText(appLine('Filed via Linked App'))).toBeInTheDocument();
  });
});
