// ABOUTME: PR #323's pending-review switch beside resolved history and a failed queue.
// ABOUTME: Membership comes from the feed, so loaded history cannot make the switch toggle.

import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { useLocation } from 'react-router-dom';
import { nip19 } from 'nostr-tools';
import TestApp from '@/test/TestApp';
import { resolvedPage } from '@/test/resolvedHistory';
import { Reports } from './Reports';

const RELAY_URL = 'wss://relay.example';

// Counts the groupings the screen builds. A render loop shows up here as a
// failure, not a hung test run.
const grouped = vi.hoisted(() => ({ calls: 0 }));
vi.mock('@/lib/consolidateReports', async (orig) => {
  const actual = await orig<typeof import('@/lib/consolidateReports')>();
  return {
    ...actual,
    consolidateReports: (...args: Parameters<typeof actual.consolidateReports>) => {
      grouped.calls += 1;
      if (grouped.calls > 400) throw new Error('render loop: consolidateReports called over 400 times');
      return actual.consolidateReports(...args);
    },
  };
});

vi.mock('@/components/ReportDetail', () => ({
  ReportDetail: ({ switchState, targetReportsMayBePartial }: { switchState?: string; targetReportsMayBePartial?: boolean }) => (
    <div
      data-testid="detail"
      data-switch-state={switchState ?? ''}
      data-reports-partial={String(targetReportsMayBePartial === true)}
    />
  ),
}));

const CSAM_PROFILE = '4'.repeat(64);
const SPAM_EVENT = '3'.repeat(64);

function report(id: string, createdAt: number, tags: string[][], content = '') {
  return { id, pubkey: '5'.repeat(64), created_at: createdAt, kind: 1984, tags, content, sig: 'f'.repeat(128) };
}

// A profile report that signals CSAM, which the worker counts resolved (it is on
// a resolved-history page), and a plain open report in the feed.
const CSAM_REPORT = report('d'.repeat(64), 1751000000, [
  ['p', CSAM_PROFILE, 'illegal'],
  ['l', 'NS-csam', 'social.nos.ontology'],
]);
const SPAM_REPORT = report('c'.repeat(64), 1751000050, [
  ['e', SPAM_EVENT, 'spam'],
  ['p', '9'.repeat(64), 'spam'],
]);

const NPUB_CSAM = nip19.npubEncode(CSAM_PROFILE);
const NOTE_SPAM = nip19.noteEncode(SPAM_EVENT);

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

interface Stub {
  feed?: unknown[];
  history?: unknown[];
  // The label read, when it should not answer with no labels.
  labels?: () => Response | Promise<Response>;
  // Answers for a deep link's targeted lookup, keyed by the target's hex.
  targeted?: Record<string, unknown[]>;
  // Whether those lookups stopped before reading the target's whole history.
  targetedTruncated?: boolean;
  // The feed read, when it should not answer with `feed`.
  feedReply?: () => Response | Promise<Response>;
  // Whether the feed stopped before reading every report, as the worker says.
  feedTruncated?: boolean;
}

function stubWorker({ feed = [SPAM_REPORT], history = [CSAM_REPORT], labels, targeted = {}, targetedTruncated = false, feedReply, feedTruncated = false }: Stub) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('/api/reports/resolved')) {
      return jsonResponse(resolvedPage(history, { nextCursor: null, done: true }));
    }
    if (url.includes('/api/reports?needs_attention=1')) {
      return feedReply ? feedReply() : jsonResponse({ success: true, events: feed, truncated: feedTruncated, oldest_covered: feedTruncated ? 1751000000 : null });
    }
    if (url.includes('/api/reports?')) {
      const hit = Object.keys(targeted).find(hex => url.toLowerCase().includes(hex));
      return jsonResponse({ success: true, events: hit ? targeted[hit] : [], truncated: targetedTruncated });
    }
    if (url.includes('/api/resolution-label-targets')) {
      return labels ? labels() : jsonResponse({ success: true, targets: [], truncated: false, oldest_covered: null });
    }
    if (url.includes('/api/resolution-state')) return jsonResponse({ success: true, resolved: [], states: [] });
    if (url.includes('/api/relay-rpc')) return jsonResponse({ success: true, result: [] });
    return jsonResponse({ success: true });
  }));
}

const failLabels = () => jsonResponse({ success: false, error: 'unavailable' }, 502);

function RoutedReports() {
  const { pathname } = useLocation();
  const reportId = pathname.match(/^\/reports\/([0-9a-f]{64})$/)?.[1];
  return <Reports relayUrl={RELAY_URL} selectedReportId={reportId} />;
}

function renderAt(path: string) {
  window.history.pushState({}, '', path);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });
  render(<TestApp queryClient={queryClient}><RoutedReports /></TestApp>);
  return queryClient;
}

const pendingSwitch = () => screen.queryByRole('switch', { name: /pending review/i });
const hideResolvedSwitch = () => screen.getByRole('switch', { name: /hide resolved/i });
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });

let consoleError: MockInstance;
beforeEach(() => {
  grouped.calls = 0;
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  consoleError.mockRestore();
  window.history.pushState({}, '', '/');
});

// The labels read failed and the moderator went on without it, so the browser
// cannot see that the worker already resolved the CSAM report in history.
describe('a resolved CSAM report that only history holds, with labels overridden', () => {
  async function overrideLabels() {
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /show the queue anyway/i }));
  }

  it('opens from /reports/<id> without the switch toggling', async () => {
    stubWorker({ labels: failLabels });
    renderAt(`/reports/${CSAM_REPORT.id}`);
    await overrideLabels();

    await waitFor(() => expect(screen.getByTestId('detail')).toBeInTheDocument());
    await flush();
    // Settled in the history view, the row listed, no switch behind it.
    expect(grouped.calls).toBeLessThan(100);
    expect(pendingSwitch()).toBeNull();
    expect(hideResolvedSwitch()).not.toBeChecked();
    expect(await screen.findByText(NPUB_CSAM)).toBeInTheDocument();
  });

  // Pins what membership is built from: not history, whose targets the worker
  // already resolved.
  it('lists the history row instead of hiding it as a switch member', async () => {
    stubWorker({ labels: failLabels });
    renderAt('/reports');
    await overrideLabels();
    await screen.findByText(NOTE_SPAM);
    const user = userEvent.setup();
    await user.click(hideResolvedSwitch());

    expect(await screen.findByText(NPUB_CSAM)).toBeInTheDocument();
    // The badge counts the feed's targets behind the switch: none.
    expect(pendingSwitch()).toBeNull();
  });
});

// #323's rule: while a resolution read is unread, a CSAM-signal target stays
// behind the switch rather than in the default view. The loading skeleton holds
// the list while labels load, so the case that still reaches the screen is a
// read that failed and was overridden.
describe('a CSAM-signal target while the labels read is overridden', () => {
  it('stays behind the switch, in the default view and in history', async () => {
    stubWorker({ feed: [CSAM_REPORT, SPAM_REPORT], history: [], labels: failLabels });
    renderAt('/reports');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /show the queue anyway/i }));
    await screen.findByText(NOTE_SPAM);

    expect(screen.queryByText(NPUB_CSAM)).not.toBeInTheDocument();
    expect(document.querySelector('label[for="pending-review"]')?.textContent).toBe('Pending review (sensitive)1');

    await user.click(hideResolvedSwitch());
    await flush();
    expect(screen.queryByText(NPUB_CSAM)).not.toBeInTheDocument();
  });
});

describe('the switch label beside a failed queue', () => {
  it('gives a deep-linked CSAM report its "not hidden" state', async () => {
    stubWorker({
      feedReply: () => jsonResponse({ success: false, error: 'Relay query timed out' }, 502),
      targeted: { [CSAM_PROFILE]: [CSAM_REPORT] },
    });
    renderAt(`/reports?pubkey=${CSAM_PROFILE}`);

    const detail = await screen.findByTestId('detail');
    await waitFor(() => expect(detail).toHaveAttribute('data-switch-state', 'not-hidden'));
    expect(screen.getByText(/Failed to load reports/)).toBeInTheDocument();
    // The deep link's own read is the complete one: not a history-only selection.
    expect(detail).toHaveAttribute('data-reports-partial', 'false');
  });
});

describe('what the pane knows of the selected target', () => {
  const incomplete = () => screen.getByTestId('detail').getAttribute('data-reports-partial');

  it('calls a history-only selection incomplete: its other reports may be on pages not loaded', async () => {
    stubWorker({});
    renderAt(`/reports/${CSAM_REPORT.id}`);

    await screen.findByTestId('detail');
    await waitFor(() => expect(incomplete()).toBe('true'));
  });

  it('calls a history row clicked in the history view incomplete', async () => {
    stubWorker({});
    const user = userEvent.setup();
    renderAt('/reports');
    await screen.findByText(NOTE_SPAM);
    await user.click(hideResolvedSwitch());
    await user.click(await screen.findByText(NPUB_CSAM));

    await waitFor(() => expect(incomplete()).toBe('true'));
  });

  it('calls a ?event= link that lands while history is open incomplete', async () => {
    const HISTORY_EVENT = '6'.repeat(64);
    const HISTORY_EVENT_REPORT = report('e'.repeat(64), 1751000010, [['e', HISTORY_EVENT, 'spam'], ['p', '9'.repeat(64), 'spam']]);
    stubWorker({ history: [HISTORY_EVENT_REPORT] });
    const user = userEvent.setup();
    renderAt('/reports');
    await screen.findByText(NOTE_SPAM);
    await user.click(hideResolvedSwitch());
    await screen.findByText(nip19.noteEncode(HISTORY_EVENT));

    await act(async () => {
      window.history.pushState({}, '', `/reports?event=${HISTORY_EVENT}`);
      window.dispatchEvent(new PopStateEvent('popstate'));
    });

    await screen.findByTestId('detail');
    await waitFor(() => expect(incomplete()).toBe('true'));
  });

  it('calls a feed target partial when the feed stopped early: older reports on it may be missing', async () => {
    stubWorker({ feedTruncated: true });
    const user = userEvent.setup();
    renderAt('/reports');
    await user.click(await screen.findByText(NOTE_SPAM));

    await screen.findByTestId('detail');
    expect(incomplete()).toBe('true');
  });

  it('keeps a feed target complete when the feed read to its end (control)', async () => {
    stubWorker({ feedTruncated: false });
    const user = userEvent.setup();
    renderAt('/reports');
    await user.click(await screen.findByText(NOTE_SPAM));

    await screen.findByTestId('detail');
    expect(incomplete()).toBe('false');
  });

  it('keeps a complete targeted read complete for a deep link written in uppercase hex', async () => {
    const MIXED_EVENT = 'abcdef'.repeat(10) + 'abcd';
    const MIXED_REPORT = report('e'.repeat(64), 1751000070, [['e', MIXED_EVENT, 'spam'], ['p', '9'.repeat(64), 'spam']]);
    stubWorker({ feed: [], history: [], targeted: { [MIXED_EVENT]: [MIXED_REPORT] } });
    renderAt(`/reports?event=${MIXED_EVENT.toUpperCase()}`);

    await screen.findByTestId('detail');
    await waitFor(() => expect(window.location.pathname).toBe(`/reports/${MIXED_REPORT.id}`));
    expect(incomplete()).toBe('false');
  });

  it('keeps a feed target complete in the history view too', async () => {
    stubWorker({});
    const user = userEvent.setup();
    renderAt('/reports');
    await screen.findByText(NOTE_SPAM);
    await user.click(hideResolvedSwitch());
    await screen.findByText(NPUB_CSAM);
    await user.click(screen.getByText(NOTE_SPAM));

    await screen.findByTestId('detail');
    expect(incomplete()).toBe('false');
  });

  it('calls a deep link whose targeted read stopped early partial', async () => {
    stubWorker({ feed: [], history: [], targeted: { [SPAM_EVENT]: [SPAM_REPORT] }, targetedTruncated: true });
    renderAt(`/reports?event=${SPAM_EVENT}`);

    await screen.findByTestId('detail');
    expect(incomplete()).toBe('true');
  });

  it('calls a post opened by a ?pubkey= link partial: the read was for the account, not the post', async () => {
    // The account has reports only on its posts, so the link falls back to those.
    // A report on the same post without the author's p tag is not in that read.
    const account = '9'.repeat(64);
    stubWorker({ feed: [], history: [], targeted: { [account]: [SPAM_REPORT] } });
    renderAt(`/reports?pubkey=${account}`);

    await screen.findByTestId('detail');
    await waitFor(() => expect(window.location.pathname).toBe(`/reports/${SPAM_REPORT.id}`));
    expect(incomplete()).toBe('true');
  });

  it('keeps a feed target complete', async () => {
    stubWorker({});
    const user = userEvent.setup();
    renderAt('/reports');
    await user.click(await screen.findByText(NOTE_SPAM));

    await screen.findByTestId('detail');
    expect(incomplete()).toBe('false');
  });

  it('keeps a target from the complete targeted read complete', async () => {
    stubWorker({ feed: [], history: [], targeted: { [SPAM_EVENT]: [SPAM_REPORT] } });
    renderAt(`/reports?event=${SPAM_EVENT}`);

    await screen.findByTestId('detail');
    expect(incomplete()).toBe('false');
  });
});
