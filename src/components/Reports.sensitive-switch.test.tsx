// ABOUTME: Unhandled CSAM reports sit behind the pending-review switch with auto-hidden ones,
// ABOUTME: out of the default view, and leave it once a person handles them.

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
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
}: {
  events: unknown[];
  states?: State[];
  labels?: () => Promise<LabelTarget[]>;
}) {
  const calls = { labels: 0, resolutionState: 0 };
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('/api/reports')) return jsonResponse({ success: true, events });
    if (url.includes('/api/resolution-label-targets')) {
      calls.labels += 1;
      const targets = await labels();
      return jsonResponse({ success: true, targets, truncated: false, oldest_covered: null });
    }
    if (url.includes('/api/resolution-state')) {
      calls.resolutionState += 1;
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
      expect(screen.getByTestId('detail')).toHaveAttribute('data-switch-state', 'hide-unconfirmed'));
  });

  it('does not claim an unconfirmed hide landed', async () => {
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
    expect(within(rowFor(NOTE_HIDDEN)).getByText('Hide not confirmed')).toBeInTheDocument();
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
});
