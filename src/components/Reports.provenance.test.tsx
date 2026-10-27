// ABOUTME: Pins the reporting-app line on queue cards: a group lists each named app
// ABOUTME: once and counts reports that name none; an individual card names its own (#132).

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TestApp from '@/test/TestApp';
import { Reports } from './Reports';
import { appLine } from '@/test/appLine';

vi.mock('@/components/ReportDetail', () => ({ ReportDetail: () => null }));

const TARGET_EVENT = 'c'.repeat(64);
const REPORTED = 'd'.repeat(64);

function report(idByte: string, reporterByte: string, created_at: number, extraTags: string[][]) {
  return {
    id: idByte.repeat(64),
    pubkey: reporterByte.repeat(64),
    created_at,
    kind: 1984,
    tags: [['e', TARGET_EVENT, 'spam'], ['p', REPORTED, 'spam'], ...extraTags],
    content: 'spam',
    sig: 'e'.repeat(128),
  };
}

// Three reports on one target: two named apps (one twice) and one naming none.
const REPORTS = [
  report('1', 'a', 1751000300, [['client', 'App A']]),
  report('2', 'b', 1751000200, [['client', 'App B']]),
  report('3', '7', 1751000100, [['client', 'App A']]),
  report('4', '8', 1751000000, []),
];

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('/api/reports')) return jsonResponse({ success: true, events: REPORTS });
    if (url.includes('/api/resolution-label-targets')) return jsonResponse({ success: true, targets: [], truncated: false, oldest_covered: null });
    if (url.includes('/api/resolution-state')) return jsonResponse({ success: true, resolved: [], states: [] });
    if (url.includes('/api/relay-rpc')) return jsonResponse({ success: true, result: [] });
    return jsonResponse({ success: true });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderQueue() {
  return render(
    <TestApp>
      <Reports relayUrl="wss://relay.example" />
    </TestApp>,
  );
}

describe('Reports queue reporting-app line', () => {
  it('lists each named app once on a group card and counts the reports that name none', async () => {
    renderQueue();
    expect(await screen.findByText(appLine('Filed via App A, App B · 1 with no app named'))).toBeInTheDocument();
  });

  it("names each report's own app on its individual card", async () => {
    const user = userEvent.setup();
    renderQueue();
    await screen.findByText(/4 reports$/);
    await user.click(screen.getByRole('tab', { name: /^All/ }));

    expect(await screen.findAllByText(appLine('Filed via App A'))).toHaveLength(2);
    expect(screen.getByText(appLine('Filed via App B'))).toBeInTheDocument();
    expect(screen.getByText('No app named')).toBeInTheDocument();
  });
});
