// ABOUTME: resolvedTargets is subtractive, so a resolution source that is
// ABOUTME: missing or errored un-hides handled work rather than hiding more (#221)

import { act, render, screen, waitFor } from '@testing-library/react';
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

// An event report that also names its author, which is what lets a ban on the
// ACCOUNT clear reports filed against its individual posts. EVENT_REPORT above
// deliberately carries no `p` tag, so the two together separate "hidden because
// the author is banned" from "hidden because it is an event report".
const AUTHORED_EVENT_ID = '7'.repeat(64);
const AUTHORED_NOTE = nip19.noteEncode(AUTHORED_EVENT_ID);

function authoredEventReport(pTag: string) {
  return {
    id: '8'.repeat(64),
    pubkey: 'b'.repeat(64),
    created_at: 1751000060,
    kind: 1984,
    tags: [['e', AUTHORED_EVENT_ID, 'spam'], ['p', pTag]],
    content: 'a post by the reported account',
    sig: 'e'.repeat(128),
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Each source can be told to succeed with data, succeed empty, or fail.
interface SourceState {
  // The reports query itself, distinct from the four resolution sources
  // below (#221 fix 1: it fails BEFORE the resolution-unavailable pane gets
  // a chance to, since it's the more fundamental failure).
  reports?: 'ok' | 'error';
  labels?: 'resolves' | 'empty' | 'error';
  bannedPubkeys?: 'resolves' | 'empty' | 'error';
  bannedEvents?: 'resolves' | 'empty' | 'error';
  decisions?: 'resolves' | 'empty' | 'error';
  slow?: Array<'labels' | 'bannedPubkeys' | 'bannedEvents' | 'decisions'>;
  // banned-events resolves EVENT targets, not pubkey targets, so exercising
  // it for real needs a second fixture report with an `e` tag in the queue.
  includeEventReport?: boolean;
  // An `e`-tagged report that also carries a `p` tag. Pass the pubkey the report
  // names as the author; omit for none.
  authoredEventReportP?: string;
}

function stubFetch(state: SourceState) {
  const never = new Promise<Response>(() => {});
  const slow = new Set(state.slow ?? []);

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);

    if (url.includes('/api/reports')) {
      if (state.reports === 'error') return jsonResponse({ success: false, error: 'relay unreachable' }, 500);
      const events: unknown[] = [REPORT];
      if (state.includeEventReport) events.push(EVENT_REPORT);
      if (state.authoredEventReportP) events.push(authoredEventReport(state.authoredEventReportP));
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

  // Banning an ACCOUNT clears the account's own report, but the reports filed
  // against its individual posts were matched only by their own event key, so
  // they stayed in the queue as unhandled work after the account was gone.
  // banned-events is deliberately empty in these: the relay does not register an
  // event under banpubkey, which is the whole reason the author path exists.
  it('hides an event target once its author is banned, with the event itself unbanned', async () => {
    stubFetch({
      labels: 'empty', bannedPubkeys: 'resolves', bannedEvents: 'empty', decisions: 'empty',
      includeEventReport: true, authoredEventReportP: REPORTED_PUBKEY,
    });
    renderReports();

    await waitFor(() => expect(screen.getByText(/1 pending/i)).toBeInTheDocument());
    expect(screen.queryByText(AUTHORED_NOTE)).not.toBeInTheDocument();
    // The event report that names no author is untouched, so this measures the
    // author match specifically rather than event reports being hidden wholesale.
    expect(screen.getByText(REPORTED_NOTE)).toBeInTheDocument();
  });

  it('keeps an event target whose author is not banned', async () => {
    stubFetch({
      labels: 'empty', bannedPubkeys: 'empty', bannedEvents: 'empty', decisions: 'empty',
      authoredEventReportP: REPORTED_PUBKEY,
    });
    renderReports();

    expect(await screen.findByText(AUTHORED_NOTE)).toBeInTheDocument();
  });

  // `p` tag values are reporter-authored and validated as hex without being
  // case-normalized, while the relay's ban list is lowercase. An uppercase tag
  // must still match, or the ban silently fails to clear the post's report.
  it('hides an event target whose author is banned but written uppercase in the tag', async () => {
    stubFetch({
      labels: 'empty', bannedPubkeys: 'resolves', bannedEvents: 'empty', decisions: 'empty',
      authoredEventReportP: REPORTED_PUBKEY.toUpperCase(),
    });
    renderReports();

    await waitFor(() => expect(screen.getByText(/0 pending/i)).toBeInTheDocument());
    expect(screen.queryByText(AUTHORED_NOTE)).not.toBeInTheDocument();
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

  // The decisions descriptor is what replaced main's `decisionsLoading` guard,
  // whose comment named its purpose: "This prevents auto-hidden CSAM from
  // briefly appearing in default view". Without this test, setting the
  // descriptor's `isPending` to a constant `false` leaves the whole suite
  // green -- decisions stops gating on LOADING and, since pendingReviewTargets
  // is derived entirely from allDecisions, auto-hidden targets paint in the
  // default queue for the duration of the fetch.
  it('keeps the skeleton up while moderation decisions are still loading', async () => {
    stubFetch({ labels: 'empty', bannedPubkeys: 'empty', bannedEvents: 'empty', decisions: 'empty', slow: ['decisions'] });
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
  it('reports the reports-query failure, not the resolution-unavailable pane, when both fail (#221 fix 1)', async () => {
    // The relay read failing is the more fundamental problem: if reports
    // itself can't load, resolution state is beside the point, and the
    // resolution pane's Retry can't fix it (it only invalidates the four
    // resolution queries). The moderator should see the reports failure.
    stubFetch({ reports: 'error', labels: 'empty', bannedPubkeys: 'empty', bannedEvents: 'empty', decisions: 'error' });
    renderReports();

    expect(await screen.findByText(/failed to load reports/i)).toBeInTheDocument();
    expect(screen.queryByText(/resolution state is unavailable/i)).not.toBeInTheDocument();
  });

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

  // banned-events is the only one of the four sources with no gating test of
  // its own: deleting its whole entry from `resolutionSources` leaves the
  // suite green, which would silently drop event targets back out of the
  // gate. Paired with the "hides a target resolved by the banned events list"
  // control above, this measures an actual un-hide.
  it('blocks when the banned posts list fails cold', async () => {
    stubFetch({ labels: 'empty', bannedPubkeys: 'empty', bannedEvents: 'error', decisions: 'empty', includeEventReport: true });
    renderReports();

    expect(await screen.findByText(/resolution state is unavailable/i)).toBeInTheDocument();
    expect(screen.getByText(/banned posts/i)).toBeInTheDocument();
    expect(screen.queryByText(REPORTED_NOTE)).not.toBeInTheDocument();
  });

  it('renders the unfiltered queue with a persistent warning once the moderator overrides', async () => {
    stubFetch({ labels: 'empty', bannedPubkeys: 'error', bannedEvents: 'empty', decisions: 'empty' });
    const user = userEvent.setup();
    renderReports();

    await user.click(await screen.findByRole('button', { name: /show the queue anyway/i }));

    expect(await screen.findByText(REPORTED_NPUB)).toBeInTheDocument();
    // The warning must persist alongside the list, not flash and vanish.
    expect(screen.getByText(/some of these may already be handled/i)).toBeInTheDocument();
  });

  it('warns that auto-hidden content can appear when decisions is the failed source', async () => {
    stubFetch({ labels: 'empty', bannedPubkeys: 'empty', bannedEvents: 'empty', decisions: 'error' });
    const user = userEvent.setup();
    renderReports();

    await user.click(await screen.findByRole('button', { name: /show the queue anyway/i }));

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
    await user.click(await screen.findByRole('button', { name: /show the queue anyway/i }));
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

  it('the blocked pane warns that overriding will include auto-hidden content', async () => {
    // Same fixture as "warns that auto-hidden content can appear..." above,
    // but asserted BEFORE clicking the override -- the pane's own paragraph,
    // not the post-override ResolutionOverrideWarning sentence, which the
    // other test already covers.
    stubFetch({ labels: 'empty', bannedPubkeys: 'empty', bannedEvents: 'empty', decisions: 'error' });
    renderReports();

    expect(await screen.findByText(/resolution state is unavailable/i)).toBeInTheDocument();
    expect(
      screen.getByText(/if you continue, the unfiltered queue will also include auto-hidden content/i)
    ).toBeInTheDocument();
  });

  it('the override does not show a stale banner for a source that has no data at all', async () => {
    // decisions fails cold (no seeded data), so it belongs in blockingErrors,
    // never in staleSources -- a stale banner for a source with no data at
    // all would report a nonsense age (updatedAt 0).
    stubFetch({ labels: 'empty', bannedPubkeys: 'empty', bannedEvents: 'empty', decisions: 'error' });
    const user = userEvent.setup();
    renderReports();

    await user.click(await screen.findByRole('button', { name: /show the queue anyway/i }));

    expect(await screen.findByText(REPORTED_NPUB)).toBeInTheDocument();
    expect(screen.queryByText(/showing resolution state from/i)).not.toBeInTheDocument();
  });

  it('still blocks on a cold decisions error while hide-resolved is off', async () => {
    // Mirror image of "does not block on a cold labels error while hide-resolved
    // is off" above: decisions carries gatesAlways because it also feeds
    // pendingReviewTargets, which is applied on every path, so it must keep
    // gating even once the hide-resolved toggle goes off.
    stubFetch({ labels: 'empty', bannedPubkeys: 'empty', bannedEvents: 'empty', decisions: 'error' });
    const user = userEvent.setup();
    renderReports();

    await user.click(await screen.findByRole('button', { name: /show the queue anyway/i }));
    await user.click(await screen.findByRole('switch', { name: /hide resolved/i }));

    // Unlike the labels case, the persistent warning must still be present:
    // decisions did not stop gating just because hide-resolved went off.
    expect(screen.getByText(/some of these may already be handled/i)).toBeInTheDocument();
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

describe('the cold-load wait is bounded well under the poll interval (#221)', () => {
  // Fix 1's latch only helps once a source has FAILED. On a cold first load
  // there is no error yet, so a source that hangs keeps the moderator on the
  // bare skeleton with no Retry and no override, and every one of the four can
  // cause it. The 30s API_TIMEOUT_MS plus a retry is about a minute of that;
  // shortening the bound is the only thing that shrinks the window, and it is
  // twice the 15s poll interval that would have recovered the read anyway.
  //
  // Asserted at the AbortSignal boundary because that is where the bound is
  // actually applied; adminApi's own tests cover the plumbing beneath it.
  it('gives the four resolution reads a shorter deadline than the rest of the app', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    stubFetch({ labels: 'empty', bannedPubkeys: 'empty', bannedEvents: 'empty', decisions: 'empty' });
    renderReports();

    await screen.findByText(REPORTED_NPUB);

    const bounds = timeoutSpy.mock.calls.map(([ms]) => ms);
    // One per resolution source, all four shortened.
    expect(bounds.filter(ms => ms === 8_000).length).toBeGreaterThanOrEqual(4);
    // The reports query itself is untouched, so the change stays scoped to the
    // reads that gate the queue rather than becoming an app-wide retiming.
    expect(bounds).toContain(30_000);

    timeoutSpy.mockRestore();
  });
});

describe('the escape hatch survives the poll that follows a cold failure (#221)', () => {
  // React Query resets a data-less query to `{error: null, status: 'pending'}`
  // the moment a refetch starts (query-core's fetchState, reached from the
  // 'fetch' action), and refetchInterval keeps polling errored queries. Reading
  // the live `error` alone therefore makes a CONTINUOUSLY failing source look
  // like a first load again on every cycle. Since the cold-load skeleton is
  // checked before the blocked pane, that would take Retry and "Show the queue
  // anyway" off the screen for most of each cycle, out from under the cursor.
  //
  // Both directions matter, so both are tested: the latch has to hold across an
  // in-flight retry, and it has to RELEASE when the source genuinely recovers,
  // or the pane would outlive the failure it describes.

  // Fails /api/decisions for the first `failures` attempts, then hands back
  // whatever `after` produces. Everything else stays healthy.
  function stubDecisionsFailingThen(
    failures: number,
    after: (healthy: typeof fetch, input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  ) {
    let attempts = 0;
    stubFetch({ labels: 'empty', bannedPubkeys: 'empty', bannedEvents: 'empty', decisions: 'empty' });
    const healthy = globalThis.fetch as unknown as typeof fetch;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes('/api/decisions')) {
        attempts += 1;
        if (attempts <= failures) {
          return jsonResponse({ success: false, error: 'cold start timeout' }, 500);
        }
        return after(healthy, input, init);
      }
      return healthy(input, init);
    }));
    return () => attempts;
  }

  it('holds the blocked pane while the failed source is mid-retry, instead of falling back to the skeleton', async () => {
    // `retry: 1` means two attempts, so failing three exhausts the retry and
    // settles into an error. The fourth attempt (driven by the Retry button)
    // never resolves: that is exactly the window in which React Query has
    // cleared `error` and put the query back to 'pending' with no data.
    const never = new Promise<Response>(() => {});
    const attempts = stubDecisionsFailingThen(3, () => never);
    const user = userEvent.setup();
    renderReports();

    expect(await screen.findByRole('button', { name: /show the queue anyway/i })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^retry$/i }));
    await waitFor(() => expect(attempts()).toBeGreaterThan(3));

    // The in-flight retry must not swap the pane for a bare skeleton.
    expect(screen.queryByTestId('reports-loading-skeleton')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /show the queue anyway/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^retry$/i })).toBeInTheDocument();
  });

  it('drops the blocked pane once the failed source actually recovers', async () => {
    // The inverse. errorUpdateCount only ever increments, so if `hasData`
    // turning true were not the release condition, the pane would stick
    // forever and no amount of recovery would clear it.
    const attempts = stubDecisionsFailingThen(3, (healthy, input, init) => healthy(input, init));
    const user = userEvent.setup();
    renderReports();

    await user.click(await screen.findByRole('button', { name: /^retry$/i }));

    expect(await screen.findByText(REPORTED_NPUB)).toBeInTheDocument();
    expect(screen.queryByText(/resolution state is unavailable/i)).not.toBeInTheDocument();
    // Nothing else could have un-blocked it: the source really did re-fetch.
    expect(attempts()).toBeGreaterThan(3);
  });
});

describe('the override is scoped to the sources it was granted for (#221)', () => {
  // The blocked pane names the sources it is blocking on, and shows an extra
  // consent paragraph only when DECISIONS is one of them, because proceeding
  // without decisions also drops the exclusion that keeps auto-hidden content
  // out of the default view. A single blanket "overridden" flag let consent
  // given for one source stand in for consent to a different one that failed
  // later, and the moderator never saw that paragraph.

  function stubWithFailingDecisionsSwitch(base: SourceState) {
    let decisionsHealthy = true;
    let attempts = 0;
    stubFetch(base);
    const healthy = globalThis.fetch as unknown as typeof fetch;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes('/api/decisions')) {
        attempts += 1;
        if (!decisionsHealthy) return jsonResponse({ success: false, error: 'cold start timeout' }, 500);
      }
      return healthy(input, init);
    }));
    return {
      breakDecisions: () => { decisionsHealthy = false; },
      decisionsAttempts: () => attempts,
    };
  }

  it('re-blocks when a source outside the override fails, rather than silently covering it', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, retryDelay: 0 }, mutations: { retry: false, retryDelay: 0 } },
    });
    const { breakDecisions } = stubWithFailingDecisionsSwitch({
      labels: 'empty', bannedPubkeys: 'error', bannedEvents: 'empty', decisions: 'empty',
    });
    const user = userEvent.setup();
    renderReports(queryClient);

    // Only banned-pubkeys is blocking, so this consent is about that list alone:
    // the auto-hidden paragraph is not on screen to be consented to.
    expect(await screen.findByText(/banned accounts/i)).toBeInTheDocument();
    expect(
      screen.queryByText(/if you continue, the unfiltered queue will also include auto-hidden content/i)
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /show the queue anyway/i }));
    expect(await screen.findByText(REPORTED_NPUB)).toBeInTheDocument();

    // decisions now fails with nothing cached to fall back on. Clearing its
    // entry first is what makes the failure COLD rather than warm: placeholder
    // data only fills in while a query is still pending, so a source that
    // settles into an error with no cached data has none to show. resetQueries
    // reproduces that (a gcTime eviction, a cache reset) without waiting out a
    // timer.
    breakDecisions();
    await act(async () => {
      await queryClient.resetQueries({ queryKey: ['decisions'] });
    });

    expect(await screen.findByText(/resolution state is unavailable/i)).toBeInTheDocument();
    expect(screen.getByText(/moderation decisions/i)).toBeInTheDocument();
    // The whole point: the moderator is asked about THIS source, and sees the
    // consequence that is specific to it.
    expect(
      screen.getByText(/if you continue, the unfiltered queue will also include auto-hidden content/i)
    ).toBeInTheDocument();
  });

  it('keeps covering the same source when it fails again on a later poll', async () => {
    // The inverse, and the reason this is a Set rather than a re-prompt every
    // cycle: re-asking about a source already acknowledged would put the
    // moderator back on the blocked pane every 15s.
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, retryDelay: 0 }, mutations: { retry: false, retryDelay: 0 } },
    });
    let bannedPubkeyAttempts = 0;
    stubFetch({ labels: 'empty', bannedPubkeys: 'error', bannedEvents: 'empty', decisions: 'empty' });
    const healthy = globalThis.fetch as unknown as typeof fetch;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes('/api/relay-rpc') && String(init?.body ?? '').includes('listbannedpubkeys')) {
        bannedPubkeyAttempts += 1;
      }
      return healthy(input, init);
    }));
    const user = userEvent.setup();
    renderReports(queryClient);

    await user.click(await screen.findByRole('button', { name: /show the queue anyway/i }));
    expect(await screen.findByText(REPORTED_NPUB)).toBeInTheDocument();

    const before = bannedPubkeyAttempts;
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['banned-pubkeys'] });
    });
    expect(bannedPubkeyAttempts).toBeGreaterThan(before);

    // Same source, same failure, already acknowledged: no re-prompt.
    expect(screen.queryByText(/resolution state is unavailable/i)).not.toBeInTheDocument();
    expect(screen.getByText(REPORTED_NPUB)).toBeInTheDocument();
    expect(screen.getByText(/some of these may already be handled/i)).toBeInTheDocument();
  });
});

describe('offline pauses resolution sources instead of failing them (#221)', () => {
  afterEach(() => {
    // Guard against a failing assertion above leaving the manager offline for
    // later tests in this file.
    onlineManager.setOnline(true);
  });

  // This test leaks a stray console.warn: a paused query appears to resume
  // after the test unmounts and warns past the file-level console spy and
  // teardown. The exact mechanism was not confirmed and the interception
  // point was not found. It doesn't affect this test's assertions or
  // pass/fail status; flagged here so a later test's console spy silently
  // absorbing it isn't mistaken for that test's own noise.
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

  // The offline block is the one state fetchStatus 'paused' never times out
  // of on its own -- there's no fetch in flight for the 30s AbortSignal
  // timeout to fire on -- so unlike a cold error it can persist indefinitely.
  // That matters because onlineManager keys on navigator.onLine, a known
  // false-negative source (captive portals, some VM/container network
  // stacks, some Electron/Linux setups): a moderator with working
  // connectivity and a lying navigator.onLine needs a way out that doesn't
  // depend on the browser's offline signal ever clearing.
  it('offers a working override instead of a permanent lock-out when blocked offline (#221)', async () => {
    stubFetch({ labels: 'empty', bannedPubkeys: 'empty', bannedEvents: 'empty', decisions: 'empty' });
    onlineManager.setOnline(false);
    const user = userEvent.setup();
    renderReports();

    await user.click(await screen.findByRole('button', { name: /show the queue anyway/i }));

    // The offline pane must not simply re-render itself: overriding has to
    // move the moderator off the dead end.
    expect(screen.queryByText(/resolution state is unavailable while offline/i)).not.toBeInTheDocument();
    // The persistent warning proves the override is what let it through, the
    // same signal the cold-error override tests above rely on.
    expect(screen.getByText(/some of these may already be handled/i)).toBeInTheDocument();

    // Proves it isn't a one-way door either: once connectivity genuinely
    // returns, the paused sources resume and the queue reflects real data,
    // it doesn't stay stuck on whatever the override bypassed.
    onlineManager.setOnline(true);
    expect(await screen.findByText(REPORTED_NPUB)).toBeInTheDocument();
  });

  // The one route into 'paused' that starts from a SETTLED error rather than a
  // first load, and the only thing the `!isPaused` term in hasColdFailed is
  // for. errorUpdateCount only ever increments, so without that term a source
  // that failed cold stays latched in blockingErrors even after the browser
  // goes offline: blockingLoadPaused is empty, the offline branch is never
  // reached, and the moderator is told the block "usually clears on the next
  // automatic refresh" -- false while there is no connection, and it withholds
  // the one diagnosis that explains why Retry does nothing.
  it('re-reports an already-failed source as offline once connectivity drops', async () => {
    stubFetch({ labels: 'empty', bannedPubkeys: 'empty', bannedEvents: 'empty', decisions: 'error' });
    const user = userEvent.setup();
    renderReports();

    // Precondition: blocked by a settled cold error, not by offline.
    expect(
      await screen.findByText(/the queue cannot tell which reports have already been handled/i)
    ).toBeInTheDocument();
    expect(screen.queryByText(/while offline/i)).not.toBeInTheDocument();

    onlineManager.setOnline(false);
    // Re-entering fetch while the manager reports offline is the only way a
    // query reaches fetchStatus 'paused'; the 15s poll would do it too, and
    // Retry does it deterministically.
    await user.click(screen.getByRole('button', { name: /^retry$/i }));

    expect(await screen.findByText(/cannot check .*while offline/i)).toBeInTheDocument();
  });
});

describe('warm failure keeps the stale filter and says so (#221)', () => {
  // Driving the real 15s poll with fake timers (as the brief's first draft
  // did) hung: React Query's internal retry/backoff scheduling under fake
  // timers left the test unable to settle within the 5s test timeout, and a
  // timed-out `vi.useFakeTimers()` test leaks fake timers into whatever runs
  // next in the file. The brief anticipated this and names the fallback used
  // here: seed the cache with good data via a QueryClient the test holds
  // directly, then render with a fetch that fails for that one source. That
  // reaches the same warm state (hasData && error) without touching the
  // clock at all.
  it('still hides a target resolved by a source whose refresh has started failing', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, retryDelay: 0 }, mutations: { retry: false, retryDelay: 0 } },
    });
    // Past staleTime (30s) so the query refetches on mount instead of
    // serving the seeded data forever.
    const seededAt = Date.now() - 60_000;
    queryClient.setQueryData(['banned-pubkeys'], [{ pubkey: REPORTED_PUBKEY }], { updatedAt: seededAt });

    stubFetch({ labels: 'empty', bannedPubkeys: 'error', bannedEvents: 'empty', decisions: 'empty' });
    renderReports(queryClient);

    await waitFor(() => expect(screen.getByText(/0 pending/i)).toBeInTheDocument());
    // The target stays hidden using the stale (seeded) banned-pubkeys data,
    // not just because the fetch happens to still be pending.
    expect(screen.queryByText(REPORTED_NPUB)).not.toBeInTheDocument();
    expect(await screen.findByText(/showing resolution state from/i)).toBeInTheDocument();

    // Nothing left running: the failed query has retry:false, so it settles
    // into an error state on its own without needing a manual cleanup.
  });

  it('shows no stale banner while every source is refreshing cleanly', async () => {
    // The negative. A banner rendered unconditionally passes the test above.
    stubFetch({ labels: 'empty', bannedPubkeys: 'resolves', bannedEvents: 'empty', decisions: 'empty' });
    renderReports();

    await waitFor(() => expect(screen.getByText(/0 pending/i)).toBeInTheDocument());
    expect(screen.queryByText(/showing resolution state from/i)).not.toBeInTheDocument();
  });
});

describe('truncated resolution history is stated, not silent (#221)', () => {
  // Truncates /api/decisions only. `labels` is left at whatever stubFetch's
  // default state produces (untruncated), so this covers a single-source
  // truncation. See stubTruncatedBoth below for the two-source case that
  // exercises the Math.max-vs-Math.min direction.
  function stubTruncated(oldestCovered: string | null, truncated: boolean) {
    stubFetch({ labels: 'empty', bannedPubkeys: 'empty', bannedEvents: 'empty', decisions: 'empty' });
    const healthy = globalThis.fetch as unknown as typeof fetch;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes('/api/decisions')) {
        return jsonResponse({ success: true, decisions: [], truncated, oldest_covered: oldestCovered });
      }
      return healthy(input, init);
    }));
  }

  // Truncates BOTH /api/resolution-labels and /api/decisions independently,
  // at different depths. The reported window can only be as deep as the
  // MORE restrictive (later) of the two -- Math.max. A regression to
  // Math.min would report the LESS restrictive (earlier) bound instead,
  // falsely telling a moderator history reaches further back than it does.
  // labels' oldest_covered is unix seconds (matches Nostr created_at);
  // decisions' is a SQLite CURRENT_TIMESTAMP string. See adminApi.ts's
  // fetchResolutionLabels/getAllDecisions for the two shapes.
  function stubTruncatedBoth(
    labels: { oldestCoveredUnixSeconds: number; truncated: boolean },
    decisions: { oldestCovered: string; truncated: boolean }
  ) {
    stubFetch({ labels: 'empty', bannedPubkeys: 'empty', bannedEvents: 'empty', decisions: 'empty' });
    const healthy = globalThis.fetch as unknown as typeof fetch;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes('/api/decisions')) {
        return jsonResponse({
          success: true,
          decisions: [],
          truncated: decisions.truncated,
          oldest_covered: decisions.oldestCovered,
        });
      }
      if (url.includes('/api/resolution-labels')) {
        return jsonResponse({
          success: true,
          events: [],
          truncated: labels.truncated,
          oldest_covered: labels.oldestCoveredUnixSeconds,
        });
      }
      return healthy(input, init);
    }));
  }

  // Independent of production's toLocaleDateString call: derives the
  // expected day/month/year from the raw UTC epoch via Date's UTC getters
  // and a hardcoded month table, rather than reusing the component's own
  // Intl options object. A wrong CHOICE of format options in production
  // (not just a wrong VALUE) would still be caught, since this never
  // constructs its expectation by calling toLocaleDateString itself.
  const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function assertBannerShowsUtcDate(epochMs: number) {
    const d = new Date(epochMs);
    const day = String(d.getUTCDate());
    const month = MONTH_ABBR[d.getUTCMonth()];
    const year = String(d.getUTCFullYear());
    const banner = screen.getByText(/resolution history only reaches back to/i);
    const text = banner.textContent ?? '';
    expect(text).toContain(day);
    expect(text).toContain(month);
    expect(text).toContain(year);
    expect(text).toContain('UTC');
  }

  it('names the date resolution history reaches back to, in UTC', async () => {
    stubTruncated('2026-06-14 00:00:00', true);
    renderReports();

    expect(await screen.findByText(/resolution history only reaches back to/i)).toBeInTheDocument();
    // '2026-06-14 00:00:00' is UTC (matching parseOldestCovered's handling of
    // SQLite CURRENT_TIMESTAMP). The banner now renders in UTC regardless of
    // the runner's local timezone, so the expected date is stable rather
    // than derived from the runner's own clock.
    assertBannerShowsUtcDate(Date.parse('2026-06-14T00:00:00Z'));
  });

  // The test above lands exactly on midnight UTC, which only a negative
  // runner offset (west of UTC) shifts to the previous day -- a positive
  // offset (east of UTC) leaves it alone. That made the `timeZone: 'UTC'`
  // guard pass silently under TZ=UTC and every east-of-UTC zone, including
  // conventional CI. These two fixtures straddle midnight UTC in both
  // directions and assert the same UTC calendar date, so dropping the
  // explicit zone is caught regardless of which side of UTC the runner sits
  // on (the runner's own zone, offset exactly 0, still can't shift anything --
  // that's arithmetic, not a coverage gap).
  it('names the date resolution history reaches back to, in UTC, shortly after midnight', async () => {
    stubTruncated('2026-06-14 00:30:00', true);
    renderReports();

    expect(await screen.findByText(/resolution history only reaches back to/i)).toBeInTheDocument();
    assertBannerShowsUtcDate(Date.parse('2026-06-14T00:30:00Z'));
  });

  it('names the date resolution history reaches back to, in UTC, shortly before midnight', async () => {
    stubTruncated('2026-06-14 23:30:00', true);
    renderReports();

    expect(await screen.findByText(/resolution history only reaches back to/i)).toBeInTheDocument();
    assertBannerShowsUtcDate(Date.parse('2026-06-14T23:30:00Z'));
  });

  it('shows the more restrictive of two differently-truncated sources', async () => {
    // labels can see back to 2026-01-01 -- if the derivation regressed to
    // Math.min, the banner would show this earlier, falsely-reassuring
    // date. decisions only reaches 2026-06-14, the real reported boundary,
    // and Math.max must pick it.
    const labelsOldestCovered = Date.UTC(2026, 0, 1) / 1000;
    stubTruncatedBoth(
      { oldestCoveredUnixSeconds: labelsOldestCovered, truncated: true },
      { oldestCovered: '2026-06-14 00:00:00', truncated: true }
    );
    renderReports();

    expect(await screen.findByText(/resolution history only reaches back to/i)).toBeInTheDocument();
    assertBannerShowsUtcDate(Date.parse('2026-06-14T00:00:00Z'));

    const banner = screen.getByText(/resolution history only reaches back to/i);
    expect(banner.textContent ?? '').not.toContain('Jan');
  });

  it('shows no truncation banner when the window covers everything', async () => {
    stubTruncated('2026-06-14 00:00:00', false);
    renderReports();

    await screen.findByText(REPORTED_NPUB);
    expect(screen.queryByText(/resolution history only reaches back to/i)).not.toBeInTheDocument();
  });

  it('shows no truncation banner for a capped LABELS read while hide-resolved is off', async () => {
    // The labels window is only relevant when resolvedTargets is actually being
    // subtracted, which is what hide-resolved controls. Decisions is left
    // untruncated here so this measures the labels half on its own. No cold
    // error, so the switch is reachable directly.
    stubTruncatedBoth(
      { oldestCoveredUnixSeconds: Date.UTC(2026, 5, 14) / 1000, truncated: true },
      { oldestCovered: '2026-06-14 00:00:00', truncated: false }
    );
    const user = userEvent.setup();
    renderReports();

    expect(await screen.findByText(/resolution history only reaches back to/i)).toBeInTheDocument();

    await user.click(await screen.findByRole('switch', { name: /hide resolved/i }));

    expect(screen.queryByText(/resolution history only reaches back to/i)).not.toBeInTheDocument();
  });

  it('still shows the truncation banner for a capped DECISIONS read while hide-resolved is off', async () => {
    // The mirror image, and the same reasoning as decisions' gatesAlways: the
    // decisions read also feeds pendingReviewTargets, which is applied on every
    // path, so its cap stays load-bearing after hide-resolved goes off.
    stubTruncated('2026-06-14 00:00:00', true);
    const user = userEvent.setup();
    renderReports();

    expect(await screen.findByText(/resolution history only reaches back to/i)).toBeInTheDocument();

    await user.click(await screen.findByRole('switch', { name: /hide resolved/i }));

    expect(screen.getByText(/resolution history only reaches back to/i)).toBeInTheDocument();
  });

  it('states the truncated window in the pending-review view, which is built entirely from that read', async () => {
    // The worst case for hiding this banner. pendingReviewTargets comes 100%
    // from the capped decisions read, and switching Pending review on
    // force-clears hideResolved -- so gating the banner on the resolved filter
    // switched it off in the one view with no other source to fall back on. An
    // auto_hidden row that ages out of the cap drops its target from the CSAM
    // queue with nothing on screen saying the window has a floor.
    stubFetch({ labels: 'empty', bannedPubkeys: 'empty', bannedEvents: 'empty', decisions: 'empty' });
    const healthy = globalThis.fetch as unknown as typeof fetch;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes('/api/decisions')) {
        return jsonResponse({
          success: true,
          // An auto-hidden, not-yet-confirmed target: what puts a row in the
          // pending-review queue and makes its toggle appear at all.
          decisions: [{
            id: 1,
            target_type: 'pubkey',
            target_id: REPORTED_PUBKEY,
            action: 'auto_hidden',
            created_at: '2026-06-20 00:00:00',
          }],
          truncated: true,
          oldest_covered: '2026-06-14 00:00:00',
        });
      }
      return healthy(input, init);
    }));

    const user = userEvent.setup();
    renderReports();

    await user.click(await screen.findByRole('switch', { name: /pending review/i }));

    // Precondition: this really is the pending-review view, not the default one.
    expect(screen.getByRole('switch', { name: /hide resolved/i })).toBeDisabled();
    expect(screen.getByText(/resolution history only reaches back to/i)).toBeInTheDocument();
  });

  it('shows no truncation banner against a worker that predates the field', async () => {
    // Pages and the worker deploy separately; a missing field is not truncation.
    stubFetch({ labels: 'empty', bannedPubkeys: 'empty', bannedEvents: 'empty', decisions: 'empty' });
    renderReports();

    await screen.findByText(REPORTED_NPUB);
    expect(screen.queryByText(/resolution history only reaches back to/i)).not.toBeInTheDocument();
  });
});

describe('one retry absorbs a single transient failure (#221)', () => {
  // `retry: 1` (up from `retry: false`) is the other half of the cold-error
  // policy: blocking on four sources is only payable because a single
  // transient failure no longer costs a whole 15s poll cycle. Without this
  // test, reverting all four queries to `retry: false` leaves the suite
  // green -- every other test either never fails a source or fails it
  // permanently, so no assertion can tell one attempt from two.
  //
  // The recovery here can only come from the retry: `refetchInterval` is
  // 15s and this test settles in milliseconds.
  it('recovers a source that fails once, instead of blocking the queue', async () => {
    let decisionsAttempts = 0;
    stubFetch({ labels: 'empty', bannedPubkeys: 'empty', bannedEvents: 'empty', decisions: 'empty' });
    const healthy = globalThis.fetch as unknown as typeof fetch;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes('/api/decisions')) {
        decisionsAttempts += 1;
        if (decisionsAttempts === 1) {
          return jsonResponse({ success: false, error: 'cold start timeout' }, 500);
        }
      }
      return healthy(input, init);
    }));

    renderReports();

    expect(await screen.findByText(REPORTED_NPUB)).toBeInTheDocument();
    expect(screen.queryByText(/resolution state is unavailable/i)).not.toBeInTheDocument();
    expect(decisionsAttempts).toBeGreaterThan(1);
  });
});
