// ABOUTME: Unhandled CSAM reports sit behind the pending-review switch with auto-hidden ones,
// ABOUTME: out of the default view, and leave it once a person handles them.

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { QueryClient, onlineManager } from '@tanstack/react-query';
import { useLocation } from 'react-router-dom';
import { nip19 } from 'nostr-tools';
import TestApp from '@/test/TestApp';
import { Reports } from './Reports';

const RELAY_URL = 'wss://relay.example';

vi.mock('@/components/ReportDetail', () => ({
  ReportDetail: ({ switchState }: { switchState?: string }) => (
    <div data-testid="detail" data-switch-state={switchState ?? ''} />
  ),
}));

const CSAM_PROFILE = '4'.repeat(64);
const SPAM_EVENT = '3'.repeat(64);
const HIDDEN_EVENT = '1'.repeat(64);

function report(id: string, createdAt: number, tags: string[][], content = '') {
  return { id, pubkey: '5'.repeat(64), created_at: createdAt, kind: 1984, tags, content, sig: 'f'.repeat(128) };
}

const CSAM_REPORT = report('d'.repeat(64), 1751000000, [
  ['p', CSAM_PROFILE, 'illegal'],
  ['L', 'social.nos.ontology'],
  ['l', 'NS-csam', 'social.nos.ontology'],
]);
const SPAM_REPORT = report('c'.repeat(64), 1751000050, [
  ['e', SPAM_EVENT, 'spam'],
  ['p', '9'.repeat(64), 'spam'],
  ['L', 'social.nos.ontology'],
  ['l', 'NS-spam', 'social.nos.ontology'],
]);
const HIDDEN_REPORT = report('a'.repeat(64), 1751000100, [
  ['e', HIDDEN_EVENT, 'spam'],
  ['p', '8'.repeat(64), 'spam'],
]);
// A NIP-56 'illegal' from another app with nothing that says CSAM.
const BARE_ILLEGAL_REPORT = report('b'.repeat(64), 1751000020, [
  ['p', CSAM_PROFILE, 'illegal'],
  ['client', 'some-other-app'],
], 'this account is breaking the law');

const NPUB_CSAM = nip19.npubEncode(CSAM_PROFILE);
const NOTE_SPAM = nip19.noteEncode(SPAM_EVENT);
const NOTE_HIDDEN = nip19.noteEncode(HIDDEN_EVENT);

type State = { target_type: string; target_id: string; action: string };
type LabelTarget = { type: string; value: string };

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function stubFetch({
  events,
  states = [],
  labels = () => Promise.resolve([] as LabelTarget[]),
  targeted = {},
  statesGate,
  statesFail = false,
}: {
  events: unknown[];
  states?: State[];
  labels?: () => Promise<LabelTarget[]>;
  // /api/resolution-state waits for this before answering.
  statesGate?: Promise<void>;
  // /api/resolution-state answers success: false, so the read fails.
  statesFail?: boolean;
  // A deep link's targeted lookup (/api/reports?event= or ?pubkey=), keyed by
  // the target's hex. A target with no entry gets an empty result.
  targeted?: Record<string, unknown[]>;
}) {
  const calls = { labels: 0, resolutionState: 0 };
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('/api/reports?')) {
      const hit = Object.keys(targeted).find((hex) => url.includes(hex));
      return jsonResponse({ success: true, events: hit ? targeted[hit] : [] });
    }
    if (url.includes('/api/reports')) return jsonResponse({ success: true, events });
    if (url.includes('/api/resolution-label-targets')) {
      calls.labels += 1;
      const targets = await labels();
      return jsonResponse({ success: true, targets, truncated: false, oldest_covered: null });
    }
    if (url.includes('/api/resolution-state')) {
      calls.resolutionState += 1;
      if (statesGate) await statesGate;
      if (statesFail) return jsonResponse({ success: false, error: 'unavailable' });
      return jsonResponse({ success: true, resolved: [], states });
    }
    if (url.includes('/api/relay-rpc')) return jsonResponse({ success: true, result: [] });
    return jsonResponse({ success: true });
  }));
  return calls;
}

function newClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });
}
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

function switchLabelText() {
  return document.querySelector('label[for="pending-review"]')?.textContent ?? null;
}
function rowFor(bech32: string) {
  return screen.getByText(bech32).closest('div.rounded-lg') as HTMLElement;
}
async function turnSwitchOn(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('switch', { name: /pending review/i }));
  await flush();
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

describe('Reports sensitive pending-review switch', () => {
  it('keeps a profile CSAM report out of the default view and shows it behind the switch', async () => {
    stubFetch({ events: [CSAM_REPORT, SPAM_REPORT] });
    const user = userEvent.setup();
    render(<TestApp queryClient={newClient()}><Reports relayUrl={RELAY_URL} /></TestApp>);

    await screen.findByText(NOTE_SPAM);
    expect(screen.queryByText(NPUB_CSAM)).not.toBeInTheDocument();
    expect(switchLabelText()).toBe('Pending review (sensitive)1');

    await turnSwitchOn(user);
    expect(within(rowFor(NPUB_CSAM)).getByText('Not hidden, needs review')).toBeInTheDocument();
    expect(screen.queryByText(NOTE_SPAM)).not.toBeInTheDocument();
  });

  it('keeps it out of the default All view and in the switched All view', async () => {
    stubFetch({ events: [CSAM_REPORT, SPAM_REPORT] });
    const user = userEvent.setup();
    render(<TestApp queryClient={newClient()}><Reports relayUrl={RELAY_URL} /></TestApp>);

    await screen.findByText(NOTE_SPAM);
    const allTab = () => screen.getByRole('tab', { name: /^All/, hidden: true });
    fireEvent.mouseDown(allTab(), { button: 0 });
    fireEvent.click(allTab());
    await waitFor(() => expect(allTab()).toHaveAttribute('aria-selected', 'true'));
    expect(screen.getByText(NOTE_SPAM)).toBeInTheDocument();
    expect(screen.queryByText(NPUB_CSAM)).not.toBeInTheDocument();

    await turnSwitchOn(user);
    expect(within(rowFor(NPUB_CSAM)).getByText('Not hidden, needs review')).toBeInTheDocument();
    expect(screen.queryByText(NOTE_SPAM)).not.toBeInTheDocument();
  });

  it('leaves a bare illegal report from another app in the default view', async () => {
    const calls = stubFetch({ events: [BARE_ILLEGAL_REPORT, SPAM_REPORT] });
    render(<TestApp queryClient={newClient()}><Reports relayUrl={RELAY_URL} /></TestApp>);

    await screen.findByText(NOTE_SPAM);
    expect(calls.resolutionState).toBeGreaterThan(0);
    expect(screen.getByText(NPUB_CSAM)).toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: /pending review/i })).not.toBeInTheDocument();
  });

  it('counts auto-hidden and not-hidden together', async () => {
    stubFetch({
      events: [CSAM_REPORT, SPAM_REPORT, HIDDEN_REPORT],
      states: [{ target_type: 'event', target_id: HIDDEN_EVENT, action: 'auto_hidden' }],
    });
    const user = userEvent.setup();
    render(<TestApp queryClient={newClient()}><Reports relayUrl={RELAY_URL} /></TestApp>);

    await screen.findByText(NOTE_SPAM);
    expect(switchLabelText()).toBe('Pending review (sensitive)2');
    expect(screen.queryByText(NOTE_HIDDEN)).not.toBeInTheDocument();
    expect(screen.queryByText(NPUB_CSAM)).not.toBeInTheDocument();

    await turnSwitchOn(user);
    expect(within(rowFor(NOTE_HIDDEN)).getByText('Hidden automatically')).toBeInTheDocument();
    expect(within(rowFor(NOTE_HIDDEN)).queryByText('Not hidden, needs review')).not.toBeInTheDocument();
    expect(within(rowFor(NPUB_CSAM)).getByText('Not hidden, needs review')).toBeInTheDocument();
    expect(within(rowFor(NPUB_CSAM)).queryByText('Hidden automatically')).not.toBeInTheDocument();
  });

  it('hands the open report its switch state', async () => {
    stubFetch({
      events: [CSAM_REPORT, SPAM_REPORT, HIDDEN_REPORT],
      states: [{ target_type: 'event', target_id: HIDDEN_EVENT, action: 'auto_hide_unresolved' }],
    });
    const user = userEvent.setup();
    render(<TestApp queryClient={newClient()}><Reports relayUrl={RELAY_URL} /></TestApp>);

    await screen.findByText(NOTE_SPAM);
    await turnSwitchOn(user);
    await user.click(rowFor(NPUB_CSAM));
    await waitFor(() =>
      expect(screen.getByTestId('detail')).toHaveAttribute('data-switch-state', 'not-hidden'));

    await user.click(rowFor(NOTE_HIDDEN));
    await waitFor(() =>
      expect(screen.getByTestId('detail')).toHaveAttribute('data-switch-state', 'hidden-needs-check'));
  });

  // The worker writes auto_hide_unresolved only after the relay ban landed, so
  // the row says hidden, and that it needs a check.
  it('labels an unresolved hide as hidden and needing a check', async () => {
    stubFetch({
      events: [SPAM_REPORT, HIDDEN_REPORT],
      states: [
        { target_type: 'event', target_id: HIDDEN_EVENT, action: 'auto_hide_unresolved' },
        { target_type: 'event', target_id: HIDDEN_EVENT, action: 'auto_hidden' },
      ],
    });
    const user = userEvent.setup();
    render(<TestApp queryClient={newClient()}><Reports relayUrl={RELAY_URL} /></TestApp>);

    await screen.findByText(NOTE_SPAM);
    await turnSwitchOn(user);
    expect(within(rowFor(NOTE_HIDDEN)).getByText('Hidden, needs a check')).toBeInTheDocument();
    expect(screen.queryByText('Hidden automatically')).not.toBeInTheDocument();
  });

  it('does not count a target behind the switch as resolved', async () => {
    stubFetch({ events: [CSAM_REPORT] });
    render(<TestApp queryClient={newClient()}><Reports relayUrl={RELAY_URL} /></TestApp>);

    await waitFor(() => expect(switchLabelText()).toBe('Pending review (sensitive)1'));
    expect(screen.getByText(/^0 pending/)).toBeInTheDocument();
    expect(screen.queryByText(/\d+ resolved/)).not.toBeInTheDocument();
  });

  it('does not put a CSAM target a person restored back behind the switch', async () => {
    // The restore writes only auto_hide_restored, which the resolved set does
    // not include, so the human auto-hide row is what keeps it out.
    stubFetch({
      events: [CSAM_REPORT, SPAM_REPORT],
      states: [
        { target_type: 'pubkey', target_id: CSAM_PROFILE, action: 'auto_hide_restored' },
        { target_type: 'pubkey', target_id: CSAM_PROFILE, action: 'auto_hidden' },
      ],
    });
    render(<TestApp queryClient={newClient()}><Reports relayUrl={RELAY_URL} /></TestApp>);

    await screen.findByText(NOTE_SPAM);
    expect(screen.getByText(NPUB_CSAM)).toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: /pending review/i })).not.toBeInTheDocument();
  });

  describe('while resolution labels load', () => {
    // The CSAM target is resolved only by a resolution label. With Hide
    // resolved on, labels gate the whole queue behind a skeleton, which would
    // make "absent from the default view" true for the wrong reason. So the
    // labels land empty first, Hide resolved goes off, and then the labels
    // query is reset to a first load that has not answered yet.
    async function renderWithLabelsHeld() {
      let release: (targets: LabelTarget[]) => void = () => {};
      let first = true;
      const calls = stubFetch({
        events: [CSAM_REPORT, SPAM_REPORT],
        labels: () => {
          if (first) {
            first = false;
            return Promise.resolve([]);
          }
          return new Promise<LabelTarget[]>((resolve) => { release = resolve; });
        },
      });
      const queryClient = newClient();
      const user = userEvent.setup();
      render(<TestApp queryClient={queryClient}><Reports relayUrl={RELAY_URL} /></TestApp>);

      await screen.findByText(NOTE_SPAM);
      await user.click(screen.getByRole('switch', { name: /hide resolved/i }));
      expect(screen.getByRole('switch', { name: /hide resolved/i })).not.toBeChecked();

      await act(async () => {
        void queryClient.resetQueries({ queryKey: ['resolution-label-targets'] });
      });
      await waitFor(() => expect(calls.labels).toBe(2));
      await flush();
      expect(queryClient.getQueryState(['resolution-label-targets', RELAY_URL])?.status).toBe('pending');
      return { release: (targets: LabelTarget[]) => release(targets) };
    }

    it('keeps a CSAM target behind the switch while resolution labels are still loading', async () => {
      await renderWithLabelsHeld();

      expect(screen.getByText(NOTE_SPAM)).toBeInTheDocument();
      expect(screen.queryByText(NPUB_CSAM)).not.toBeInTheDocument();
      expect(switchLabelText()).toBe('Pending review (sensitive)1');
    });

    it('drops a resolved CSAM target out of the switch', async () => {
      const { release } = await renderWithLabelsHeld();
      expect(switchLabelText()).toBe('Pending review (sensitive)1');

      await act(async () => { release([{ type: 'pubkey', value: CSAM_PROFILE }]); });
      await waitFor(() =>
        expect(screen.queryByRole('switch', { name: /pending review/i })).not.toBeInTheDocument());
      // Resolved, and Hide resolved is off, so it is back in the default view.
      expect(screen.getByText(NPUB_CSAM)).toBeInTheDocument();
    });

    it('keeps the switch, and the way back, after its last item is resolved', async () => {
      // Hide resolved stays on (the default) this time, so turning the switch
      // off has something to restore. The switch turns it off, which stops the
      // labels from gating, so the held first load does not skeleton the list.
      let release: (targets: LabelTarget[]) => void = () => {};
      let first = true;
      const calls = stubFetch({
        events: [CSAM_REPORT, SPAM_REPORT],
        labels: () => {
          if (first) {
            first = false;
            return Promise.resolve([]);
          }
          return new Promise<LabelTarget[]>((resolve) => { release = resolve; });
        },
      });
      const queryClient = newClient();
      const user = userEvent.setup();
      render(<TestApp queryClient={queryClient}><Reports relayUrl={RELAY_URL} /></TestApp>);

      await screen.findByText(NOTE_SPAM);
      await turnSwitchOn(user);
      expect(screen.getByRole('switch', { name: /hide resolved/i })).not.toBeChecked();
      await act(async () => {
        void queryClient.resetQueries({ queryKey: ['resolution-label-targets'] });
      });
      await waitFor(() => expect(calls.labels).toBe(2));
      expect(screen.getByText(NPUB_CSAM)).toBeInTheDocument();

      await act(async () => { release([{ type: 'pubkey', value: CSAM_PROFILE }]); });
      await waitFor(() => expect(screen.queryByText(NPUB_CSAM)).not.toBeInTheDocument());
      const pending = screen.getByRole('switch', { name: /pending review/i });
      expect(pending).toBeChecked();
      expect(switchLabelText()).toBe('Pending review (sensitive)0');

      await user.click(pending);
      await waitFor(() =>
        expect(screen.queryByRole('switch', { name: /pending review/i })).not.toBeInTheDocument());
      const hideResolved = screen.getByRole('switch', { name: /hide resolved/i });
      expect(hideResolved).toBeChecked();
      expect(hideResolved).toBeEnabled();
      expect(screen.getByText(NOTE_SPAM)).toBeInTheDocument();
    });
  });

  describe('when a link lands on a report behind the switch', () => {
    // An auto-hidden target the bulk list does not carry, so only the deep
    // link's targeted lookup can find it.
    const LOOKUP_EVENT = '2'.repeat(64);
    const LOOKUP_REPORT = report('e'.repeat(64), 1751000200, [
      ['e', LOOKUP_EVENT, 'spam'],
      ['p', '6'.repeat(64), 'spam'],
    ]);
    const HIDDEN_STATES: State[] = [
      { target_type: 'event', target_id: HIDDEN_EVENT, action: 'auto_hidden' },
      { target_type: 'event', target_id: LOOKUP_EVENT, action: 'auto_hidden' },
    ];

    // Mirrors the app's route: /reports/<id> hands Reports the id to select.
    function RoutedReports() {
      const { pathname } = useLocation();
      const reportId = pathname.match(/^\/reports\/([0-9a-f]{64})$/)?.[1];
      return <Reports relayUrl={RELAY_URL} selectedReportId={reportId} />;
    }
    function renderAt(path: string, queryClient = newClient()) {
      window.history.pushState({}, '', path);
      render(<TestApp queryClient={queryClient}><RoutedReports /></TestApp>);
      return queryClient;
    }
    const pendingSwitch = () => screen.getByRole('switch', { name: /pending review/i });
    const hideResolvedSwitch = () => screen.getByRole('switch', { name: /hide resolved/i });

    it('opens the switch for ?event= on an auto-hidden target in the list', async () => {
      stubFetch({ events: [CSAM_REPORT, SPAM_REPORT, HIDDEN_REPORT], states: HIDDEN_STATES });
      renderAt(`/reports?event=${HIDDEN_EVENT}`);

      await waitFor(() => expect(window.location.pathname).toBe(`/reports/${HIDDEN_REPORT.id}`));
      await waitFor(() => expect(pendingSwitch()).toBeChecked());
      expect(within(rowFor(NOTE_HIDDEN)).getByText('Hidden automatically')).toBeInTheDocument();
    });

    it('opens the switch for ?pubkey= on a profile CSAM target', async () => {
      stubFetch({ events: [CSAM_REPORT, SPAM_REPORT] });
      renderAt(`/reports?pubkey=${CSAM_PROFILE}`);

      await waitFor(() => expect(window.location.pathname).toBe(`/reports/${CSAM_REPORT.id}`));
      await waitFor(() => expect(pendingSwitch()).toBeChecked());
      expect(within(rowFor(NPUB_CSAM)).getByText('Not hidden, needs review')).toBeInTheDocument();
    });

    it('opens the switch for ?event= that only the targeted lookup finds', async () => {
      stubFetch({
        events: [CSAM_REPORT, SPAM_REPORT, HIDDEN_REPORT],
        states: HIDDEN_STATES,
        targeted: { [LOOKUP_EVENT]: [LOOKUP_REPORT] },
      });
      renderAt(`/reports?event=${LOOKUP_EVENT}`);

      await waitFor(() => expect(window.location.pathname).toBe(`/reports/${LOOKUP_REPORT.id}`));
      await waitFor(() => expect(pendingSwitch()).toBeChecked());
    });

    it('opens the switch when arriving at /reports/<id> directly', async () => {
      stubFetch({ events: [CSAM_REPORT, SPAM_REPORT] });
      renderAt(`/reports/${CSAM_REPORT.id}`);

      await waitFor(() => expect(pendingSwitch()).toBeChecked());
      expect(within(rowFor(NPUB_CSAM)).getByText('Not hidden, needs review')).toBeInTheDocument();
    });

    it('does not reopen the switch for a clicked row after the moderator turns it off', async () => {
      // A click is not a deep link, so the effect has no business reopening it.
      stubFetch({ events: [CSAM_REPORT, SPAM_REPORT, HIDDEN_REPORT], states: HIDDEN_STATES });
      const queryClient = newClient();
      const user = userEvent.setup();
      render(<TestApp queryClient={queryClient}><RoutedReports /></TestApp>);

      await screen.findByText(NOTE_SPAM);
      await turnSwitchOn(user);
      await user.click(rowFor(NOTE_HIDDEN));
      await waitFor(() => expect(window.location.pathname).toBe(`/reports/${HIDDEN_REPORT.id}`));

      await user.click(pendingSwitch());
      await flush();
      expect(pendingSwitch()).not.toBeChecked();
      await act(async () => { await queryClient.invalidateQueries(); });
      await flush();
      expect(pendingSwitch()).not.toBeChecked();
    });

    it('stays off across the next poll once turned off after a deep link, and hands Hide resolved back', async () => {
      const calls = stubFetch({
        events: [CSAM_REPORT, SPAM_REPORT, HIDDEN_REPORT],
        states: HIDDEN_STATES,
      });
      const user = userEvent.setup();
      const queryClient = renderAt(`/reports?event=${HIDDEN_EVENT}`);

      await waitFor(() => expect(pendingSwitch()).toBeChecked());
      expect(hideResolvedSwitch()).not.toBeChecked();

      await user.click(pendingSwitch());
      await flush();
      expect(pendingSwitch()).not.toBeChecked();

      // Stands in for the 15s poll: a refetch hands the effect a new
      // membership map, so it re-runs with the deep-linked report still open.
      const before = calls.resolutionState;
      await act(async () => { await queryClient.invalidateQueries(); });
      await waitFor(() => expect(calls.resolutionState).toBeGreaterThan(before));
      await flush();

      expect(pendingSwitch()).not.toBeChecked();
      expect(hideResolvedSwitch()).toBeChecked();
      expect(screen.getByTestId('detail')).toBeInTheDocument();
    });

    // The link lands on a target that is both auto-hidden and resolved. The
    // deep-link handler used to turn Hide resolved off before the switch opened,
    // so the switch saved "off" as the moderator's setting and handed that back.
    it('hands Hide resolved back after a link to a resolved auto-hidden target', async () => {
      stubFetch({
        events: [CSAM_REPORT, SPAM_REPORT, HIDDEN_REPORT],
        states: HIDDEN_STATES,
        labels: () => Promise.resolve([{ type: 'event', value: HIDDEN_EVENT }]),
      });
      const user = userEvent.setup();
      renderAt(`/reports?event=${HIDDEN_EVENT}`);

      await waitFor(() => expect(window.location.pathname).toBe(`/reports/${HIDDEN_REPORT.id}`));
      await waitFor(() => expect(pendingSwitch()).toBeChecked());
      expect(hideResolvedSwitch()).not.toBeChecked();

      await user.click(pendingSwitch());
      await flush();
      expect(pendingSwitch()).not.toBeChecked();
      expect(hideResolvedSwitch()).toBeChecked();
    });

    // Labels resolve the auto-hidden target before /api/resolution-state has
    // said it is auto-hidden. Unhiding resolved work for the link then would
    // turn Hide resolved off before the switch opened, and the switch would
    // save "off" as the moderator's setting.
    it('holds the link unhide until switch membership is known', async () => {
      let releaseStates: () => void = () => {};
      const statesGate = new Promise<void>((resolve) => { releaseStates = resolve; });
      stubFetch({
        events: [CSAM_REPORT, SPAM_REPORT, HIDDEN_REPORT],
        states: HIDDEN_STATES,
        labels: () => Promise.resolve([{ type: 'event', value: HIDDEN_EVENT }]),
        statesGate,
      });
      const user = userEvent.setup();
      renderAt(`/reports?event=${HIDDEN_EVENT}`);

      await waitFor(() => expect(window.location.pathname).toBe(`/reports/${HIDDEN_REPORT.id}`));
      await flush();
      await act(async () => { releaseStates(); });

      await waitFor(() => expect(pendingSwitch()).toBeChecked());
      expect(hideResolvedSwitch()).not.toBeChecked();
      await user.click(pendingSwitch());
      await flush();
      expect(pendingSwitch()).not.toBeChecked();
      expect(hideResolvedSwitch()).toBeChecked();
    });

    // The hold must not strand the link: a failed read falls back to showing
    // the linked resolved report, as it did before the hold.
    it('still shows a resolved linked report when resolution state cannot be read', async () => {
      stubFetch({
        events: [CSAM_REPORT, SPAM_REPORT, HIDDEN_REPORT],
        labels: () => Promise.resolve([{ type: 'event', value: SPAM_EVENT }]),
        statesFail: true,
      });
      const user = userEvent.setup();
      renderAt(`/reports?event=${SPAM_EVENT}`);

      await waitFor(() => expect(window.location.pathname).toBe(`/reports/${SPAM_REPORT.id}`));
      await user.click(await screen.findByRole('button', { name: /show the queue anyway/i }));
      await flush();

      expect(hideResolvedSwitch()).not.toBeChecked();
      expect(screen.getByText(NOTE_SPAM)).toBeInTheDocument();
    });

    describe('while the browser is offline', () => {
      let offlineClient: QueryClient | undefined;
      afterEach(() => {
        // Drop the paused read first. Back online it would resume once the
        // fetch stub is gone and reach for the network.
        offlineClient?.clear();
        offlineClient = undefined;
        onlineManager.setOnline(true);
      });

      // The hold must not strand the link offline either. A read that starts
      // while the browser is offline pauses, and never settles on its own.
      it('still shows a resolved linked report while the resolution state read is paused', async () => {
        stubFetch({
          events: [CSAM_REPORT, SPAM_REPORT, HIDDEN_REPORT],
          labels: () => Promise.resolve([{ type: 'event', value: SPAM_EVENT }]),
          // The first read never answers, so membership is unknown when the link lands.
          statesGate: new Promise<void>(() => {}),
        });
        const user = userEvent.setup();
        const queryClient = renderAt(`/reports?event=${SPAM_EVENT}`);
        offlineClient = queryClient;
        await waitFor(() => expect(window.location.pathname).toBe(`/reports/${SPAM_REPORT.id}`));

        // The browser goes offline, then the read starts again, so it pauses.
        onlineManager.setOnline(false);
        await act(async () => {
          void queryClient.resetQueries({ queryKey: ['resolution-state'] });
        });
        expect(queryClient.getQueryState(['resolution-state'])?.fetchStatus).toBe('paused');

        await user.click(await screen.findByRole('button', { name: /show the queue anyway/i }));
        await flush();

        expect(hideResolvedSwitch()).not.toBeChecked();
        expect(screen.getByText(NOTE_SPAM)).toBeInTheDocument();
      });
    });

    // Labels answer empty first, then every later load waits for release(),
    // so a test can resolve the CSAM target after the switch has opened.
    function stubHeldLabels({
      firstLoadHeld,
      events = [CSAM_REPORT, SPAM_REPORT],
      states = [],
    }: { firstLoadHeld: boolean; events?: unknown[]; states?: State[] }) {
      let release: (targets: LabelTarget[]) => void = () => {};
      let first = true;
      const calls = stubFetch({
        events,
        states,
        labels: () => {
          if (first && !firstLoadHeld) {
            first = false;
            return Promise.resolve([]);
          }
          first = false;
          return new Promise<LabelTarget[]>((resolve) => { release = resolve; });
        },
      });
      return { calls, release: (targets: LabelTarget[]) => release(targets) };
    }

    it('closes a switch the link opened once the linked target turns out resolved', async () => {
      // The labels have not answered when the link lands, so the CSAM target
      // looks unhandled and the switch opens for it.
      const { release } = stubHeldLabels({ firstLoadHeld: true });
      renderAt(`/reports/${CSAM_REPORT.id}`);

      await waitFor(() => expect(pendingSwitch()).toBeChecked());
      expect(within(rowFor(NPUB_CSAM)).getByText('Not hidden, needs review')).toBeInTheDocument();

      await act(async () => { release([{ type: 'pubkey', value: CSAM_PROFILE }]); });

      await waitFor(() =>
        expect(screen.queryByRole('switch', { name: /pending review/i })).not.toBeInTheDocument());
      // Resolved, and the link's courtesy turned Hide resolved off to show it.
      await waitFor(() => expect(hideResolvedSwitch()).not.toBeChecked());
      expect(screen.getByText(NPUB_CSAM)).toBeInTheDocument();
      expect(screen.getByText(NOTE_SPAM)).toBeInTheDocument();
      expect(window.location.pathname).toBe(`/reports/${CSAM_REPORT.id}`);
      expect(screen.getByTestId('detail')).toHaveAttribute('data-switch-state', '');
    });

    it('keeps a switch the moderator turned on when the open target resolves', async () => {
      const { calls, release } = stubHeldLabels({ firstLoadHeld: false });
      const queryClient = newClient();
      const user = userEvent.setup();
      render(<TestApp queryClient={queryClient}><RoutedReports /></TestApp>);

      await screen.findByText(NOTE_SPAM);
      await turnSwitchOn(user);
      await user.click(rowFor(NPUB_CSAM));
      await waitFor(() => expect(window.location.pathname).toBe(`/reports/${CSAM_REPORT.id}`));

      await act(async () => {
        void queryClient.resetQueries({ queryKey: ['resolution-label-targets'] });
      });
      await waitFor(() => expect(calls.labels).toBe(2));
      await act(async () => { release([{ type: 'pubkey', value: CSAM_PROFILE }]); });
      await waitFor(() => expect(screen.queryByText(NPUB_CSAM)).not.toBeInTheDocument());
      await flush();

      expect(pendingSwitch()).toBeChecked();
      expect(hideResolvedSwitch()).not.toBeChecked();
    });

    it('keeps a link-opened switch once the moderator has turned it off and on again', async () => {
      // Labels land empty first: turning the switch off hands Hide resolved
      // back on, and a held first load would gate the list behind a skeleton.
      const { calls, release } = stubHeldLabels({ firstLoadHeld: false });
      const user = userEvent.setup();
      const queryClient = renderAt(`/reports/${CSAM_REPORT.id}`);

      await waitFor(() => expect(pendingSwitch()).toBeChecked());
      await user.click(pendingSwitch());
      await flush();
      await user.click(pendingSwitch());
      await flush();
      expect(pendingSwitch()).toBeChecked();

      await act(async () => {
        void queryClient.resetQueries({ queryKey: ['resolution-label-targets'] });
      });
      await waitFor(() => expect(calls.labels).toBe(2));
      await act(async () => { release([{ type: 'pubkey', value: CSAM_PROFILE }]); });
      await waitFor(() => expect(screen.queryByText(NPUB_CSAM)).not.toBeInTheDocument());
      await flush();

      expect(pendingSwitch()).toBeChecked();
    });

    it('keeps a link-opened switch once the moderator picks another row in it', async () => {
      const { calls, release } = stubHeldLabels({
        firstLoadHeld: false,
        events: [CSAM_REPORT, SPAM_REPORT, HIDDEN_REPORT],
        states: HIDDEN_STATES,
      });
      const user = userEvent.setup();
      const queryClient = renderAt(`/reports/${HIDDEN_REPORT.id}`);

      await waitFor(() => expect(pendingSwitch()).toBeChecked());
      await user.click(rowFor(NPUB_CSAM));
      await waitFor(() => expect(window.location.pathname).toBe(`/reports/${CSAM_REPORT.id}`));

      await act(async () => {
        void queryClient.resetQueries({ queryKey: ['resolution-label-targets'] });
      });
      await waitFor(() => expect(calls.labels).toBe(2));
      await act(async () => { release([{ type: 'pubkey', value: CSAM_PROFILE }]); });
      await waitFor(() => expect(screen.queryByText(NPUB_CSAM)).not.toBeInTheDocument());
      await flush();

      expect(pendingSwitch()).toBeChecked();
      expect(screen.getByText(NOTE_HIDDEN)).toBeInTheDocument();
    });
  });
});
