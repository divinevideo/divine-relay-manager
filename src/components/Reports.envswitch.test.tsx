// ABOUTME: After an environment switch the queue shows nothing until the new environment answers.
// ABOUTME: A previous environment's reports or resolution state must never stand in for the new one's.

import type { ReactElement } from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { nip19 } from 'nostr-tools';
import TestApp from '@/test/TestApp';
import { EMPTY_RESOLVED_PAGE } from '@/test/resolvedHistory';
import { Reports } from './Reports';

vi.mock('@/components/ReportDetail', () => ({ ReportDetail: () => null }));

const RELAY_A = 'wss://relay-a.example';
const RELAY_B = 'wss://relay-b.example';
const TARGET_A = 'a'.repeat(64);
const NPUB_A = nip19.npubEncode(TARGET_A);
const REPORT_A = {
  id: '1'.repeat(64),
  pubkey: 'b'.repeat(64),
  created_at: 1751000000,
  kind: 1984,
  tags: [['p', TARGET_A, 'spam']],
  content: 'spam',
  sig: 'e'.repeat(128),
};

type Read = 'reports' | 'labels' | 'decisions';
const KEYS_IN_B: Record<Read, unknown[]> = {
  reports: ['reports', RELAY_B],
  labels: ['resolution-label-targets', RELAY_B],
  decisions: ['resolution-state'],
};

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

// Environment A answers everything. Environment B answers everything except
// the one read under test, which never settles: the window a moderator sits in
// right after switching.
function stubEnvironments(env: { current: 'a' | 'b' }, stalled: Read) {
  const never = new Promise<Response>(() => {});
  const stall = (read: Read) => env.current === 'b' && stalled === read;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('/api/reports/resolved')) return jsonResponse(EMPTY_RESOLVED_PAGE);
    if (url.includes('/api/reports')) {
      if (stall('reports')) return never;
      return jsonResponse({ success: true, events: env.current === 'a' ? [REPORT_A] : [], truncated: false });
    }
    if (url.includes('/api/resolution-label-targets')) {
      if (stall('labels')) return never;
      return jsonResponse({ success: true, targets: [], truncated: false, oldest_covered: null });
    }
    if (url.includes('/api/resolution-state')) {
      if (stall('decisions')) return never;
      return jsonResponse({ success: true, resolved: [], states: [] });
    }
    if (url.includes('/api/relay-rpc')) return jsonResponse({ success: true, result: [] });
    return jsonResponse({ success: true });
  }));
}

const tree = (queryClient: QueryClient, relayUrl: string) => (
  <TestApp queryClient={queryClient}>
    <Reports relayUrl={relayUrl} />
  </TestApp>
);

async function renderInA(stalled: Read) {
  const env = { current: 'a' as 'a' | 'b' };
  stubEnvironments(env, stalled);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });
  const { rerender } = render(tree(queryClient, RELAY_A));
  // Control: environment A's report is listed before the switch.
  expect(await screen.findByText(NPUB_A)).toBeInTheDocument();
  return { env, queryClient, rerender };
}

async function switchToB(
  { env, queryClient, rerender }: { env: { current: 'a' | 'b' }; queryClient: QueryClient; rerender: (ui: ReactElement) => void },
  stalled: Read,
) {
  env.current = 'b';
  // What EnvironmentSelector does: drop every cached read; the screen then
  // re-renders against the new relay.
  act(() => { queryClient.clear(); });
  rerender(tree(queryClient, RELAY_B));
  // Every read except the stalled one has answered for B, so the stalled read
  // is the only thing that can still be holding the queue back.
  const answered: unknown[][] = [
    ['banned-pubkeys'],
    ['banned-events'],
    ...(Object.keys(KEYS_IN_B) as Read[]).filter(read => read !== stalled).map(read => KEYS_IN_B[read]),
  ];
  for (const key of answered) {
    await waitFor(() => expect(queryClient.getQueryState(key)?.status).toBe('success'));
  }
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
}

let consoleError: MockInstance;
beforeEach(() => {
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  consoleError.mockRestore();
});

describe('an environment switch shows nothing until the new environment answers', () => {
  it("does not list the previous environment's reports while the new ones load", async () => {
    const rendered = await renderInA('reports');
    await switchToB(rendered, 'reports');

    expect(screen.getByTestId('reports-loading-skeleton')).toBeInTheDocument();
    expect(screen.queryByText(NPUB_A)).not.toBeInTheDocument();
  });

  it("does not filter the new queue with the previous environment's decisions", async () => {
    const rendered = await renderInA('decisions');
    await switchToB(rendered, 'decisions');

    expect(screen.getByTestId('reports-loading-skeleton')).toBeInTheDocument();
  });

  it("does not filter the new queue with the previous environment's resolution labels", async () => {
    const rendered = await renderInA('labels');
    await switchToB(rendered, 'labels');

    expect(screen.getByTestId('reports-loading-skeleton')).toBeInTheDocument();
  });
});
