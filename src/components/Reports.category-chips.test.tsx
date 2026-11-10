// ABOUTME: One category chip per display name, filtering on every spelling of that category.
// ABOUTME: Apps send the same category under different spellings; a chip per spelling hid reports.

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
// NIP-56 type only: category 'spam'.
const SPAM_NIP56 = {
  ...base,
  id: '1'.repeat(64),
  pubkey: 'a'.repeat(64),
  created_at: 1751000030,
  tags: [['e', '2'.repeat(64), 'spam'], ['p', '3'.repeat(64), 'spam']],
};
// NIP-32 social.nos.ontology label: category 'NS-spam'.
const SPAM_NOS = {
  ...base,
  id: '4'.repeat(64),
  pubkey: 'b'.repeat(64),
  created_at: 1751000020,
  tags: [
    ['e', '5'.repeat(64), 'spam'],
    ['p', '6'.repeat(64), 'spam'],
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

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

let consoleError: MockInstance;
beforeEach(() => {
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('/api/reports/resolved')) return jsonResponse(EMPTY_RESOLVED_PAGE);
    if (url.includes('/api/reports')) return jsonResponse({ success: true, events: [SPAM_NIP56, SPAM_NOS, HARASSMENT] });
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

function renderReports() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });
  return render(
    <TestApp queryClient={queryClient}>
      <Reports relayUrl="wss://relay.example" />
    </TestApp>
  );
}

// The chips sit in the group the "Category" label introduces; row badges reuse
// the same names, so look only inside that group.
async function chipGroup() {
  const label = await screen.findByText('Category');
  return label.nextElementSibling as HTMLElement;
}

describe('Category chips', () => {
  it('shows one Spam chip for reports filed as spam and NS-spam', async () => {
    renderReports();
    const chips = await chipGroup();
    expect(within(chips).getAllByText('Spam')).toHaveLength(1);
    expect(within(chips).getAllByText('Harassment')).toHaveLength(1);
  });

  it('lists both spellings of Spam when the Spam chip is picked', async () => {
    const user = userEvent.setup();
    renderReports();
    await screen.findAllByText(/1 report$/);
    expect(screen.getAllByText(/1 report$/)).toHaveLength(3);

    await user.click(within(await chipGroup()).getByText('Spam'));

    // Both Spam targets stay; only Harassment goes.
    expect(screen.getAllByText(/1 report$/)).toHaveLength(2);
  });

  it('lists both spellings of Spam in the All view too', async () => {
    const user = userEvent.setup();
    const { container } = renderReports();
    await user.click(await screen.findByRole('tab', { name: /^All \(/ }));
    expect(container.querySelectorAll('[data-row-key]')).toHaveLength(3);

    await user.click(within(await chipGroup()).getByText('Spam'));

    expect(container.querySelectorAll('[data-row-key]')).toHaveLength(2);
  });
});
