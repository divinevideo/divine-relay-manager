// ABOUTME: resolvedTargets is subtractive, so a resolution source that is
// ABOUTME: missing or errored un-hides handled work rather than hiding more (#221)

import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { nip19 } from 'nostr-tools';
import TestApp from '@/test/TestApp';
import { Reports } from './Reports';

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
  bannedEvents?: 'empty' | 'error';
  decisions?: 'resolves' | 'empty' | 'error';
  slow?: Array<'labels' | 'bannedPubkeys' | 'bannedEvents' | 'decisions'>;
}

function stubFetch(state: SourceState) {
  const never = new Promise<Response>(() => {});
  const slow = new Set(state.slow ?? []);

  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);

    if (url.includes('/api/reports')) {
      return jsonResponse({ success: true, events: [REPORT] });
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
      return jsonResponse({
        success: true,
        result: mode === 'resolves' ? [{ pubkey: REPORTED_PUBKEY }] : [],
      });
    }

    return jsonResponse({ success: true });
  }));
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

function renderReports() {
  return render(
    <TestApp>
      <Reports relayUrl="wss://relay.example" />
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
});

describe('cold load does not render an unfiltered queue (#221)', () => {
  it('keeps the skeleton up while the banned pubkeys list is still loading', async () => {
    // Reports resolve fast; this source never does. Before the fix the queue
    // painted the already-banned target as pending in the gap.
    stubFetch({ labels: 'empty', bannedPubkeys: 'resolves', bannedEvents: 'empty', decisions: 'empty', slow: ['bannedPubkeys'] });
    renderReports();

    await waitFor(() => expect(screen.getAllByText(/reports/i).length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText(REPORTED_NPUB)).not.toBeInTheDocument();
  });

  it('keeps the skeleton up while resolution labels are still loading', async () => {
    stubFetch({ labels: 'resolves', bannedPubkeys: 'empty', bannedEvents: 'empty', decisions: 'empty', slow: ['labels'] });
    renderReports();

    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText(REPORTED_NPUB)).not.toBeInTheDocument();
  });

  it('renders once every gating source has landed', async () => {
    stubFetch({ labels: 'empty', bannedPubkeys: 'empty', bannedEvents: 'empty', decisions: 'empty' });
    renderReports();

    expect(await screen.findByText(REPORTED_NPUB)).toBeInTheDocument();
  });
});
