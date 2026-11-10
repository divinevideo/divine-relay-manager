// ABOUTME: The Hide resolved toggle must obey the moderator, not resolution data.
// ABOUTME: Reproduces the reported "toggle does nothing until you reload" stutter, and pins
// ABOUTME: where items handled before a newer report go (#324): a counted section, or in place.

import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import TestApp from '@/test/TestApp';
import { EMPTY_RESOLVED_PAGE } from '@/test/resolvedHistory';
import { Reports } from './Reports';

const RELAY_URL = 'wss://relay.example';
const TARGET = 'c'.repeat(64);

vi.mock('@/components/ReportDetail', () => ({
  ReportDetail: ({ report, handledBefore, queueHandled }: {
    report: { id: string } | null;
    handledBefore?: { history: unknown; via: string };
    queueHandled?: boolean;
  }) => (
    <div
      data-testid="detail"
      data-report-id={report?.id ?? ''}
      data-handled-before={JSON.stringify(handledBefore?.history ?? null)}
      data-handled-before-via={handledBefore?.via ?? ''}
      data-queue-handled={String(queueHandled ?? false)}
    />
  ),
}));

const REPORT = {
  id: 'a'.repeat(64),
  pubkey: 'b'.repeat(64),
  created_at: 1751000000,
  kind: 1984,
  tags: [
    ['e', TARGET, 'spam'],
    ['p', 'd'.repeat(64), 'spam'],
    ['L', 'social.nos.ontology'],
    ['l', 'NS-spam', 'social.nos.ontology'],
  ],
  content: 'reported',
  sig: 'e'.repeat(128),
};

// A second, always-resolved target. Its presence is what makes the toggle
// observable: with Hide resolved ON it must be absent, with it OFF present.
const OTHER = '9'.repeat(64);
// A separate auto-hidden target, present so the Pending review control renders.
// That control counts the rows its view will list, so the target needs a
// report in the feed. It is never listed in the default view, so it cannot
// affect the other assertions. The pending-review view does list it, so its
// category is neither Spam nor Harassment: a row badge reading "Spam" there
// would be a second match for the Spam chip the category tests look for.
const AUTOHIDDEN = '7'.repeat(64);
const AUTOHIDDEN_REPORT = {
  ...REPORT,
  id: '6'.repeat(64),
  created_at: 1751000020,
  tags: [
    ['e', AUTOHIDDEN, 'spam'],
    ['p', '5'.repeat(64), 'spam'],
    ['L', 'social.nos.ontology'],
    ['l', 'NS-violence', 'social.nos.ontology'],
  ],
};
const RESOLVED_REPORT = {
  ...REPORT,
  id: 'f'.repeat(64),
  created_at: 1751000050,
  // A second category, so "a category is selected" is distinguishable from
  // "no category is selected". With one category the chip reads the same
  // either way and an assertion on it proves nothing.
  tags: [
    ['e', OTHER, 'spam'],
    ['p', '8'.repeat(64), 'spam'],
    ['L', 'social.nos.ontology'],
    ['l', 'NS-harassment', 'social.nos.ontology'],
  ],
};

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** `resolvedNow` flips the primary target from unresolved to resolved mid-test. */
function stubFetch(resolvedNow: () => boolean) {
  const calls = { resolutionState: 0 };
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('/api/reports/resolved')) return jsonResponse(EMPTY_RESOLVED_PAGE);
    if (url.includes('/api/reports')) {
      return jsonResponse({ success: true, events: [REPORT, RESOLVED_REPORT, AUTOHIDDEN_REPORT] });
    }
    if (url.includes('/api/resolution-label-targets')) {
      return jsonResponse({ success: true, targets: [], truncated: false, oldest_covered: null });
    }
    if (url.includes('/api/resolution-state')) {
      calls.resolutionState += 1;
      const resolved = [{ target_type: 'event', target_id: OTHER }];
      if (resolvedNow()) resolved.push({ target_type: 'event', target_id: TARGET });
      return jsonResponse({
        success: true,
        resolved,
        states: [{ target_type: 'event', target_id: AUTOHIDDEN, action: 'auto_hidden' }],
      });
    }
    if (url.includes('/api/relay-rpc')) return jsonResponse({ success: true, result: [] });
    return jsonResponse({ success: true });
  }));
  return calls;
}

let consoleError: MockInstance;
beforeEach(() => {
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  consoleError.mockRestore();
});

describe('Hide resolved obeys the moderator', () => {
  it('stays on after the selected report becomes resolved', async () => {
    // The reported sequence: a moderator has Hide resolved ON (the default),
    // opens a report, actions it, and the toggle turns itself off -- then
    // refuses to turn back on until the page is reloaded.
    let resolved = false;
    const calls = stubFetch(() => resolved);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, retryDelay: 0 } },
    });
    const user = userEvent.setup();

    render(
      <TestApp queryClient={queryClient}>
        <Reports relayUrl={RELAY_URL} />
      </TestApp>
    );

    const toggle = await screen.findByRole('switch', { name: /hide resolved/i });
    expect(toggle).toBeChecked();
    const before = calls.resolutionState;

    // Open the still-unresolved report.
    const row = await screen.findByText(/1 report$/);
    await user.click(row);

    // It gets actioned. Every action handler invalidates the resolution
    // sources, which is what makes the new resolved state visible.
    resolved = true;
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['resolution-state'] });
    });

    // Wait for the NEW resolution state to have actually landed, then flush
    // effects. Without this the assertion below passes on its first check --
    // before the effect that moves the toggle has had a chance to run -- and
    // proves nothing.
    await waitFor(() => expect(calls.resolutionState).toBeGreaterThan(before));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

    // The moderator never touched the toggle. It must not have moved.
    expect(screen.getByRole('switch', { name: /hide resolved/i })).toBeChecked();
  });

  it('follows the moderator in both directions with a resolved report open', async () => {
    // The visible symptom was that clicking the toggle appeared to do nothing,
    // because an effect immediately put it back. With a resolved report open,
    // the toggle must still go exactly where the moderator puts it.
    let resolved = false;
    const calls = stubFetch(() => resolved);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, retryDelay: 0 } },
    });
    const user = userEvent.setup();

    render(
      <TestApp queryClient={queryClient}>
        <Reports relayUrl={RELAY_URL} />
      </TestApp>
    );

    const row = await screen.findByText(/1 report$/);
    await user.click(row);

    const before = calls.resolutionState;
    resolved = true;
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['resolution-state'] });
    });
    await waitFor(() => expect(calls.resolutionState).toBeGreaterThan(before));

    const toggle = await screen.findByRole('switch', { name: /hide resolved/i });

    // Off, because the moderator asked.
    await user.click(toggle);
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(screen.getByRole('switch', { name: /hide resolved/i })).not.toBeChecked();

    // Back on, and it stays there.
    await user.click(screen.getByRole('switch', { name: /hide resolved/i }));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(screen.getByRole('switch', { name: /hide resolved/i })).toBeChecked();
  });

  // The path that had no coverage at all before this change. Arriving at
  // /reports/<id> directly -- a shared link, or a reload after following a
  // Zendesk deep link -- must still unhide, or the report's pane sits open
  // while its row is filtered out of the list beside it.
  it('unhides for a report reached directly by its /reports/:id URL', async () => {
    const calls = stubFetch(() => true); // the target is already resolved
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, retryDelay: 0 } },
    });

    render(
      <TestApp queryClient={queryClient}>
        <Reports relayUrl={RELAY_URL} selectedReportId={REPORT.id} />
      </TestApp>
    );

    await waitFor(() => expect(calls.resolutionState).toBeGreaterThan(0));

    await waitFor(() => {
      expect(screen.getByRole('switch', { name: /hide resolved/i })).not.toBeChecked();
    });
  });

  // Raised by an independent review of the first fix: the deep-link flag is set
  // for the whole life of that selection, not just the load race the effect is
  // documented to cover. So the original bug survives for anyone arriving from a
  // Zendesk link -- the primary entry path -- because actioning the open report
  // re-triggers the effect and the toggle stops obeying again.
  it('keeps obeying the moderator after a DEEP-LINKED report is actioned', async () => {
    let resolved = false;
    const calls = stubFetch(() => resolved);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, retryDelay: 0 } },
    });
    const user = userEvent.setup();

    // Arrive by direct report URL, exactly as a Zendesk link lands.
    render(
      <TestApp queryClient={queryClient}>
        <Reports relayUrl={RELAY_URL} selectedReportId={REPORT.id} />
      </TestApp>
    );

    const toggle = await screen.findByRole('switch', { name: /hide resolved/i });
    expect(toggle).toBeChecked();

    // The moderator actions it. The pane stays open: handleActionComplete
    // invalidates resolution state without dismissing the selection.
    const before = calls.resolutionState;
    resolved = true;
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['resolution-state'] });
    });
    await waitFor(() => expect(calls.resolutionState).toBeGreaterThan(before));

    // The arrival courtesy fires once: the now-resolved open report unhides.
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: /hide resolved/i })).not.toBeChecked()
    );

    // The moderator puts Hide resolved back on. It must stay on -- this is
    // where the original bug reappeared for deep-linked reports.
    await user.click(screen.getByRole('switch', { name: /hide resolved/i }));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(screen.getByRole('switch', { name: /hide resolved/i })).toBeChecked();
  });

  // Why the revocation lives in the toggle handler rather than being a one-shot
  // inside the effect: a moderator can state a preference BEFORE the target
  // becomes resolved. A one-shot would still be armed at that point and would
  // override them. Touching the toggle has to spend the arrival courtesy.
  it('respects a preference stated before the deep-linked report resolves', async () => {
    let resolved = false;
    const calls = stubFetch(() => resolved);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, retryDelay: 0 } },
    });
    const user = userEvent.setup();

    render(
      <TestApp queryClient={queryClient}>
        <Reports relayUrl={RELAY_URL} selectedReportId={REPORT.id} />
      </TestApp>
    );

    // Target is not resolved yet, so the arrival courtesy has not fired.
    const toggle = await screen.findByRole('switch', { name: /hide resolved/i });
    expect(toggle).toBeChecked();

    // The moderator states a preference: off, then deliberately back on.
    await user.click(screen.getByRole('switch', { name: /hide resolved/i }));
    await user.click(screen.getByRole('switch', { name: /hide resolved/i }));
    expect(screen.getByRole('switch', { name: /hide resolved/i })).toBeChecked();

    // Only now does the open report become resolved.
    const before = calls.resolutionState;
    resolved = true;
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['resolution-state'] });
    });
    await waitFor(() => expect(calls.resolutionState).toBeGreaterThan(before));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

    // Their stated preference stands.
    expect(screen.getByRole('switch', { name: /hide resolved/i })).toBeChecked();
  });
});

describe('Pending review gives back what it borrows', () => {
  // Turning Pending review on forces Hide resolved off and clears the category
  // filter, because that view is its own mode. Turning it back off never
  // restored either, so a moderator's settings were silently spent: they came
  // back to a queue full of resolved reports they had asked to hide.
  it('restores Hide resolved when the moderator leaves the pending-review view', async () => {
    stubFetch(() => false);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, retryDelay: 0 } },
    });
    const user = userEvent.setup();

    render(
      <TestApp queryClient={queryClient}>
        <Reports relayUrl={RELAY_URL} />
      </TestApp>
    );

    const hide = await screen.findByRole('switch', { name: /hide resolved/i });
    expect(hide).toBeChecked();

    const pending = await screen.findByRole('switch', { name: /pending review/i });
    await user.click(pending);
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(screen.getByRole('switch', { name: /hide resolved/i })).not.toBeChecked();

    // Leaving the mode hands the setting back.
    await user.click(screen.getByRole('switch', { name: /pending review/i }));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(screen.getByRole('switch', { name: /hide resolved/i })).toBeChecked();
  });

  it('says why Hide resolved is unavailable instead of just dimming it', async () => {
    // A disabled switch at 50% opacity reads as a live control that ignores
    // clicks -- which is one of the shapes the "toggles do nothing" report took.
    stubFetch(() => false);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, retryDelay: 0 } },
    });
    const user = userEvent.setup();

    render(
      <TestApp queryClient={queryClient}>
        <Reports relayUrl={RELAY_URL} />
      </TestApp>
    );

    await user.click(await screen.findByRole('switch', { name: /pending review/i }));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

    expect(screen.getByRole('switch', { name: /hide resolved/i })).toBeDisabled();
    expect(screen.getByText(/unavailable while pending review/i)).toBeInTheDocument();
  });

  // The other half of the same hand-back: a category chosen on the normal
  // queue is borrowed by the view, so leaving must return it. The in-view case
  // below cannot catch a restore that silently stopped restoring.
  it('hands back a category chosen before entering the pending-review view', async () => {
    stubFetch(() => false);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, retryDelay: 0 } },
    });
    const user = userEvent.setup();

    render(
      <TestApp queryClient={queryClient}>
        <Reports relayUrl={RELAY_URL} />
      </TestApp>
    );

    // Choose Harassment on the normal queue. The only report in the normal
    // view is Spam, so selecting Harassment filters it out and the Spam chip
    // goes away with the rest of the unselected chips.
    await user.click(await screen.findByText('Harassment'));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(screen.queryByText('Spam')).not.toBeInTheDocument();

    // Entering the mode clears the filter, so every chip is back.
    await user.click(await screen.findByRole('switch', { name: /pending review/i }));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(await screen.findByText('Spam')).toBeInTheDocument();

    // Leaving hands Harassment back: the chips disappear again and Spam is
    // filtered out, exactly as before entering. Without the restore this
    // assertion fails on the Spam chip.
    await user.click(screen.getByRole('switch', { name: /pending review/i }));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(screen.queryByText('Spam')).not.toBeInTheDocument();
    expect(screen.getByText('Harassment')).toBeInTheDocument();
  });

  // Restoring must not itself discard a choice. The category chips stay live
  // inside the pending-review view, so a category picked THERE is a deliberate
  // choice too -- handing back the pre-entry value would overwrite it with the
  // same silent-discard behaviour this commit exists to remove.
  it('keeps a category chosen inside the pending-review view', async () => {
    stubFetch(() => false);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, retryDelay: 0 } },
    });
    const user = userEvent.setup();

    render(
      <TestApp queryClient={queryClient}>
        <Reports relayUrl={RELAY_URL} />
      </TestApp>
    );

    await user.click(await screen.findByRole('switch', { name: /pending review/i }));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

    // Pick a category from inside the mode.
    await user.click(await screen.findByText('Spam'));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

    // With Spam selected, the other category's chip is gone -- that absence is
    // what distinguishes "selected" from "nothing selected".
    expect(screen.queryByText('Harassment')).not.toBeInTheDocument();

    // Leaving must not undo the choice. Asserted by the absence of the other
    // category's chip: if the filter had been reset, that chip would be back.
    // ("Spam" itself is ambiguous once the list re-renders, since report rows
    // carry category badges of their own.)
    await user.click(screen.getByRole('switch', { name: /pending review/i }));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(screen.queryByText('Harassment')).not.toBeInTheDocument();
  });
});

// #324: a report that came after its target was handled is not answered by
// that handling. With Hide resolved on it leaves the main list for a counted,
// collapsed section below it; with Hide resolved off it stays in place. Either
// way its row says "Handled before".
describe('items handled before a newer report', () => {
  const T = 1751000000;
  const MODERATOR = '1'.repeat(64);
  const HANDLED_BEFORE_A = 'a1'.repeat(32);
  const HANDLED_BEFORE_B = 'b2'.repeat(32);
  const NEVER_HANDLED = 'c3'.repeat(32);
  const HANDLED = 'd4'.repeat(32);
  const profileReport = (id: string, pubkey: string, created_at: number) => ({
    id,
    pubkey: 'e'.repeat(64),
    created_at,
    kind: 1984,
    tags: [['p', pubkey, 'spam']],
    content: 'reported',
    sig: 'e'.repeat(128),
  });
  const handled = (target_id: string, at: number) =>
    ({ target_type: 'pubkey', target_id, action: 'reviewed', moderator_pubkey: MODERATOR, at });

  // A has two reports, one from before its handling, so the default sort (most
  // reports first) puts it ahead of B though B is first in the feed.
  const A_OLD = profileReport('01'.repeat(32), HANDLED_BEFORE_A, T - 100);
  const A_NEW = profileReport('02'.repeat(32), HANDLED_BEFORE_A, T + 10);
  const B_NEW = profileReport('03'.repeat(32), HANDLED_BEFORE_B, T + 20);
  const C_NEW = profileReport('04'.repeat(32), NEVER_HANDLED, T);
  const D_OLD = profileReport('05'.repeat(32), HANDLED, T);
  const A_HISTORY = [{ action: 'reviewed', at: T - 50 }];

  function stubDated({
    events,
    handlingRows,
    reportArrivals,
    bannedPubkeys = [],
    labelTargets = [],
    feedFails = false,
    lookupEvents = [],
  }: {
    events: unknown[];
    // undefined: a worker from before #324, which sends no handling rows.
    handlingRows?: unknown[];
    reportArrivals?: Record<string, number>;
    // What the relay's listbannedpubkeys answers.
    bannedPubkeys?: string[];
    // Dated resolution label targets.
    labelTargets?: { type: 'event' | 'pubkey'; value: string; at: number }[];
    // The needs-attention feed answers 502, as in a relay outage.
    feedFails?: boolean;
    // What a deep link's targeted lookup (?event= / ?pubkey=) finds.
    lookupEvents?: unknown[];
  }) {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes('/api/reports/resolved')) return jsonResponse(EMPTY_RESOLVED_PAGE);
      if (url.includes('/api/reports?event=') || url.includes('/api/reports?pubkey=')) {
        return jsonResponse({ success: true, events: lookupEvents });
      }
      if (url.includes('/api/reports')) {
        if (feedFails) {
          return new Response(JSON.stringify({ success: false, error: 'Relay query timed out before EOSE' }), {
            status: 502,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return jsonResponse({ success: true, events, ...(reportArrivals ? { report_arrivals: reportArrivals } : {}) });
      }
      if (url.includes('/api/resolution-label-targets')) {
        return jsonResponse({ success: true, targets: labelTargets, truncated: false, oldest_covered: null });
      }
      if (url.includes('/api/resolution-state')) {
        return jsonResponse({
          success: true,
          resolved: [],
          states: [],
          ...(handlingRows ? { handling_rows: handlingRows } : {}),
        });
      }
      if (url.includes('/api/relay-rpc')) {
        const listsPubkeys = String(init?.body ?? '').includes('listbannedpubkeys');
        return jsonResponse({ success: true, result: listsPubkeys ? bannedPubkeys.map(pubkey => ({ pubkey })) : [] });
      }
      return jsonResponse({ success: true });
    }));
  }

  const row = (key: string) => document.querySelector(`[data-row-key="${key}"]`) as HTMLElement | null;
  const section = () => screen.queryByRole('button', { name: /already handled/ });

  function renderQueue(selectedReportId?: string) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });
    render(<TestApp queryClient={queryClient}><Reports relayUrl={RELAY_URL} selectedReportId={selectedReportId} /></TestApp>);
  }

  const FOUR_TARGETS = {
    events: [B_NEW, A_OLD, A_NEW, C_NEW, D_OLD],
    handlingRows: [handled(HANDLED_BEFORE_A, T - 50), handled(HANDLED_BEFORE_B, T - 50), handled(HANDLED, T + 100)],
  };

  it('counts them below the main list, collapsed, and lists them with the tag when opened', async () => {
    stubDated(FOUR_TARGETS);
    const user = userEvent.setup();
    renderQueue();

    const header = await screen.findByRole('button', { name: '2 new on items already handled' });
    expect(header).toHaveAttribute('aria-expanded', 'false');
    expect(row(`pubkey:${NEVER_HANDLED}`)).not.toBeNull();
    expect(within(row(`pubkey:${NEVER_HANDLED}`)!).queryByText('Handled before')).not.toBeInTheDocument();
    expect(screen.getByText('1 pending')).toBeInTheDocument();
    expect(row(`pubkey:${HANDLED_BEFORE_A}`)).toBeNull();
    expect(row(`pubkey:${HANDLED_BEFORE_B}`)).toBeNull();

    await user.click(header);
    expect(header).toHaveAttribute('aria-expanded', 'true');
    const a = row(`pubkey:${HANDLED_BEFORE_A}`)!;
    const b = row(`pubkey:${HANDLED_BEFORE_B}`)!;
    expect(within(a).getByText('Handled before')).toBeInTheDocument();
    expect(within(b).getByText('Handled before')).toBeInTheDocument();
    // In the chosen sort, and below the main list.
    expect(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(row(`pubkey:${NEVER_HANDLED}`)!.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // A target whose every report predates its handling is in neither place.
    expect(row(`pubkey:${HANDLED}`)).toBeNull();
  });

  it('says "an item" for one', async () => {
    stubDated({ ...FOUR_TARGETS, events: [A_OLD, A_NEW, C_NEW, D_OLD] });
    renderQueue();

    expect(await screen.findByRole('button', { name: '1 new on an item already handled' })).toBeInTheDocument();
  });

  it('leaves them in place, tagged, with Hide resolved off', async () => {
    stubDated(FOUR_TARGETS);
    const user = userEvent.setup();
    renderQueue();

    await screen.findByRole('button', { name: /already handled/ });
    await user.click(screen.getByRole('switch', { name: /hide resolved/i }));

    await waitFor(() => expect(row(`pubkey:${HANDLED}`)).not.toBeNull());
    expect(section()).not.toBeInTheDocument();
    expect(within(row(`pubkey:${HANDLED_BEFORE_A}`)!).getByText('Handled before')).toBeInTheDocument();
    expect(within(row(`pubkey:${HANDLED_BEFORE_B}`)!).getByText('Handled before')).toBeInTheDocument();
    expect(within(row(`pubkey:${NEVER_HANDLED}`)!).queryByText('Handled before')).not.toBeInTheDocument();
    expect(within(row(`pubkey:${HANDLED}`)!).queryByText('Handled before')).not.toBeInTheDocument();
  });

  it('has no section against a worker that sends no handling dates', async () => {
    stubDated({ events: FOUR_TARGETS.events });
    renderQueue();

    await waitFor(() => expect(row(`pubkey:${HANDLED_BEFORE_A}`)).not.toBeNull());
    expect(section()).not.toBeInTheDocument();
    expect(screen.queryByText('Handled before')).not.toBeInTheDocument();
  });

  // The All tab dates each report by itself: its arrival by id, else its
  // created_at. Only the one report that came after the handling is set apart.
  it('sets apart, in the All tab, only the reports that came after the handling', async () => {
    const byArrival = profileReport('11'.repeat(32), HANDLED_BEFORE_A, T + 5);   // stamped after, arrived before
    const byCreatedAt = profileReport('12'.repeat(32), HANDLED_BEFORE_A, T - 100); // before the handling
    const newer = profileReport('13'.repeat(32), HANDLED_BEFORE_A, T + 10);        // after it
    stubDated({
      events: [byArrival, byCreatedAt, newer, C_NEW],
      reportArrivals: { [byArrival.id]: T - 100 },
      handlingRows: [handled(HANDLED_BEFORE_A, T - 50)],
    });
    const user = userEvent.setup();
    renderQueue();

    await screen.findByRole('button', { name: /already handled/ });
    await user.click(screen.getByRole('tab', { name: /^All/ }));
    const header = await screen.findByRole('button', { name: '1 new on an item already handled' });
    expect(row(C_NEW.id)).not.toBeNull();
    expect(row(newer.id)).toBeNull();

    await user.click(header);
    expect(within(row(newer.id)!).getByText('Handled before')).toBeInTheDocument();
    expect(row(byArrival.id)).toBeNull();
    expect(row(byCreatedAt.id)).toBeNull();

    // The pane reads each report as its row does: this one came after the
    // handling, the older one on the same account did not.
    await user.click(row(newer.id)!);
    await waitFor(() =>
      expect(screen.getByTestId('detail')).toHaveAttribute('data-handled-before', JSON.stringify(A_HISTORY)));
    await user.click(screen.getByRole('switch', { name: /hide resolved/i }));
    await waitFor(() => expect(row(byCreatedAt.id)).not.toBeNull());
    expect(within(row(byCreatedAt.id)!).queryByText('Handled before')).not.toBeInTheDocument();
    await user.click(row(byCreatedAt.id)!);
    await waitFor(() => expect(screen.getByTestId('detail')).toHaveAttribute('data-handled-before', 'null'));
  });

  it("hands the pane the history of the handling the item's report came after", async () => {
    stubDated(FOUR_TARGETS);
    const user = userEvent.setup();
    renderQueue();

    await user.click(await screen.findByRole('button', { name: /already handled/ }));
    await user.click(row(`pubkey:${HANDLED_BEFORE_A}`)!);
    await waitFor(() =>
      expect(screen.getByTestId('detail')).toHaveAttribute('data-handled-before', JSON.stringify(A_HISTORY)));

    await user.click(row(`pubkey:${NEVER_HANDLED}`)!);
    await waitFor(() => expect(screen.getByTestId('detail')).toHaveAttribute('data-handled-before', 'null'));
  });

  // The pane reads the report it opened, in both tabs, so a report that came
  // before the handling never shows the Handled before card, whichever tab the
  // moderator reached it in (spec anti-goal 3).
  it('hands the pane no history for a deep-linked report from before the handling, in the grouped tab', async () => {
    stubDated(FOUR_TARGETS);
    renderQueue(A_OLD.id);

    // The dated rule has landed: the section counts A.
    await screen.findByRole('button', { name: '2 new on items already handled' });
    await waitFor(() => expect(screen.getByTestId('detail')).toHaveAttribute('data-report-id', A_OLD.id));
    expect(screen.getByTestId('detail')).toHaveAttribute('data-handled-before', 'null');
  });

  // A reporter's clock can stamp an old report in the future. A group row
  // opens the report that arrived last, the one its tag is about, not the one
  // with the largest created_at.
  it("opens a group's newest report by arrival, not by created_at", async () => {
    const futureStamped = profileReport('14'.repeat(32), HANDLED_BEFORE_A, T + 1000); // arrived before the handling
    const newer = profileReport('15'.repeat(32), HANDLED_BEFORE_A, T + 10);           // after it
    stubDated({
      events: [futureStamped, newer, C_NEW],
      reportArrivals: { [futureStamped.id]: T - 100 },
      handlingRows: [handled(HANDLED_BEFORE_A, T - 50)],
    });
    const user = userEvent.setup();
    renderQueue();

    await user.click(await screen.findByRole('button', { name: '1 new on an item already handled' }));
    await user.click(row(`pubkey:${HANDLED_BEFORE_A}`)!);
    await waitFor(() => expect(screen.getByTestId('detail')).toHaveAttribute('data-report-id', newer.id));
    expect(screen.getByTestId('detail')).toHaveAttribute('data-handled-before', JSON.stringify(A_HISTORY));
  });

  // A target handled only by a resolution label has no handling row, so the
  // pane's decision log knows nothing of it. The queue tells the pane, so it
  // can offer Reopen, which cancels the label.
  it('tells the pane its target is handled when only a resolution label handled it', async () => {
    stubDated({
      events: [A_OLD, A_NEW, C_NEW],
      handlingRows: [],
      labelTargets: [{ type: 'pubkey', value: HANDLED_BEFORE_A, at: T - 50 }],
    });
    const user = userEvent.setup();
    renderQueue();

    await user.click(await screen.findByRole('button', { name: '1 new on an item already handled' }));
    await user.click(row(`pubkey:${HANDLED_BEFORE_A}`)!);
    await waitFor(() => expect(screen.getByTestId('detail')).toHaveAttribute('data-queue-handled', 'true'));
    expect(screen.getByTestId('detail')).toHaveAttribute(
      'data-handled-before', JSON.stringify([{ action: 'resolution_label', at: T - 50 }]));

    await user.click(row(`pubkey:${NEVER_HANDLED}`)!);
    await waitFor(() => expect(screen.getByTestId('detail')).toHaveAttribute('data-queue-handled', 'false'));
  });

  // Spec decision 6: with Hide resolved on, the count always shows, even at
  // none, so a moderator can tell "none" from "not shown".
  it('shows the count at none, with nothing to open', async () => {
    stubDated({ events: [C_NEW, D_OLD], handlingRows: [handled(HANDLED, T + 100)] });
    renderQueue();

    const header = await screen.findByRole('button', { name: '0 new on items already handled' });
    expect(header).toBeDisabled();
    expect(header).toHaveAttribute('aria-expanded', 'false');
  });

  // Spec decisions 3 and 5: a handled-before item on a banned account, or a
  // post handled before through its banned author, says since when, and sorts
  // below the other handled-before items, each group in the chosen sort.
  describe('on banned accounts', () => {
    const BANNED = 'e5'.repeat(32);
    const AUTHOR = 'f6'.repeat(32);
    const POST = '7a'.repeat(32);
    const day = (at: number) => new Date(at * 1000).toLocaleDateString();
    const ban = (target_id: string, at: number) =>
      ({ target_type: 'pubkey', target_id, action: 'ban_user', moderator_pubkey: MODERATOR, at });
    // Three reports, so the default sort (most reports first) would list it first.
    const bannedReports = [1, 2, 3].map(n => profileReport(`2${n}`.repeat(32), BANNED, T + n));
    const POST_REPORT = {
      id: '31'.repeat(32),
      pubkey: 'e'.repeat(64),
      created_at: T + 30,
      kind: 1984,
      tags: [['e', POST, 'spam'], ['p', AUTHOR, 'spam']],
      content: 'reported',
      sig: 'e'.repeat(128),
    };
    const fixture = {
      events: [...bannedReports, POST_REPORT, A_OLD, A_NEW, C_NEW],
      handlingRows: [handled(HANDLED_BEFORE_A, T - 50), ban(BANNED, T - 50), ban(AUTHOR, T - 40)],
      bannedPubkeys: [BANNED, AUTHOR],
    };

    it('labels them, and lists them last in the section', async () => {
      stubDated(fixture);
      const user = userEvent.setup();
      renderQueue();

      await user.click(await screen.findByRole('button', { name: '3 new on items already handled' }));
      const a = row(`pubkey:${HANDLED_BEFORE_A}`)!;
      const banned = row(`pubkey:${BANNED}`)!;
      const post = row(`event:${POST}`)!;
      expect(within(banned).getByText(`Banned since ${day(T - 50)}`)).toBeInTheDocument();
      expect(within(banned).getByText('Handled before')).toBeInTheDocument();
      expect(within(post).getByText(`Author banned since ${day(T - 40)}`)).toBeInTheDocument();
      expect(within(post).getByText('Handled before')).toBeInTheDocument();
      expect(within(a).queryByText(/banned/i)).not.toBeInTheDocument();
      // A first, then the banned two in the chosen sort (three reports, then one).
      expect(a.compareDocumentPosition(banned) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(banned.compareDocumentPosition(post) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('lists them last in place with Hide resolved off', async () => {
      stubDated(fixture);
      const user = userEvent.setup();
      renderQueue();

      await screen.findByRole('button', { name: /already handled/ });
      await user.click(screen.getByRole('switch', { name: /hide resolved/i }));
      await waitFor(() => expect(row(`pubkey:${BANNED}`)).not.toBeNull());
      const keys = [...document.querySelectorAll('[data-row-key]')].map(el => el.getAttribute('data-row-key'));
      // The history view sorts newest first, which would put the post (T+30)
      // and the account (T+3) above A (T+10) and C (T): they come last anyway.
      expect(keys.slice(-2)).toEqual([`event:${POST}`, `pubkey:${BANNED}`]);
      expect(within(row(`pubkey:${BANNED}`)!).getByText(`Banned since ${day(T - 50)}`)).toBeInTheDocument();
    });

    it('labels a banned report in the All tab', async () => {
      stubDated(fixture);
      const user = userEvent.setup();
      renderQueue();

      await screen.findByRole('button', { name: /already handled/ });
      await user.click(screen.getByRole('tab', { name: /^All/ }));
      await user.click(await screen.findByRole('button', { name: '5 new on items already handled' }));
      expect(within(row(POST_REPORT.id)!).getByText(`Author banned since ${day(T - 40)}`)).toBeInTheDocument();
      expect(within(row(bannedReports[0].id)!).getByText(`Banned since ${day(T - 50)}`)).toBeInTheDocument();
      expect(within(row(A_NEW.id)!).queryByText(/banned/i)).not.toBeInTheDocument();
      // The banned ones last.
      const keys = [...document.querySelectorAll('#handled-before-items [data-row-key]')].map(el => el.getAttribute('data-row-key'));
      expect(keys[0]).toBe(A_NEW.id);
    });

    // With the feed failed cold, the deep link's own lookup is all the screen
    // has. The post's author still comes from it, so the pane keeps the
    // banned author's history.
    it("keeps the banned author's history for a deep-linked post while the feed fails cold", async () => {
      stubDated({ ...fixture, feedFails: true, lookupEvents: [POST_REPORT] });
      window.history.pushState({}, '', `/reports?event=${POST}`);
      try {
        renderQueue();

        await screen.findByText(/Failed to load reports/);
        await waitFor(() => expect(screen.getByTestId('detail')).toHaveAttribute('data-report-id', POST_REPORT.id));
        await waitFor(() => expect(screen.getByTestId('detail')).toHaveAttribute('data-handled-before-via', 'author'));
        expect(screen.getByTestId('detail')).toHaveAttribute(
          'data-handled-before', JSON.stringify([{ action: 'ban_user', at: T - 40 }]));
      } finally {
        window.history.pushState({}, '', '/');
      }
    });

    it("hands the pane the author's history for a post handled before through its author", async () => {
      stubDated(fixture);
      const user = userEvent.setup();
      renderQueue();

      await user.click(await screen.findByRole('button', { name: /already handled/ }));
      await user.click(row(`event:${POST}`)!);
      await waitFor(() => expect(screen.getByTestId('detail')).toHaveAttribute('data-handled-before-via', 'author'));
      expect(screen.getByTestId('detail')).toHaveAttribute(
        'data-handled-before', JSON.stringify([{ action: 'ban_user', at: T - 40 }]));
    });
  });
});
