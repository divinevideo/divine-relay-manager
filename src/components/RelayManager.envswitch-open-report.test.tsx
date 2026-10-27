// ABOUTME: When the environment actually changes, the Reports screen starts over, URL included:
// ABOUTME: nothing selected, no history view. A re-select of the same environment resets nothing.

import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { nip19 } from 'nostr-tools';
import TestApp from '@/test/TestApp';
import { EMPTY_RESOLVED_PAGE } from '@/test/resolvedHistory';
import { RelayManager } from './RelayManager';

// ENV_A is the app's default environment (TestApp's default config), so the
// screen starts in it without any stored config.
const { ENV_A, ENV_B } = vi.hoisted(() => ({
  ENV_A: { id: 'alpha', name: 'Alpha', relayUrl: 'wss://relay.nostr.band', apiUrl: 'https://api-relay.divine.video' },
  ENV_B: { id: 'beta', name: 'Beta', relayUrl: 'wss://relay-b.example', apiUrl: 'https://api-b.example' },
}));

vi.mock('@/lib/environments', () => ({
  environments: [ENV_A, ENV_B],
  getCurrentEnvironment: (relayUrl: string, apiUrl: string) =>
    [ENV_A, ENV_B].find(e => e.relayUrl === relayUrl && e.apiUrl === apiUrl),
  getEnvironmentById: (id: string) => [ENV_A, ENV_B].find(e => e.id === id),
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
const PUBKEY = '9'.repeat(64);
const report = (id: string, eventId: string) => ({
  id, pubkey: '5'.repeat(64), created_at: 1751000000, kind: 1984,
  tags: [['e', eventId, 'spam'], ['p', PUBKEY, 'spam']], content: '', sig: 'f'.repeat(128),
});
const OPEN_REPORT = report('d'.repeat(64), OPEN_EVENT);
const OTHER_REPORT = report('c'.repeat(64), OTHER_EVENT);

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

// Each environment's worker holds its own feed. A request to a host with no
// feed fails the test, so a read can never be answered by the wrong environment.
function stubWorkers(
  feeds: Record<string, unknown[]>,
  resolvedByHost: Record<string, { target_type: string; target_id: string }[]> = {},
) {
  const feedReads: Record<string, number> = {};
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    const host = Object.keys(feeds).find(h => url.startsWith(h));
    if (!host) throw new Error(`request to an unknown host: ${url}`);
    const feed = feeds[host];
    if (url.includes('/api/reports/resolved')) return jsonResponse(EMPTY_RESOLVED_PAGE);
    if (url.includes('/api/reports?needs_attention=1')) {
      feedReads[host] = (feedReads[host] ?? 0) + 1;
      return jsonResponse({ success: true, events: feed, truncated: false });
    }
    if (url.includes('/api/reports?')) {
      const hit = feed.filter(r => (r as typeof OPEN_REPORT).tags.some(t => url.toLowerCase().includes(t[1])));
      return jsonResponse({ success: true, events: hit, truncated: false });
    }
    if (url.includes('/api/resolution-label-targets')) {
      return jsonResponse({ success: true, targets: [], truncated: false, oldest_covered: null });
    }
    if (url.includes('/api/resolution-state')) {
      feedReads[`${host}/resolution-state`] = (feedReads[`${host}/resolution-state`] ?? 0) + 1;
      return jsonResponse({ success: true, resolved: resolvedByHost[host] ?? [], states: [] });
    }
    if (url.includes('/api/relay-rpc')) return jsonResponse({ success: true, result: [] });
    return jsonResponse({ success: true });
  }));
  return feedReads;
}

function renderAppAt(path: string) {
  window.history.pushState({}, '', path);
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

const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });

async function selectEnvironment(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(document.querySelector('button[role="combobox"][aria-haspopup="dialog"]') as HTMLElement);
  await user.click(await screen.findByText(name, { selector: 'span.font-medium' }));
  await flush();
}

// What another browser tab's switch looks like in this one: a storage event for
// the config key (src/hooks/useLocalStorage.ts).
async function switchFromAnotherTab(env: typeof ENV_B) {
  await act(async () => {
    window.dispatchEvent(new StorageEvent('storage', {
      key: 'test-app-config',
      newValue: JSON.stringify({ theme: 'light', relayUrl: env.relayUrl, apiUrl: env.apiUrl }),
    }));
  });
  await flush();
}

async function expectStartedOver() {
  await screen.findByText(nip19.noteEncode(OTHER_EVENT));
  expect(window.location.pathname).toBe('/reports');
  expect(window.location.search).toBe('');
  expect(screen.queryByTestId('detail')).not.toBeInTheDocument();
  // The pending queue, not a history view opened to look for the old report.
  expect(screen.getByRole('switch', { name: /hide resolved/i })).toBeChecked();
  expect(screen.queryByTestId('resolved-history-footer')).not.toBeInTheDocument();
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
  window.history.pushState({}, '', '/');
});

const feedsWhereBetaLacksTheReport = () => ({ [ENV_A.apiUrl]: [OPEN_REPORT], [ENV_B.apiUrl]: [OTHER_REPORT] });

describe('switching environment through the selector', () => {
  it('starts on the pending queue from /reports/<id> when the new environment lacks the report', async () => {
    stubWorkers(feedsWhereBetaLacksTheReport());
    const user = userEvent.setup();
    renderAppAt(`/reports/${OPEN_REPORT.id}`);
    await waitFor(() => expect(screen.getByTestId('detail')).toHaveAttribute('data-report-id', OPEN_REPORT.id));

    const entries = window.history.length;
    await selectEnvironment(user, 'Beta');

    await expectStartedOver();
    // Replaced, so Back cannot return to the old environment's report.
    expect(window.history.length).toBe(entries);
  });

  it('does not reopen the report when the new environment has the same id', async () => {
    stubWorkers({ [ENV_A.apiUrl]: [OPEN_REPORT], [ENV_B.apiUrl]: [OPEN_REPORT, OTHER_REPORT] });
    const user = userEvent.setup();
    renderAppAt(`/reports/${OPEN_REPORT.id}`);
    await waitFor(() => expect(screen.getByTestId('detail')).toHaveAttribute('data-report-id', OPEN_REPORT.id));

    await selectEnvironment(user, 'Beta');

    await expectStartedOver();
  });

  it('starts over from a report opened through an ?event= link', async () => {
    stubWorkers({ [ENV_A.apiUrl]: [OPEN_REPORT], [ENV_B.apiUrl]: [OPEN_REPORT, OTHER_REPORT] });
    const user = userEvent.setup();
    renderAppAt(`/reports?event=${OPEN_EVENT}`);
    await waitFor(() => expect(screen.getByTestId('detail')).toHaveAttribute('data-report-id', OPEN_REPORT.id));

    await selectEnvironment(user, 'Beta');

    await expectStartedOver();
  });

  it('starts over from a report opened through a ?pubkey= link', async () => {
    stubWorkers({ [ENV_A.apiUrl]: [OPEN_REPORT], [ENV_B.apiUrl]: [OPEN_REPORT, OTHER_REPORT] });
    const user = userEvent.setup();
    renderAppAt(`/reports?pubkey=${PUBKEY}`);
    await screen.findByTestId('detail');

    await selectEnvironment(user, 'Beta');

    await expectStartedOver();
  });

  it('starts over from a link whose target was not found, which stays in the URL', async () => {
    stubWorkers(feedsWhereBetaLacksTheReport());
    const user = userEvent.setup();
    renderAppAt(`/reports?event=${'7'.repeat(64)}`);
    await waitFor(() => expect(window.location.search).not.toBe(''));
    await flush();
    expect(window.location.search).not.toBe('');

    await selectEnvironment(user, 'Beta');

    await expectStartedOver();
  });

  it('starts over from a not-found ?pubkey= link, which stays in the URL', async () => {
    stubWorkers(feedsWhereBetaLacksTheReport());
    const user = userEvent.setup();
    renderAppAt(`/reports?pubkey=${'8'.repeat(64)}`);
    await waitFor(() => expect(window.location.search).not.toBe(''));
    await flush();

    await selectEnvironment(user, 'Beta');

    await expectStartedOver();
  });

  it('does not undo the switch away from a not-found link that names the old environment', async () => {
    stubWorkers(feedsWhereBetaLacksTheReport());
    const user = userEvent.setup();
    renderAppAt(`/reports?event=${'7'.repeat(64)}&env=alpha`);
    await flush();

    await selectEnvironment(user, 'Beta');

    await expectStartedOver();
  });

  it('drops a report id carried with ?env=<the new environment>, which is not a link', async () => {
    stubWorkers(feedsWhereBetaLacksTheReport());
    const user = userEvent.setup();
    renderAppAt(`/reports/${OPEN_REPORT.id}?env=beta`);
    await waitFor(() => expect(screen.getByTestId('detail')).toHaveAttribute('data-report-id', OPEN_REPORT.id));

    await selectEnvironment(user, 'Beta');

    await expectStartedOver();
  });

  it('drops a report id carried with an ?event= link for another environment, which is not a link', async () => {
    // The link makes the screen switch to Beta on its own; with a report id in
    // the path it is not a deep link, so the id is not carried into Beta.
    stubWorkers({ [ENV_A.apiUrl]: [OPEN_REPORT], [ENV_B.apiUrl]: [OPEN_REPORT, OTHER_REPORT] });
    renderAppAt(`/reports/${OPEN_REPORT.id}?event=${OPEN_EVENT}&env=beta`);

    await expectStartedOver();
  });

  it("leaves another tab's route alone", async () => {
    stubWorkers(feedsWhereBetaLacksTheReport());
    const user = userEvent.setup();
    renderAppAt(`/users/${PUBKEY}`);

    await selectEnvironment(user, 'Beta');

    expect(window.location.pathname).toBe(`/users/${PUBKEY}`);
  });
});

describe('re-selecting the environment already in use', () => {
  it('leaves the report open and the URL alone, and re-reads the data', async () => {
    const feedReads = stubWorkers(feedsWhereBetaLacksTheReport());
    const user = userEvent.setup();
    renderAppAt(`/reports/${OPEN_REPORT.id}`);
    await waitFor(() => expect(screen.getByTestId('detail')).toHaveAttribute('data-report-id', OPEN_REPORT.id));
    const readsBefore = feedReads[ENV_A.apiUrl];

    await selectEnvironment(user, 'Alpha');

    expect(window.location.pathname).toBe(`/reports/${OPEN_REPORT.id}`);
    expect(screen.getByTestId('detail')).toHaveAttribute('data-report-id', OPEN_REPORT.id);
    await waitFor(() => expect(feedReads[ENV_A.apiUrl]).toBeGreaterThan(readsBefore));
  });
});

describe('re-selecting the environment with a not-found link open', () => {
  it('re-reads without leaving the lookup stuck: the verdict comes back', async () => {
    stubWorkers(feedsWhereBetaLacksTheReport());
    const user = userEvent.setup();
    renderAppAt(`/reports?event=${'7'.repeat(64)}`);
    await screen.findByText('Report no longer on relay');

    await selectEnvironment(user, 'Alpha');

    await screen.findByText('Report no longer on relay');
    expect(screen.queryByText(/looking up this report/i)).not.toBeInTheDocument();
  });
});

describe('an environment change from another browser tab', () => {
  // The other tab's switch never runs this tab's selector, so nothing else
  // clears the cache. Reads that carry no environment in their key (resolution
  // state, the ban lists) would serve the old environment's data in the new one.
  it("reads the new environment's resolution state at once, not the old one's from the cache", async () => {
    const feedReads = stubWorkers(
      { [ENV_A.apiUrl]: [OTHER_REPORT], [ENV_B.apiUrl]: [OTHER_REPORT] },
      { [ENV_A.apiUrl]: [{ target_type: 'event', target_id: OTHER_EVENT }] },
    );
    renderAppAt('/reports');
    await screen.findByRole('switch', { name: /hide resolved/i });
    // Resolved in Alpha, so Alpha's queue does not list it.
    await waitFor(() => expect(feedReads[`${ENV_A.apiUrl}/resolution-state`]).toBeGreaterThan(0));
    expect(screen.queryByText(nip19.noteEncode(OTHER_EVENT))).not.toBeInTheDocument();

    await switchFromAnotherTab(ENV_B);

    // Beta has not resolved it. With Alpha's state still cached it would stay hidden.
    expect(await screen.findByText(nip19.noteEncode(OTHER_EVENT))).toBeInTheDocument();
    expect(feedReads[`${ENV_B.apiUrl}/resolution-state`]).toBeGreaterThan(0);
  });

  it('does not reopen the old report in the new environment', async () => {
    stubWorkers({ [ENV_A.apiUrl]: [OPEN_REPORT], [ENV_B.apiUrl]: [OPEN_REPORT, OTHER_REPORT] });
    renderAppAt(`/reports/${OPEN_REPORT.id}`);
    await waitFor(() => expect(screen.getByTestId('detail')).toHaveAttribute('data-report-id', OPEN_REPORT.id));

    await switchFromAnotherTab(ENV_B);
    await flush();

    await expectStartedOver();
  });

  it('starts over from /reports/<id> just as a switch here does', async () => {
    stubWorkers(feedsWhereBetaLacksTheReport());
    renderAppAt(`/reports/${OPEN_REPORT.id}`);
    await waitFor(() => expect(screen.getByTestId('detail')).toHaveAttribute('data-report-id', OPEN_REPORT.id));

    await switchFromAnotherTab(ENV_B);

    await expectStartedOver();
  });

  it('starts over from an ?event= link', async () => {
    stubWorkers({ [ENV_A.apiUrl]: [OPEN_REPORT], [ENV_B.apiUrl]: [OPEN_REPORT, OTHER_REPORT] });
    renderAppAt(`/reports?event=${OPEN_EVENT}`);
    await waitFor(() => expect(screen.getByTestId('detail')).toHaveAttribute('data-report-id', OPEN_REPORT.id));

    await switchFromAnotherTab(ENV_B);

    await expectStartedOver();
  });
});

describe('a link that names its environment', () => {
  it('opens in that environment: the switch it makes is not undone and its link is kept', async () => {
    stubWorkers({ [ENV_A.apiUrl]: [OTHER_REPORT], [ENV_B.apiUrl]: [OPEN_REPORT] });
    renderAppAt(`/reports?event=${OPEN_EVENT}&env=beta`);

    await waitFor(() => expect(screen.getByTestId('detail')).toHaveAttribute('data-report-id', OPEN_REPORT.id));
    expect(window.location.pathname).toBe(`/reports/${OPEN_REPORT.id}`);
  });
});
