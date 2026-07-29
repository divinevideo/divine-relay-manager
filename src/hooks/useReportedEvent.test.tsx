import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { ApiError } from '@/lib/adminApi';

const { query, callRelayRpc } = vi.hoisted(() => ({ query: vi.fn(), callRelayRpc: vi.fn() }));

vi.mock('@/hooks/useNostr', () => ({ useNostr: () => ({ nostr: { query } }) }));
vi.mock('@/hooks/useAdminApi', () => ({
  useAdminApi: () => ({ callRelayRpc }),
  useApiUrl: () => 'https://api.test',
}));
vi.mock('@/hooks/useAppContext', () => ({
  useAppContext: () => ({ config: { relayUrl: 'wss://relay.test' } }),
}));

import { useReportedEvent } from './useReportedEvent';

const REPORT_ID = 'a1'.repeat(32);
const TARGET_ID = 'b2'.repeat(32);

function report(tags: string[][]) {
  return { id: REPORT_ID, pubkey: 'c3'.repeat(32), created_at: 1, kind: 1984, tags, content: 'spam', sig: '' };
}
function content(id: string) {
  return { id, pubkey: 'd4'.repeat(32), created_at: 2, kind: 34235, tags: [], content: 'clip', sig: '' };
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const render = () => renderHook(() => useReportedEvent(REPORT_ID), { wrapper });

beforeEach(() => vi.clearAllMocks());

describe('useReportedEvent', () => {
  it('resolves the reported content through the report, not the report itself', async () => {
    // report_id identifies the kind-1984 report; the content is in its `e` tag.
    query
      .mockResolvedValueOnce([report([['e', TARGET_ID], ['p', 'd4'.repeat(32)]])])
      .mockResolvedValueOnce([content(TARGET_ID)]);

    const { result } = render();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual({ status: 'found', event: content(TARGET_ID), banned: false });
    expect(query).toHaveBeenNthCalledWith(1, [{ ids: [REPORT_ID] }], expect.anything());
    expect(query).toHaveBeenNthCalledWith(2, [{ ids: [TARGET_ID] }], expect.anything());
  });

  it('falls back to getbannedevent when the target is not publicly readable', async () => {
    query
      .mockResolvedValueOnce([report([['e', TARGET_ID]])])
      .mockResolvedValueOnce([]);
    callRelayRpc.mockResolvedValueOnce(content(TARGET_ID));

    const { result } = render();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual({ status: 'found', event: content(TARGET_ID), banned: true });
    expect(callRelayRpc).toHaveBeenCalledWith('getbannedevent', [TARGET_ID]);
  });

  it('reports an account-level report instead of inventing a missing post', async () => {
    query.mockResolvedValueOnce([report([['p', 'd4'.repeat(32)]])]);

    const { result } = render();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ status: 'account_level' });
    expect(callRelayRpc).not.toHaveBeenCalled();
  });

  it('reports a missing report event distinctly from a missing target', async () => {
    query.mockResolvedValueOnce([]);

    const { result } = render();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ status: 'report_missing' });
  });

  it('treats "not banned" as a genuine negative, not an error', async () => {
    // Verified against the live relay: getbannedevent answers success:false with
    // "Event not found or not banned", which callRelayRpc raises as an ApiError
    // carrying no HTTP status.
    query
      .mockResolvedValueOnce([report([['e', TARGET_ID]])])
      .mockResolvedValueOnce([]);
    callRelayRpc.mockRejectedValueOnce(new ApiError('Event not found or not banned'));

    const { result } = render();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ status: 'target_missing', targetEventId: TARGET_ID });
  });

  it('surfaces a transport failure as an error rather than a missing target', async () => {
    // An expired CF Access session must never render as "the post was deleted".
    query
      .mockResolvedValueOnce([report([['e', TARGET_ID]])])
      .mockResolvedValueOnce([]);
    callRelayRpc.mockRejectedValueOnce(new ApiError('Forbidden', 403, 'Forbidden'));

    const { result } = render();
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
  });

  it('does not run without a report id', () => {
    const { result } = renderHook(() => useReportedEvent(undefined), { wrapper });
    expect(result.current.fetchStatus).toBe('idle');
    expect(query).not.toHaveBeenCalled();
  });
});
