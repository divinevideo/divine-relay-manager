// ABOUTME: The queue's sort, type and category controls fold behind a Filters toggle, open by default.
// ABOUTME: Closed, it still says which filters are on; the two queue switches never fold away.

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import TestApp from '@/test/TestApp';
import { EMPTY_RESOLVED_PAGE } from '@/test/resolvedHistory';
import { Reports } from './Reports';

vi.mock('@/components/ReportDetail', () => ({
  ReportDetail: () => <div data-testid="detail" />,
}));

const base = { kind: 1984, content: 'reported', sig: 'e'.repeat(128) };
const SPAM = {
  ...base,
  id: '1'.repeat(64),
  pubkey: 'a'.repeat(64),
  created_at: 1751000030,
  tags: [
    ['e', '2'.repeat(64), 'spam'],
    ['p', '3'.repeat(64), 'spam'],
    ['L', 'social.nos.ontology'],
    ['l', 'NS-spam', 'social.nos.ontology'],
  ],
};
const HARASSMENT = {
  ...base,
  id: '7'.repeat(64),
  pubkey: 'c'.repeat(64),
  created_at: 1751000010,
  tags: [
    ['e', '8'.repeat(64), 'other'],
    ['p', '9'.repeat(64), 'other'],
    ['L', 'social.nos.ontology'],
    ['l', 'NS-harassment', 'social.nos.ontology'],
  ],
};

const OPEN_KEY = 'reports:filters-open';

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

// The shared test setup stubs localStorage with no-ops, so back it with a real
// store here (same pattern as AttributionNotice.test.tsx). Restored after each.
let consoleError: MockInstance;
let originalStorage: Storage;
function useStorage(value: Partial<Storage>) {
  Object.defineProperty(window, 'localStorage', { value, writable: true });
}
beforeEach(() => {
  originalStorage = window.localStorage;
  const store = new Map<string, string>();
  useStorage({
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
    clear: () => store.clear(),
  });
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('/api/reports/resolved')) return jsonResponse(EMPTY_RESOLVED_PAGE);
    if (url.includes('/api/reports')) return jsonResponse({ success: true, events: [SPAM, HARASSMENT] });
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
  useStorage(originalStorage);
});

function renderReports() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });
  return render(
    <TestApp queryClient={queryClient}>
      <Reports relayUrl="wss://relay.example" />
    </TestApp>
  );
}

const filtersToggle = () => screen.findByRole('button', { name: /^filters/i });

describe('Filters toggle', () => {
  it('starts open, with sort, type and category showing', async () => {
    renderReports();
    expect(await filtersToggle()).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('combobox')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Users' })).toBeInTheDocument();
    expect(await screen.findByText('Category')).toBeInTheDocument();
  });

  it('folds sort, type and category away but keeps both queue switches', async () => {
    const user = userEvent.setup();
    renderReports();
    await screen.findByText('Category');
    await user.click(await filtersToggle());

    expect(await filtersToggle()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Users' })).not.toBeInTheDocument();
    expect(screen.queryByText('Category')).not.toBeInTheDocument();
    expect(screen.getByRole('switch', { name: /hide resolved/i })).toBeInTheDocument();
  });

  it('says which filters are on while closed, and clears the category from there', async () => {
    const user = userEvent.setup();
    renderReports();
    const label = await screen.findByText('Category');
    await user.click(within(label.nextElementSibling as HTMLElement).getByText('Spam'));
    await user.click(screen.getByRole('button', { name: 'Events' }));
    await user.click(await filtersToggle());

    const summary = screen.getByTestId('filters-summary');
    expect(summary).toHaveTextContent('Most Reports');
    expect(summary).toHaveTextContent('Events');
    expect(summary).toHaveTextContent('Spam');

    await user.click(screen.getByRole('button', { name: 'Clear category filter' }));
    expect(screen.getByTestId('filters-summary')).not.toHaveTextContent('Spam');
    // Still closed: clearing from the summary doesn't open the panel.
    expect(await filtersToggle()).toHaveAttribute('aria-expanded', 'false');
  });

  it('remembers that it was closed', async () => {
    const user = userEvent.setup();
    const first = renderReports();
    await user.click(await filtersToggle());
    expect(localStorage.getItem(OPEN_KEY)).toBe('0');
    first.unmount();

    renderReports();
    expect(await filtersToggle()).toHaveAttribute('aria-expanded', 'false');
  });

  it('opens by default when storage is unavailable', async () => {
    const getItem = vi.fn(() => { throw new Error('denied'); });
    const setItem = vi.fn(() => { throw new Error('denied'); });
    useStorage({ getItem, setItem });
    const user = userEvent.setup();
    renderReports();
    expect(await filtersToggle()).toHaveAttribute('aria-expanded', 'true');
    expect(getItem).toHaveBeenCalledWith(OPEN_KEY);
    // Toggling still works for the session.
    await user.click(await filtersToggle());
    expect(setItem).toHaveBeenCalledWith(OPEN_KEY, '0');
    expect(await filtersToggle()).toHaveAttribute('aria-expanded', 'false');
  });
});
