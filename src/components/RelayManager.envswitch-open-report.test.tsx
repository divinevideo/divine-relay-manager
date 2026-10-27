// ABOUTME: Switching environment with a report open must start the Reports screen over,
// ABOUTME: URL included, or the screen reopens that report (or its history) in the new one.

import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { nip19 } from 'nostr-tools';
import TestApp from '@/test/TestApp';
import { EMPTY_RESOLVED_PAGE } from '@/test/resolvedHistory';
import { RelayManager } from './RelayManager';

const { ENV_A, ENV_B } = vi.hoisted(() => ({
  ENV_A: { id: 'alpha', name: 'Alpha', relayUrl: 'wss://relay-a.example', apiUrl: 'https://api-a.example' },
  ENV_B: { id: 'beta', name: 'Beta', relayUrl: 'wss://relay-b.example', apiUrl: 'https://api-b.example' },
}));

vi.mock('@/lib/environments', () => ({
  environments: [ENV_A, ENV_B],
  getCurrentEnvironment: (relayUrl: string, apiUrl: string) =>
    [ENV_A, ENV_B].find(e => e.relayUrl === relayUrl && e.apiUrl === apiUrl),
}));
vi.mock('@/components/ReportDetail', () => ({
  ReportDetail: ({ report }: { report: { id: string } | null }) =>
    (report ? <div data-testid="detail" data-report-id={report.id} /> : null),
}));
vi.mock('@/components/EventsList', () => ({ EventsList: () => null }));
vi.mock('@/components/UserManagement', () => ({ UserManagement: () => null }));
vi.mock('@/components/Labels', () => ({ Labels: () => null }));
vi.mock('@/components/DebugPanel', () => ({ DebugPanel: () => null }));
vi.mock('@/components/SettingsDashboard', () => ({ SettingsDashboard: () => null }));
vi.mock('@/components/AgeReview', () => ({ AgeReview: () => null }));
vi.mock('@/components/AdminBar', () => ({ default: () => null }));
vi.mock('@/components/auth/DivineLoginButton', () => ({ DivineLoginButton: () => null }));
vi.mock('@/components/auth/AttributionNotice', () => ({ AttributionNotice: () => null }));

const OPEN_EVENT = '3'.repeat(64);
const OTHER_EVENT = '4'.repeat(64);
const report = (id: string, eventId: string) => ({
  id, pubkey: '5'.repeat(64), created_at: 1751000000, kind: 1984,
  tags: [['e', eventId, 'spam'], ['p', '9'.repeat(64), 'spam']], content: '', sig: 'f'.repeat(128),
});
const OPEN_REPORT = report('d'.repeat(64), OPEN_EVENT);
const OTHER_REPORT = report('c'.repeat(64), OTHER_EVENT);

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

// Each environment's worker holds its own feed; `/api/reports?event=` answers
// from that same set, so "the new environment lacks the report" is real.
function stubWorkers(feeds: Record<string, unknown[]>) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    const host = Object.keys(feeds).find(h => url.startsWith(h)) ?? Object.keys(feeds)[0];
    const feed = feeds[host];
    if (url.includes('/api/reports/resolved')) return jsonResponse(EMPTY_RESOLVED_PAGE);
    if (url.includes('/api/reports?needs_attention=1')) return jsonResponse({ success: true, events: feed, truncated: false });
    if (url.includes('/api/reports?')) return jsonResponse({ success: true, events: [], truncated: false });
    if (url.includes('/api/resolution-label-targets')) {
      return jsonResponse({ success: true, targets: [], truncated: false, oldest_covered: null });
    }
    if (url.includes('/api/resolution-state')) return jsonResponse({ success: true, resolved: [], states: [] });
    if (url.includes('/api/relay-rpc')) return jsonResponse({ success: true, result: [] });
    return jsonResponse({ success: true });
  }));
}

function renderAppAt(path: string) {
  window.history.pushState({}, '', path);
  localStorage.setItem('test-app-config', JSON.stringify({
    theme: 'light', relayUrl: ENV_A.relayUrl, apiUrl: ENV_A.apiUrl,
  }));
  return render(
    <TestApp>
      <Routes>
        <Route path="/reports/:reportId" element={<RelayManager />} />
        <Route path="/users/:pubkey" element={<RelayManager />} />
        <Route path="/reports" element={<RelayManager />} />
      </Routes>
    </TestApp>,
  );
}

async function switchToBeta(user: ReturnType<typeof userEvent.setup>) {
  await user.click(document.querySelector('button[role="combobox"][aria-haspopup="dialog"]') as HTMLElement);
  await user.click(await screen.findByText('Beta'));
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });
}

let consoleError: MockInstance;
beforeEach(() => {
  // cmdk scrolls the highlighted item into view; jsdom has no layout.
  Element.prototype.scrollIntoView = vi.fn();
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  consoleError.mockRestore();
  localStorage.removeItem('test-app-config');
  window.history.pushState({}, '', '/');
});

describe('switching environment with a report open', () => {
  it('starts on the pending queue when the new environment lacks the report', async () => {
    stubWorkers({ [ENV_A.apiUrl]: [OPEN_REPORT], [ENV_B.apiUrl]: [OTHER_REPORT] });
    const user = userEvent.setup();
    renderAppAt(`/reports/${OPEN_REPORT.id}`);
    await waitFor(() => expect(screen.getByTestId('detail')).toHaveAttribute('data-report-id', OPEN_REPORT.id));

    const entries = window.history.length;
    await switchToBeta(user);

    await screen.findByText(nip19.noteEncode(OTHER_EVENT));
    expect(window.location.pathname).toBe('/reports');
    // Replaced, so Back cannot return to the old environment's report.
    expect(window.history.length).toBe(entries);
    expect(screen.queryByTestId('detail')).not.toBeInTheDocument();
    // The pending queue, not a history view opened to look for the old report.
    expect(screen.getByRole('switch', { name: /hide resolved/i })).toBeChecked();
    expect(screen.queryByTestId('resolved-history-footer')).not.toBeInTheDocument();
  });

  it('does not reopen the report when the new environment has the same id', async () => {
    stubWorkers({ [ENV_A.apiUrl]: [OPEN_REPORT], [ENV_B.apiUrl]: [OPEN_REPORT, OTHER_REPORT] });
    const user = userEvent.setup();
    renderAppAt(`/reports/${OPEN_REPORT.id}`);
    await waitFor(() => expect(screen.getByTestId('detail')).toHaveAttribute('data-report-id', OPEN_REPORT.id));

    await switchToBeta(user);

    await screen.findByText(nip19.noteEncode(OTHER_EVENT));
    expect(window.location.pathname).toBe('/reports');
    expect(screen.queryByTestId('detail')).not.toBeInTheDocument();
  });

  it('leaves another tab\'s route alone', async () => {
    stubWorkers({ [ENV_A.apiUrl]: [OPEN_REPORT], [ENV_B.apiUrl]: [OTHER_REPORT] });
    const user = userEvent.setup();
    const pubkey = '9'.repeat(64);
    renderAppAt(`/users/${pubkey}`);

    await switchToBeta(user);

    expect(window.location.pathname).toBe(`/users/${pubkey}`);
  });
});
