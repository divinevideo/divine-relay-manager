// ABOUTME: When the environment actually changes, the Reports screen starts over, URL included:
// ABOUTME: nothing selected, no history view. A re-select of the same environment resets nothing.

import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
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

// A router that applies a navigation late models React Router's transition
// updates (v7, or v6 with v7_startTransition). 0 passes straight through. The
// wrapper keeps the real navigate's identity (the real one is memoised), so the
// effects that list navigate as a dependency re-run exactly as in production;
// a new function every render would hide a missing dependency from every test.
const routerLag = vi.hoisted(() => ({ ms: 0 }));
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return {
    ...actual,
    useNavigate: () => {
      const navigate = actual.useNavigate();
      return useCallback(((to: unknown, options?: unknown) => {
        if (routerLag.ms === 0) return navigate(to as never, options as never);
        setTimeout(() => navigate(to as never, options as never), routerLag.ms);
      }) as typeof navigate, [navigate]);
    },
  };
});

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

function renderAppAt(path: string, queryClient?: QueryClient) {
  window.history.pushState({}, '', path);
  return render(
    <TestApp queryClient={queryClient}>
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
  routerLag.ms = 0;
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

  it('starts over from a report opened through an ?event= link', async () => {
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

describe("the new environment's first reads", () => {
  // Reports is held for the pass in which the change is seen, so the cache is
  // cleared before it reads. Mounted in that pass, it would read the old
  // environment's cache, then be cleared and read again.
  it('reads the feed and the resolution state once after a switch through the selector', async () => {
    const feedReads = stubWorkers({ [ENV_A.apiUrl]: [OTHER_REPORT], [ENV_B.apiUrl]: [OTHER_REPORT] });
    const user = userEvent.setup();
    renderAppAt('/reports');
    await screen.findByText(nip19.noteEncode(OTHER_EVENT));

    await selectEnvironment(user, 'Beta');
    await screen.findByText(nip19.noteEncode(OTHER_EVENT));
    await flush();

    expect(feedReads[ENV_B.apiUrl]).toBe(1);
    expect(feedReads[`${ENV_B.apiUrl}/resolution-state`]).toBe(1);
  });

  it('reads the feed once after a switch from another tab', async () => {
    const feedReads = stubWorkers({ [ENV_A.apiUrl]: [OTHER_REPORT], [ENV_B.apiUrl]: [OTHER_REPORT] });
    renderAppAt('/reports');
    await screen.findByText(nip19.noteEncode(OTHER_EVENT));

    await switchFromAnotherTab(ENV_B);
    await screen.findByText(nip19.noteEncode(OTHER_EVENT));
    await flush();

    expect(feedReads[ENV_B.apiUrl]).toBe(1);
  });
});

describe('re-selecting the environment in use, with many queries cached', () => {
  // gcTime is Infinity in the app, so inactive queries pile up over a session. A
  // re-select refreshes what is on screen; the rest refresh when next used.
  it('does not re-read inactive cached queries', async () => {
    stubWorkers(feedsWhereBetaLacksTheReport());
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });
    const user = userEvent.setup();
    renderAppAt('/reports', queryClient);
    await screen.findByText(nip19.noteEncode(OPEN_EVENT));
    let reads = 0;
    for (let i = 0; i < 20; i++) {
      await queryClient.fetchQuery({
        queryKey: ['inactive-probe', i], queryFn: async () => { reads += 1; return i; }, gcTime: Infinity,
      });
    }
    const before = reads;

    await selectEnvironment(user, 'Alpha');
    await flush();

    expect(reads - before).toBe(0);
  });
});

describe('re-selecting the environment in use marks the cached queries stale', () => {
  // invalidateQueries marks every cached query stale and re-reads the active
  // ones, so an inactive one re-reads when next used even within its staleTime.
  // A refetch limited to the active queries would leave it marked fresh.
  it('so an inactive query re-reads when next used, within its staleTime', async () => {
    stubWorkers(feedsWhereBetaLacksTheReport());
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });
    const user = userEvent.setup();
    renderAppAt('/reports', queryClient);
    await screen.findByText(nip19.noteEncode(OPEN_EVENT));
    let reads = 0;
    const read = () => queryClient.fetchQuery({
      queryKey: ['stale-probe'], queryFn: async () => { reads += 1; return reads; }, staleTime: 60_000, gcTime: Infinity,
    });
    await read();
    await read();
    expect(reads).toBe(1);

    await selectEnvironment(user, 'Alpha');
    await flush();
    await read();

    expect(reads).toBe(2);
  });
});

describe('a change reverted before it settles', () => {
  // Another tab writes Beta, then Alpha again, and Alpha's write lands between
  // the URL clean-up and the render that would settle on Beta. The next real
  // switch to Beta must still clear the cache.
  it('still clears the cache on the next real change to that environment', async () => {
    const feedReads = stubWorkers(
      { [ENV_A.apiUrl]: [OPEN_REPORT, OTHER_REPORT], [ENV_B.apiUrl]: [OTHER_REPORT] },
      { [ENV_A.apiUrl]: [{ target_type: 'event', target_id: OTHER_EVENT }] },
    );
    renderAppAt(`/reports/${OPEN_REPORT.id}`);
    await waitFor(() => expect(screen.getByTestId('detail')).toHaveAttribute('data-report-id', OPEN_REPORT.id));

    const realReplace = window.history.replaceState.bind(window.history);
    let reverted = false;
    const spy = vi.spyOn(window.history, 'replaceState').mockImplementation((...args: Parameters<History['replaceState']>) => {
      realReplace(...args);
      if (!reverted && String(args[2]).endsWith('/reports')) {
        reverted = true;
        window.dispatchEvent(new StorageEvent('storage', {
          key: 'test-app-config',
          newValue: JSON.stringify({ theme: 'light', relayUrl: ENV_A.relayUrl, apiUrl: ENV_A.apiUrl }),
        }));
      }
    });
    await switchFromAnotherTab(ENV_B);
    spy.mockRestore();
    expect(reverted).toBe(true);
    await flush();

    // Back in Alpha, which resolved OTHER_EVENT: its state is read and cached.
    await screen.findByRole('switch', { name: /hide resolved/i });
    await flush();
    expect(screen.queryByText(nip19.noteEncode(OTHER_EVENT))).not.toBeInTheDocument();

    await switchFromAnotherTab(ENV_B);
    await flush();

    // Beta has not resolved it; with Alpha's state still cached it would stay hidden.
    expect(await screen.findByText(nip19.noteEncode(OTHER_EVENT), {}, { timeout: 2000 })).toBeInTheDocument();
    expect(feedReads[`${ENV_B.apiUrl}/resolution-state`]).toBeGreaterThan(0);
  });
});

describe('with a router that applies a navigation late', () => {
  const sleep = (ms: number) => act(async () => { await new Promise(r => setTimeout(r, ms)); });

  // The screen settles on the new environment only once the URL no longer
  // carries the old report. Settling in the same pass as the navigation would
  // mount Reports on the old URL while the navigation is still pending.
  it('does not reopen the old report in the new environment after a cross-tab switch', async () => {
    routerLag.ms = 50;
    stubWorkers({ [ENV_A.apiUrl]: [OPEN_REPORT], [ENV_B.apiUrl]: [OPEN_REPORT, OTHER_REPORT] });
    renderAppAt(`/reports/${OPEN_REPORT.id}`);
    await waitFor(() => expect(screen.getByTestId('detail')).toHaveAttribute('data-report-id', OPEN_REPORT.id));

    await switchFromAnotherTab(ENV_B);
    await sleep(300);

    await expectStartedOver();
  });

  it('does not reopen the old report in the new environment after a switch through the selector', async () => {
    routerLag.ms = 50;
    stubWorkers({ [ENV_A.apiUrl]: [OPEN_REPORT], [ENV_B.apiUrl]: [OPEN_REPORT, OTHER_REPORT] });
    const user = userEvent.setup();
    renderAppAt(`/reports/${OPEN_REPORT.id}`);
    await waitFor(() => expect(screen.getByTestId('detail')).toHaveAttribute('data-report-id', OPEN_REPORT.id));

    await selectEnvironment(user, 'Beta');
    await sleep(300);

    await expectStartedOver();
  });
});
