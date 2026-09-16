// ABOUTME: The Hide resolved toggle must obey the moderator, not resolution data.
// ABOUTME: Reproduces the reported "toggle does nothing until you reload" stutter.

import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import TestApp from '@/test/TestApp';
import { Reports } from './Reports';

const RELAY_URL = 'wss://relay.example';
const TARGET = 'c'.repeat(64);

vi.mock('@/components/ReportDetail', () => ({
  ReportDetail: () => <div data-testid="detail" />,
}));

const REPORT = {
  id: 'a'.repeat(64),
  pubkey: 'b'.repeat(64),
  created_at: 1751000000,
  kind: 1984,
  tags: [['e', TARGET, 'spam'], ['p', 'd'.repeat(64), 'spam']],
  content: 'reported',
  sig: 'e'.repeat(128),
};

// A second, always-resolved target. Its presence is what makes the toggle
// observable: with Hide resolved ON it must be absent, with it OFF present.
const OTHER = '9'.repeat(64);
const RESOLVED_REPORT = {
  ...REPORT,
  id: 'f'.repeat(64),
  created_at: 1751000050,
  tags: [['e', OTHER, 'spam'], ['p', '8'.repeat(64), 'spam']],
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
    if (url.includes('/api/reports')) {
      return jsonResponse({ success: true, events: [REPORT, RESOLVED_REPORT] });
    }
    if (url.includes('/api/resolution-label-targets')) {
      return jsonResponse({ success: true, targets: [], truncated: false, oldest_covered: null });
    }
    if (url.includes('/api/resolution-state')) {
      calls.resolutionState += 1;
      const resolved = [{ target_type: 'event', target_id: OTHER }];
      if (resolvedNow()) resolved.push({ target_type: 'event', target_id: TARGET });
      return jsonResponse({ success: true, resolved, states: [] });
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
