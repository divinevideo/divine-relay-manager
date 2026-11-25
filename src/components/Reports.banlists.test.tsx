// ABOUTME: Checks the reports queue's ban-list requests and deep-link freshness.
// ABOUTME: The queue polls both lists, and a deep link reads the banned accounts fresh.

import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import TestApp from '@/test/TestApp';
import { EMPTY_RESOLVED_PAGE } from '@/test/resolvedHistory';
import { Reports } from './Reports';
import { useBannedPubkeys } from '@/hooks/useRelayBanLists';

// Keep the real hooks for the polling test. The spy checks which freshness
// policy the queue requests when it is opened from a deep link.
vi.mock('@/hooks/useRelayBanLists', async (orig) => {
  const actual = await orig<typeof import('@/hooks/useRelayBanLists')>();
  return {
    ...actual,
    useBannedPubkeys: vi.fn(actual.useBannedPubkeys),
  };
});

vi.mock('@/components/ReportDetail', () => ({ ReportDetail: () => null }));

const TARGET_PUBKEY = 'd'.repeat(64);

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
    if (url.includes('/api/reports/resolved')) return jsonResponse(EMPTY_RESOLVED_PAGE);
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

  describe('over time', () => {
    const rpcCalls = (method: string) =>
      (fetch as unknown as MockInstance).mock.calls.filter(([input, init]) => {
        const url = String(input instanceof Request ? input.url : input);
        return url.includes('/api/relay-rpc') && String(init?.body ?? '').includes(`"${method}"`);
      }).length;

    afterEach(() => vi.useRealTimers());

    it('waits a minute before re-requesting either ban list', async () => {
      vi.useFakeTimers();
      await act(async () => { renderQueue(); });
      expect(rpcCalls('listbannedpubkeys')).toBe(1);
      expect(rpcCalls('listbannedevents')).toBe(1);

      await act(async () => { await vi.advanceTimersByTimeAsync(59_999); });
      expect(rpcCalls('listbannedpubkeys')).toBe(1);
      expect(rpcCalls('listbannedevents')).toBe(1);

      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(rpcCalls('listbannedpubkeys')).toBe(2);
      expect(rpcCalls('listbannedevents')).toBe(2);
    });
  });
});
