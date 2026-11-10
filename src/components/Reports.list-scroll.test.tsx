// ABOUTME: The report list must stay reachable when the filter header is taller than the space left for it.
// ABOUTME: Pins the list card's scroll contract; jsdom does no layout, so the real scroll was checked in a browser.
//
// The list card sits in a fixed-height shell. Its filter header (view mode,
// sort, type, category chips, Pending review, Hide resolved) is about 330 px
// and grows with more categories. The list below it took only the leftover
// height (flex-1 min-h-0) inside a card that hid its overflow, so on a short
// window the list shrank to a sliver or to nothing and there was no way to
// scroll to it. Measured with stubbed data: 97 px of list at 1280x720, 0 px at
// 1366x600. The list now keeps a minimum height and the card scrolls when the
// header and that minimum do not fit, the same shape as the detail pane's fix
// in #240.
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import TestApp from '@/test/TestApp';
import { EMPTY_RESOLVED_PAGE } from '@/test/resolvedHistory';
import { Reports } from './Reports';

vi.mock('@/components/ReportDetail', () => ({
  ReportDetail: () => <div data-testid="detail" />,
}));

const REPORT = {
  id: 'a'.repeat(64),
  pubkey: 'b'.repeat(64),
  created_at: 1751000000,
  kind: 1984,
  tags: [
    ['e', 'c'.repeat(64), 'spam'],
    ['p', 'd'.repeat(64), 'spam'],
  ],
  content: 'reported',
  sig: 'e'.repeat(128),
};

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

let consoleError: MockInstance;
beforeEach(() => {
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('/api/reports/resolved')) return jsonResponse(EMPTY_RESOLVED_PAGE);
    if (url.includes('/api/reports')) return jsonResponse({ success: true, events: [REPORT] });
    if (url.includes('/api/resolution-label-targets')) {
      return jsonResponse({ success: true, targets: [], truncated: false, oldest_covered: null });
    }
    if (url.includes('/api/resolution-state')) return jsonResponse({ success: true, resolved: [], states: [] });
    if (url.includes('/api/relay-rpc')) return jsonResponse({ success: true, result: [] });
    return jsonResponse({ success: true });
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  consoleError.mockRestore();
});

describe('Reports list scroll', () => {
  it('keeps the list a minimum height and lets the card scroll to it', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, retryDelay: 0 } },
    });
    const { container } = render(
      <TestApp queryClient={queryClient}>
        <Reports relayUrl="wss://relay.example" />
      </TestApp>
    );

    await screen.findByRole('switch', { name: /hide resolved/i });
    const viewport = container.querySelector('[data-radix-scroll-area-viewport]');
    expect(viewport).not.toBeNull();
    // viewport -> ScrollArea root -> list area (CardContent) -> list card
    const listArea = viewport!.parentElement!.parentElement!;
    const card = listArea.parentElement!;

    // The list can't be squeezed below a usable height...
    expect(listArea).toHaveClass('flex-1', 'min-h-[16rem]');
    expect(listArea).not.toHaveClass('min-h-0');
    // ...and when the header plus that minimum overflow the card, the card scrolls.
    expect(card).toHaveClass('overflow-y-auto');
    expect(card).not.toHaveClass('overflow-hidden');
  });
});
