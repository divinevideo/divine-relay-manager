// ABOUTME: Every count beside a queue list is counted from the rows that list renders.
// ABOUTME: Covers the pending-review badge, the header and the All tab.

import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { nip19 } from 'nostr-tools';
import TestApp from '@/test/TestApp';
import { EMPTY_RESOLVED_PAGE } from '@/test/resolvedHistory';
import { Reports } from './Reports';

vi.mock('@/components/ReportDetail', () => ({ ReportDetail: () => null }));

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

// An auto-hidden post waiting for review, with its report in the feed.
const PENDING_EVENT = '1'.repeat(64);
const PENDING_REPORT = report('a'.repeat(64), 1751000400, ['e', PENDING_EVENT, 'spam']);
// Auto-hidden too, with no report in the feed. A badge that counted it would
// promise a row the view cannot show.
const ORPHAN_PENDING_EVENT = '2'.repeat(64);
// Two open targets, an account and a post, so a type filter visibly narrows the queue.
const OPEN_PUBKEY = '3'.repeat(64);
const OPEN_ACCOUNT_REPORT = report('c'.repeat(64), 1751000300, ['p', OPEN_PUBKEY, 'spam']);
const OPEN_EVENT = '4'.repeat(64);
const OPEN_EVENT_REPORT = report('d'.repeat(64), 1751000200, ['e', OPEN_EVENT, 'spam']);
// A target a moderator already resolved.
const RESOLVED_EVENT = '5'.repeat(64);
const RESOLVED_REPORT = report('f'.repeat(64), 1751000100, ['e', RESOLVED_EVENT, 'spam']);

const WAITING_STATES = [
  { target_type: 'event', target_id: PENDING_EVENT, action: 'auto_hidden' },
  { target_type: 'event', target_id: ORPHAN_PENDING_EVENT, action: 'auto_hidden' },
];
// What the decisions read says is waiting. A test empties it to model a
// moderator handling the last auto-hide.
let autoHideStates: typeof WAITING_STATES = WAITING_STATES;

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

// The header is a <p> with the count first; match its own text.
const headerStartingWith = (text: string) => (_: string, el: Element | null) =>
  el?.tagName === 'P' && (el.textContent ?? '').trim().startsWith(text);
const pendingBadge = () => document.querySelector('label[for="pending-review"]');

function renderQueue() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });
  render(
    <TestApp queryClient={queryClient}>
      <Reports relayUrl="wss://relay.example" />
    </TestApp>
  );
  return queryClient;
}

let consoleError: MockInstance;
beforeEach(() => {
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  autoHideStates = WAITING_STATES;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('/api/reports/resolved')) return jsonResponse(EMPTY_RESOLVED_PAGE);
    if (url.includes('/api/reports')) {
      return jsonResponse({
        success: true,
        events: [PENDING_REPORT, OPEN_ACCOUNT_REPORT, OPEN_EVENT_REPORT, RESOLVED_REPORT],
        truncated: false,
      });
    }
    if (url.includes('/api/resolution-label-targets')) {
      return jsonResponse({ success: true, targets: [], truncated: false, oldest_covered: null });
    }
    if (url.includes('/api/resolution-state')) {
      return jsonResponse({
        success: true,
        resolved: [{ target_type: 'event', target_id: RESOLVED_EVENT }],
        states: autoHideStates,
      });
    }
    if (url.includes('/api/relay-rpc')) return jsonResponse({ success: true, result: [] });
    return jsonResponse({ success: true });
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  consoleError.mockRestore();
});

describe('counts beside the queue come from the rows it renders', () => {
  it('counts the targets the pending-review view will list, not every auto-hide on record', async () => {
    const user = userEvent.setup();
    renderQueue();
    await screen.findByText(headerStartingWith('2 pending'));

    expect(pendingBadge()).toHaveTextContent(/auto-hidden\)\s*1$/);

    await user.click(screen.getByRole('switch', { name: /pending review/i }));
    expect(await screen.findByText(nip19.noteEncode(PENDING_EVENT))).toBeInTheDocument();
    expect(screen.getByText('Grouped (1)')).toBeInTheDocument();
  });

  it('opens the pending-review view on every waiting target, even with a type filter on', async () => {
    const user = userEvent.setup();
    renderQueue();
    await screen.findByText(headerStartingWith('2 pending'));

    await user.click(screen.getByRole('button', { name: /users/i }));
    expect(await screen.findByText('Grouped (1)')).toBeInTheDocument();

    await user.click(screen.getByRole('switch', { name: /pending review/i }));
    // The auto-hidden post is listed, not hidden behind the Users filter.
    expect(await screen.findByText(nip19.noteEncode(PENDING_EVENT))).toBeInTheDocument();

    await user.click(screen.getByRole('switch', { name: /pending review/i }));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    // Leaving hands the Users filter back: the open post is filtered out again.
    expect(screen.getByText('Grouped (1)')).toBeInTheDocument();
    expect(screen.queryByText(nip19.noteEncode(OPEN_EVENT))).not.toBeInTheDocument();
  });

  it('counts the All tab from the reports it lists', async () => {
    const user = userEvent.setup();
    renderQueue();
    await screen.findByText(headerStartingWith('2 pending'));
    expect(screen.getByText('All (2)')).toBeInTheDocument();

    await user.click(screen.getByRole('switch', { name: /hide resolved/i }));
    // Open account, open post, resolved post. The auto-hidden post is not in this view.
    expect(await screen.findByText('All (3)')).toBeInTheDocument();
  });

  it('shows no resolved count beside the pending count', async () => {
    renderQueue();
    await screen.findByText(headerStartingWith('2 pending'));

    // The old "(N resolved)" was every loaded target minus the rows shown, so
    // it counted the auto-hidden post as resolved.
    expect(screen.queryByText(/resolved\)/)).not.toBeInTheDocument();
  });

  it('does not call a list with resolved rows in it "pending"', async () => {
    const user = userEvent.setup();
    renderQueue();
    await screen.findByText(headerStartingWith('2 pending'));

    await user.click(screen.getByRole('switch', { name: /hide resolved/i }));
    expect(await screen.findByText(headerStartingWith('3 shown'))).toBeInTheDocument();
  });

  it('keeps the way out of the pending-review view after its last row is handled', async () => {
    const user = userEvent.setup();
    const queryClient = renderQueue();
    await screen.findByText(headerStartingWith('2 pending'));
    await user.click(screen.getByRole('switch', { name: /pending review/i }));
    expect(await screen.findByText(nip19.noteEncode(PENDING_EVENT))).toBeInTheDocument();

    // The moderator confirms the last auto-hide: nothing is waiting any more.
    autoHideStates = [];
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['resolution-state'] });
    });
    await waitFor(() => expect(screen.queryByText(nip19.noteEncode(PENDING_EVENT))).not.toBeInTheDocument());

    // Hide resolved is disabled in this view, so this switch is the only way
    // out. It must still be there with nothing left to count.
    await user.click(screen.getByRole('switch', { name: /pending review/i }));
    expect(screen.getByRole('switch', { name: /hide resolved/i })).not.toBeDisabled();
  });
});
