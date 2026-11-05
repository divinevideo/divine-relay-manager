// ABOUTME: Targets only the worker's own decisions resolved, as the needs-attention feed now carries them:
// ABOUTME: a CSAM one goes behind the switch, any other is hidden by Hide resolved and listed from the feed.

import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { useLocation } from 'react-router-dom';
import { nip19 } from 'nostr-tools';
import TestApp from '@/test/TestApp';
import { EMPTY_RESOLVED_PAGE } from '@/test/resolvedHistory';
import { Reports } from './Reports';

const RELAY_URL = 'wss://relay.example';

// Counts the groupings the screen builds, so an unchanged poll can be seen to
// rebuild nothing.
const grouped = vi.hoisted(() => ({ calls: 0 }));
vi.mock('@/lib/consolidateReports', async (orig) => {
  const actual = await orig<typeof import('@/lib/consolidateReports')>();
  return {
    ...actual,
    consolidateReports: (...args: Parameters<typeof actual.consolidateReports>) => {
      grouped.calls += 1;
      return actual.consolidateReports(...args);
    },
  };
});

vi.mock('@/components/ReportDetail', () => ({
  ReportDetail: ({ switchState }: { switchState?: string }) => (
    <div data-testid="detail" data-switch-state={switchState ?? ''} />
  ),
}));

const CSAM_PROFILE = '4'.repeat(64);
const SPAM_PROFILE = '7'.repeat(64);
const SPAM_EVENT = '3'.repeat(64);

function report(id: string, createdAt: number, tags: string[][]) {
  return { id, pubkey: '5'.repeat(64), created_at: createdAt, kind: 1984, tags, content: '', sig: 'f'.repeat(128) };
}

const CSAM_REPORT = report('d'.repeat(64), 1751000000, [
  ['p', CSAM_PROFILE, 'illegal'],
  ['L', 'social.nos.ontology'],
  ['l', 'NS-csam', 'social.nos.ontology'],
]);
const SPAM_PROFILE_REPORT = report('0'.repeat(64), 1751000030, [['p', SPAM_PROFILE, 'spam']]);
// An ordinary unresolved post report, so the list has a row to wait for.
const SPAM_REPORT = report('c'.repeat(64), 1751000050, [['e', SPAM_EVENT, 'spam'], ['p', '9'.repeat(64), 'spam']]);

const NPUB_CSAM = nip19.npubEncode(CSAM_PROFILE);
const NPUB_SPAM_PROFILE = nip19.npubEncode(SPAM_PROFILE);
const NOTE_SPAM = nip19.noteEncode(SPAM_EVENT);

type Resolved = { target_type: string; target_id: string; automated?: boolean };

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

// The worker as it now answers: the feed keeps automation-only targets and
// names them in automated_targets; resolved history leaves them out.
function stubWorker({
  feed,
  automatedTargets = [],
  resolved = [],
  targeted = {},
}: {
  feed: unknown[];
  automatedTargets?: string[];
  // What /api/resolution-state lists as resolved.
  resolved?: Resolved[];
  // A deep link's targeted lookup, keyed by the target's hex.
  targeted?: Record<string, unknown[]>;
}) {
  const calls = { history: 0 };
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('/api/reports?needs_attention=1')) {
      return jsonResponse({ success: true, events: feed, truncated: false, automated_targets: automatedTargets });
    }
    if (url.includes('/api/reports/resolved')) {
      calls.history += 1;
      return jsonResponse(EMPTY_RESOLVED_PAGE);
    }
    if (url.includes('/api/reports?')) {
      const hit = Object.keys(targeted).find((hex) => url.includes(hex));
      return jsonResponse({ success: true, events: hit ? targeted[hit] : [] });
    }
    if (url.includes('/api/resolution-label-targets')) {
      return jsonResponse({ success: true, targets: [], truncated: false, oldest_covered: null });
    }
    if (url.includes('/api/resolution-state')) return jsonResponse({ success: true, resolved, states: [] });
    if (url.includes('/api/relay-rpc')) {
      const { method } = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as { method?: string };
      if (method === 'listbannedpubkeys' || method === 'listbannedevents') return jsonResponse({ success: true, result: [] });
      return jsonResponse({ success: true, result: [] });
    }
    return jsonResponse({ success: true });
  }));
  return calls;
}

function newClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });
}
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const switchLabelText = () => document.querySelector('label[for="pending-review"]')?.textContent ?? null;
const rowFor = (bech32: string) => screen.getByText(bech32).closest('div.rounded-lg') as HTMLElement;

function RoutedReports() {
  const { pathname } = useLocation();
  const reportId = pathname.match(/^\/reports\/([0-9a-f]{64})$/)?.[1];
  return <Reports relayUrl={RELAY_URL} selectedReportId={reportId} />;
}

let consoleError: MockInstance;
beforeEach(() => {
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  consoleError.mockRestore();
  window.history.pushState({}, '', '/');
});

describe('a target only automation resolved, from the needs-attention feed', () => {
  // The decisions read has not marked it yet (it lags the feed): the feed's own
  // marker must not count as a person handling the target.
  it('goes behind the switch when it carries a CSAM signal', async () => {
    stubWorker({ feed: [CSAM_REPORT, SPAM_REPORT], automatedTargets: [`pubkey:${CSAM_PROFILE}`] });
    const user = userEvent.setup();
    render(<TestApp queryClient={newClient()}><Reports relayUrl={RELAY_URL} /></TestApp>);

    await screen.findByText(NOTE_SPAM);
    expect(screen.queryByText(NPUB_CSAM)).not.toBeInTheDocument();
    expect(switchLabelText()).toBe('Pending review (sensitive)1');

    await user.click(screen.getByRole('switch', { name: /pending review/i }));
    await flush();
    expect(within(rowFor(NPUB_CSAM)).getByText('Not hidden, needs review')).toBeInTheDocument();
  });

  it('is hidden by Hide resolved otherwise, and listed from the feed, not history, with it off', async () => {
    const calls = stubWorker({ feed: [SPAM_PROFILE_REPORT, SPAM_REPORT], automatedTargets: [`pubkey:${SPAM_PROFILE}`] });
    const user = userEvent.setup();
    render(<TestApp queryClient={newClient()}><Reports relayUrl={RELAY_URL} /></TestApp>);

    await screen.findByText(NOTE_SPAM);
    expect(screen.queryByText(NPUB_SPAM_PROFILE)).not.toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: /pending review/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole('switch', { name: /hide resolved/i }));
    // Resolved history answered with nothing, so the row is the feed's.
    await waitFor(() => expect(calls.history).toBeGreaterThan(0));
    expect(await screen.findByText(NPUB_SPAM_PROFILE)).toBeInTheDocument();
  });
});

describe('a feed poll that returns the same answer', () => {
  // The feed's query data has to stay plain for TanStack Query to keep its
  // reference when nothing changed. Anything else rebuilds the whole queue on
  // every poll.
  it('keeps the feed it had and groups nothing again', async () => {
    stubWorker({ feed: [CSAM_REPORT, SPAM_REPORT], automatedTargets: [`pubkey:${CSAM_PROFILE}`] });
    const queryClient = newClient();
    render(<TestApp queryClient={queryClient}><Reports relayUrl={RELAY_URL} /></TestApp>);
    await screen.findByText(NOTE_SPAM);
    await flush();

    const before = queryClient.getQueryData(['reports', RELAY_URL]);
    grouped.calls = 0;
    await act(async () => { await queryClient.refetchQueries({ queryKey: ['reports', RELAY_URL] }); });
    await flush();

    expect(queryClient.getQueryData(['reports', RELAY_URL])).toBe(before);
    expect(grouped.calls).toBe(0);
  });
});

describe('a target only automation resolved, from a deep link', () => {
  // The feed does not hold it (a worker from before automated_targets, or a feed
  // that stopped early); the decisions read marks it automated.
  it('opens the switch on a CSAM-signal account', async () => {
    stubWorker({
      feed: [SPAM_REPORT],
      resolved: [{ target_type: 'pubkey', target_id: CSAM_PROFILE, automated: true }],
      targeted: { [CSAM_PROFILE]: [CSAM_REPORT] },
    });
    window.history.pushState({}, '', `/reports?pubkey=${CSAM_PROFILE}`);
    render(<TestApp queryClient={newClient()}><RoutedReports /></TestApp>);

    await waitFor(() => expect(window.location.pathname).toBe(`/reports/${CSAM_REPORT.id}`));
    await waitFor(() => expect(screen.getByRole('switch', { name: /pending review/i })).toBeChecked());
    expect(within(rowFor(NPUB_CSAM)).getByText('Not hidden, needs review')).toBeInTheDocument();
  });
});
