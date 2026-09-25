// ABOUTME: Pins the options the reports queue passes to the shared ban-list reads.
// ABOUTME: The queue polls both lists, and a deep link reads the banned accounts fresh.

import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import TestApp from '@/test/TestApp';
import { Reports } from './Reports';
import { useBannedEvents, useBannedPubkeys } from '@/hooks/useRelayBanLists';

// useRelayBanLists.test.ts pins that the hooks forward these options. Nothing
// else notices when the queue stops passing them: without the poll, handled
// posts stay in the queue until something else refetches the list, and
// without the deep-link staleTime, an arriving report reads a cached ban
// status up to 30s old. So spy on the real hooks and check what the queue asks.
vi.mock('@/hooks/useRelayBanLists', async (orig) => {
  const actual = await orig<typeof import('@/hooks/useRelayBanLists')>();
  return {
    ...actual,
    useBannedPubkeys: vi.fn(actual.useBannedPubkeys),
    useBannedEvents: vi.fn(actual.useBannedEvents),
  };
});

vi.mock('@/components/ReportDetail', () => ({ ReportDetail: () => null }));

const TARGET_PUBKEY = 'd'.repeat(64);
const QUEUE_POLL_MS = 15 * 1000;

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function renderQueue() {
  return render(
    <TestApp>
      <Reports relayUrl="wss://relay.example" />
    </TestApp>
  );
}

let consoleError: MockInstance;

beforeEach(() => {
  vi.clearAllMocks();
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('/api/reports')) return jsonResponse({ success: true, events: [] });
    if (url.includes('/api/resolution-label-targets')) return jsonResponse({ success: true, targets: [], truncated: false, oldest_covered: null });
    if (url.includes('/api/resolution-state')) return jsonResponse({ success: true, resolved: [], states: [] });
    if (url.includes('/api/relay-rpc')) return jsonResponse({ success: true, result: [] });
    return jsonResponse({ success: true });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  consoleError.mockRestore();
  window.history.pushState({}, '', '/');
});

describe('Reports ban-list reads', () => {
  it('polls both ban lists', async () => {
    renderQueue();

    await waitFor(() => expect(useBannedEvents).toHaveBeenCalled());
    expect(useBannedEvents).toHaveBeenCalledWith(expect.objectContaining({ refetchInterval: QUEUE_POLL_MS }));
    expect(useBannedPubkeys).toHaveBeenCalledWith(expect.objectContaining({ refetchInterval: QUEUE_POLL_MS }));
  });

  it('reads the banned accounts with the default 30s staleTime without a deep link', async () => {
    renderQueue();

    await waitFor(() => expect(useBannedPubkeys).toHaveBeenCalled());
    expect(useBannedPubkeys).toHaveBeenCalledWith(expect.objectContaining({ staleTime: 30 * 1000 }));
    expect(useBannedPubkeys).not.toHaveBeenCalledWith(expect.objectContaining({ staleTime: 0 }));
  });

  it('reads the banned accounts fresh on a deep link', async () => {
    window.history.pushState({}, '', `/reports?pubkey=${TARGET_PUBKEY}`);

    renderQueue();

    await waitFor(() => expect(useBannedPubkeys).toHaveBeenCalled());
    expect(useBannedPubkeys).toHaveBeenCalledWith(expect.objectContaining({ staleTime: 0 }));
  });
});
