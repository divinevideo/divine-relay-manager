// ABOUTME: resolvedTargets is subtractive, so a resolution source that is
// ABOUTME: missing or errored un-hides handled work rather than hiding more (#221)

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { QueryClient, onlineManager } from '@tanstack/react-query';
import { nip19 } from 'nostr-tools';
import TestApp from '@/test/TestApp';
import { Reports } from './Reports';

const RELAY_URL = 'wss://relay.example';

// The detail pane is irrelevant here and pulls in relay traffic of its own.
vi.mock('@/components/ReportDetail', () => ({
  ReportDetail: () => <div data-testid="detail" />,
}));

const REPORTED_PUBKEY = 'd'.repeat(64);
const REPORTED_NPUB = nip19.npubEncode(REPORTED_PUBKEY);

const REPORT = {
  id: 'a'.repeat(64),
  pubkey: 'b'.repeat(64),
  created_at: 1751000000,
  kind: 1984,
  tags: [['p', REPORTED_PUBKEY, 'spam']],
  content: 'comment spam',
  sig: 'e'.repeat(128),
};

// A second, independent report targeting an event, so banned-events (which
// only resolves event targets) has something of its own to genuinely hide.
const REPORTED_EVENT_ID = 'c'.repeat(64);
const REPORTED_NOTE = nip19.noteEncode(REPORTED_EVENT_ID);

const EVENT_REPORT = {
  id: '9'.repeat(64),
  pubkey: 'b'.repeat(64),
  created_at: 1751000050,
  kind: 1984,
  tags: [['e', REPORTED_EVENT_ID, 'spam']],
  content: 'event spam',
  sig: 'e'.repeat(128),
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Each source can be told to succeed with data, succeed empty, or fail.
interface SourceState {
  labels?: 'resolves' | 'empty' | 'error';
  bannedPubkeys?: 'resolves' | 'empty' | 'error';
  bannedEvents?: 'resolves' | 'empty' | 'error';
  decisions?: 'resolves' | 'empty' | 'error';
  slow?: Array<'labels' | 'bannedPubkeys' | 'bannedEvents' | 'decisions'>;
  // banned-events resolves EVENT targets, not pubkey targets, so exercising
  // it for real needs a second fixture report with an `e` tag in the queue.
  includeEventReport?: boolean;
}

function stubFetch(state: SourceState) {
  const never = new Promise<Response>(() => {});
  const slow = new Set(state.slow ?? []);

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);

    if (url.includes('/api/reports')) {
      const events = state.includeEventReport ? [REPORT, EVENT_REPORT] : [REPORT];
      return jsonResponse({ success: true, events });
    }

    if (url.includes('/api/resolution-labels')) {
      if (slow.has('labels')) return never;
      if (state.labels === 'error') return jsonResponse({ success: false, error: 'relay timeout' }, 502);
      return jsonResponse({
        success: true,
        events: state.labels === 'resolves'
          ? [{
              id: 'f'.repeat(64),
              pubkey: 'b'.repeat(64),
              created_at: 1751000100,
              kind: 1985,
              tags: [['L', 'moderation/resolution'], ['p', REPORTED_PUBKEY]],
              content: '',
              sig: 'e'.repeat(128),
            }]
          : [],
      });
    }

    if (url.includes('/api/decisions')) {
      if (slow.has('decisions')) return never;
      if (state.decisions === 'error') return jsonResponse({ success: false, error: 'cold start timeout' }, 500);
      return jsonResponse({
        success: true,
        decisions: state.decisions === 'resolves'
          ? [{ id: 1, target_type: 'pubkey', target_id: REPORTED_PUBKEY, action: 'dismissed', created_at: '2026-06-14 00:00:00' }]
          : [],
      });
    }

    if (url.includes('/api/relay-rpc')) {
      const method = String(init?.body ?? '').includes('listbannedpubkeys') ? 'bannedPubkeys' : 'bannedEvents';
      if (slow.has(method)) return never;
      const mode = method === 'bannedPubkeys' ? state.bannedPubkeys : state.bannedEvents;
      if (mode === 'error') return jsonResponse({ success: false, error: 'nip-86 failed' }, 500);
      const result = mode !== 'resolves'
        ? []
        : method === 'bannedPubkeys'
          ? [{ pubkey: REPORTED_PUBKEY }]
          : [{ id: REPORTED_EVENT_ID }];
      return jsonResponse({ success: true, result });
    }

    return jsonResponse({ success: true });
  });

  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

let consoleWarn: MockInstance;
let consoleError: MockInstance;

beforeEach(() => {
  consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  // Not vi.restoreAllMocks(): that also restores window.matchMedia, a plain
  // vi.fn() (not a spy) installed once in src/test/setup.ts, wiping its
  // implementation for every test after the first in this file.
  consoleWarn.mockRestore();
  consoleError.mockRestore();
});

function renderReports(queryClient?: QueryClient) {
  return render(
    <TestApp queryClient={queryClient}>
      <Reports relayUrl={RELAY_URL} />
    </TestApp>
  );
}

describe('resolution sources genuinely hide handled work (controls)', () => {
  // These controls exist so the tests below measure an ACTUAL un-hide. Without
  // them, a target that was never filtered in the first place would make every
  // "it appears" assertion pass for the wrong reason.
  it('hides a target resolved by a resolution label', async () => {
    stubFetch({ labels: 'resolves', bannedPubkeys: 'empty', bannedEvents: 'empty', decisions: 'empty' });
    renderReports();

    await waitFor(() => expect(screen.getByText(/0 pending/i)).toBeInTheDocument());
    expect(screen.queryByText(REPORTED_NPUB)).not.toBeInTheDocument();
  });

  it('hides a target resolved by the banned pubkeys list', async () => {
    stubFetch({ labels: 'empty', bannedPubkeys: 'resolves', bannedEvents: 'empty', decisions: 'empty' });
    renderReports();

    await waitFor(() => expect(screen.getByText(/0 pending/i)).toBeInTheDocument());
    expect(screen.queryByText(REPORTED_NPUB)).not.toBeInTheDocument();
  });

  it('hides a target resolved by a moderation decision', async () => {
    stubFetch({ labels: 'empty', bannedPubkeys: 'empty', bannedEvents: 'empty', decisions: 'resolves' });
    renderReports();

    await waitFor(() => expect(screen.getByText(/0 pending/i)).toBeInTheDocument());
    expect(screen.queryByText(REPORTED_NPUB)).not.toBeInTheDocument();
  });

  it('shows the target when no source resolves it', async () => {
    stubFetch({ labels: 'empty', bannedPubkeys: 'empty', bannedEvents: 'empty', decisions: 'empty' });
    renderReports();

    expect(await screen.findByText(REPORTED_NPUB)).toBeInTheDocument();
  });

  // banned-events only resolves EVENT targets, so it needs its own fixture
  // report (an `e`-tagged target) alongside the pubkey-tagged one above.
  it('hides a target resolved by the banned events list', async () => {
    stubFetch({ labels: 'empty', bannedPubkeys: 'empty', bannedEvents: 'resolves', decisions: 'empty', includeEventReport: true });
    renderReports();

    await waitFor(() => expect(screen.getByText(/1 pending/i)).toBeInTheDocument());
    expect(screen.queryByText(REPORTED_NOTE)).not.toBeInTheDocument();
    // The pubkey-target report is untouched by banned-events, proving this
    // control hid the event target specifically rather than the whole queue.
    expect(screen.getByText(REPORTED_NPUB)).toBeInTheDocument();
  });

  it('shows both targets when banned events resolves nothing', async () => {
    stubFetch({ labels: 'empty', bannedPubkeys: 'empty', bannedEvents: 'empty', decisions: 'empty', includeEventReport: true });
    renderReports();

    expect(await screen.findByText(REPORTED_NOTE)).toBeInTheDocument();
    expect(screen.getByText(REPORTED_NPUB)).toBeInTheDocument();
  });
});

describe('cold load does not render an unfiltered queue (#221)', () => {
  // Both tests use a QueryClient the test holds directly, so the precondition
  // can be "the reports query has genuinely settled" (checked against cache
  // state, not render output). A DOM-only precondition can't tell "the fetch
  // was issued" from "the fetch resolved and React re-rendered", and both the
  // loading skeleton and the blocked-gate skeleton look identical on screen,
  // so a render-based signal can't distinguish "still loading" from "blocked
  // by the gate" either. Cache state has no such ambiguity.
  function newTestQueryClient() {
    return new QueryClient({
      defaultOptions: { queries: { retry: false, retryDelay: 0 }, mutations: { retry: false, retryDelay: 0 } },
    });
  }

  it('keeps the skeleton up while the banned pubkeys list is still loading', async () => {
    // Reports resolve fast; this source never does. Before the fix the queue
    // painted the already-banned target as pending in the gap.
    stubFetch({ labels: 'empty', bannedPubkeys: 'resolves', bannedEvents: 'empty', decisions: 'empty', slow: ['bannedPubkeys'] });
    const queryClient = newTestQueryClient();
    renderReports(queryClient);

    // Positive precondition: the reports query has actually settled, not just
    // "some time has passed." Only once we know reports resolved does an
    // absent target mean "the gate is blocking," rather than "reports have
    // not loaded yet."
    await waitFor(() => expect(queryClient.getQueryState(['reports', RELAY_URL])?.status).toBe('success'));
    expect(screen.getByTestId('reports-loading-skeleton')).toBeInTheDocument();
    expect(screen.queryByText(REPORTED_NPUB)).not.toBeInTheDocument();
  });

  it('keeps the skeleton up while resolution labels are still loading', async () => {
    stubFetch({ labels: 'resolves', bannedPubkeys: 'empty', bannedEvents: 'empty', decisions: 'empty', slow: ['labels'] });
    const queryClient = newTestQueryClient();
    renderReports(queryClient);

    await waitFor(() => expect(queryClient.getQueryState(['reports', RELAY_URL])?.status).toBe('success'));
    expect(screen.getByTestId('reports-loading-skeleton')).toBeInTheDocument();
    expect(screen.queryByText(REPORTED_NPUB)).not.toBeInTheDocument();
  });

  it('renders once every gating source has landed', async () => {
    stubFetch({ labels: 'empty', bannedPubkeys: 'empty', bannedEvents: 'empty', decisions: 'empty' });
    renderReports();

    expect(await screen.findByText(REPORTED_NPUB)).toBeInTheDocument();
  });
});

describe('cold error blocks the queue and offers an override (#221)', () => {
  it('blocks rather than presenting a resolved target as pending when decisions fails cold', async () => {
    // decisions is the source that would have hidden this target.
    stubFetch({ labels: 'empty', bannedPubkeys: 'empty', bannedEvents: 'empty', decisions: 'error' });
    renderReports();

    expect(await screen.findByText(/resolution state is unavailable/i)).toBeInTheDocument();
    expect(screen.getByText(/moderation decisions/i)).toBeInTheDocument();
    expect(screen.queryByText(REPORTED_NPUB)).not.toBeInTheDocument();
  });

  it('blocks when the banned accounts list fails cold', async () => {
    stubFetch({ labels: 'empty', bannedPubkeys: 'error', bannedEvents: 'empty', decisions: 'empty' });
    renderReports();

    expect(await screen.findByText(/resolution state is unavailable/i)).toBeInTheDocument();
    expect(screen.getByText(/banned accounts/i)).toBeInTheDocument();
  });

  it('renders the unfiltered queue with a persistent warning once the moderator overrides', async () => {
    stubFetch({ labels: 'empty', bannedPubkeys: 'error', bannedEvents: 'empty', decisions: 'empty' });
    const user = userEvent.setup();
    renderReports();

    await user.click(await screen.findByRole('button', { name: /show the queue without resolution filtering/i }));

    expect(await screen.findByText(REPORTED_NPUB)).toBeInTheDocument();
    // The warning must persist alongside the list, not flash and vanish.
    expect(screen.getByText(/some of these may already be handled/i)).toBeInTheDocument();
  });

  it('warns that auto-hidden content can appear when decisions is the failed source', async () => {
    stubFetch({ labels: 'empty', bannedPubkeys: 'empty', bannedEvents: 'empty', decisions: 'error' });
    const user = userEvent.setup();
    renderReports();

    await user.click(await screen.findByRole('button', { name: /show the queue without resolution filtering/i }));

    expect(await screen.findByText(/auto-hidden/i)).toBeInTheDocument();
  });

  it('does not block on a cold labels error while hide-resolved is off', async () => {
    // resolvedTargets is not applied in that view, so labels cannot un-hide
    // anything and blocking would be a lie.
    stubFetch({ labels: 'error', bannedPubkeys: 'empty', bannedEvents: 'empty', decisions: 'empty' });
    const user = userEvent.setup();
    renderReports();

    // Brief assertion amended: hideResolved defaults to true, so with resolvedFilterActive
    // true at mount, labels genuinely does gate (matching the other "blocks" tests above) and
    // the blocked pane fully replaces the queue, filters included, the same way the loading
    // skeleton does. There is no way to reach the hide-resolved switch except through the
    // override, so use it to get there, then confirm the block does not return once
    // hide-resolved is off -- that's the actual claim this test makes.
    await user.click(await screen.findByRole('button', { name: /show the queue without resolution filtering/i }));
    // The "Hide resolved" control is a shadcn/Radix Switch (role="switch") with
    // an associated <Label htmlFor="hide-resolved">; verified against
    // Reports.tsx:1217-1230 and the existing selector in
    // Reports.deeplink.test.tsx:178.
    await user.click(await screen.findByRole('switch', { name: /hide resolved/i }));

    expect(await screen.findByText(REPORTED_NPUB)).toBeInTheDocument();
    expect(screen.queryByText(/resolution state is unavailable/i)).not.toBeInTheDocument();
    // The override is still on (component state, nothing reset it), so an
    // absent pane alone doesn't prove labels stopped gating -- the override
    // would mask that regardless. The persistent warning is driven by the
    // same blockingErrors set as the pane, so its disappearance is the real
    // signal that gatingSources actually dropped labels once hide-resolved
    // went off, not just that the override happens to still be in effect.
    expect(screen.queryByText(/some of these may already be handled/i)).not.toBeInTheDocument();
  });

  it('shows no unavailable pane when every source is healthy', async () => {
    // Pinning the negative: a pane that renders unconditionally passes every
    // positive test above.
    stubFetch({ labels: 'empty', bannedPubkeys: 'empty', bannedEvents: 'empty', decisions: 'empty' });
    renderReports();

    await screen.findByText(REPORTED_NPUB);
    expect(screen.queryByText(/resolution state is unavailable/i)).not.toBeInTheDocument();
  });
});

describe('offline pauses resolution sources instead of failing them (#221)', () => {
  afterEach(() => {
    // Guard against a failing assertion above leaving the manager offline for
    // later tests in this file.
    onlineManager.setOnline(true);
  });

  it('explains the queue cannot check resolution state while offline, instead of an indefinite skeleton', async () => {
    stubFetch({ labels: 'empty', bannedPubkeys: 'empty', bannedEvents: 'empty', decisions: 'empty' });
    // Set offline before mount: React Query only reaches fetchStatus 'paused'
    // when a query wants to start a fetch while the manager reports offline.
    // Going offline mid-fetch would not retroactively pause an in-flight call.
    onlineManager.setOnline(false);
    renderReports();

    expect(await screen.findByText(/cannot check .*while offline/i)).toBeInTheDocument();
    expect(screen.queryByTestId('reports-loading-skeleton')).not.toBeInTheDocument();
  });
});
