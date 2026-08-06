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
}

function stubFetch(state: SourceState) {
  const never = new Promise<Response>(() => {});
  const slow = new Set(state.slow ?? []);

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);

    if (url.includes('/api/reports')) {
      if (state.reports === 'error') return jsonResponse({ success: false, error: 'relay unreachable' }, 500);
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

  it('shows no truncation banner while hide-resolved is off', async () => {
    // The coverage window is only relevant when resolvedTargets is actually
    // being subtracted. No cold error here, so the switch is reachable directly.
    stubTruncated('2026-06-14 00:00:00', true);
    const user = userEvent.setup();
    renderReports();

    expect(await screen.findByText(/resolution history only reaches back to/i)).toBeInTheDocument();

    await user.click(await screen.findByRole('switch', { name: /hide resolved/i }));

    expect(screen.queryByText(/resolution history only reaches back to/i)).not.toBeInTheDocument();
  });

  it('shows no truncation banner against a worker that predates the field', async () => {
    // Pages and the worker deploy separately; a missing field is not truncation.
    stubFetch({ labels: 'empty', bannedPubkeys: 'empty', bannedEvents: 'empty', decisions: 'empty' });
    renderReports();

    await screen.findByText(REPORTED_NPUB);
    expect(screen.queryByText(/resolution history only reaches back to/i)).not.toBeInTheDocument();
  });
});
