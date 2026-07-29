import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { ApiError } from '@/lib/adminApi';

const { req, callRelayRpc } = vi.hoisted(() => ({ req: vi.fn(), callRelayRpc: vi.fn() }));

vi.mock('@/hooks/useNostr', () => ({ useNostr: () => ({ nostr: { req } }) }));

/** Queue one relay response per hop: events then EOSE (a completed read). */
function relayReturns(...hops: unknown[][]) {
  for (const events of hops) {
    req.mockImplementationOnce(async function* () {
      for (const e of events) yield ['EVENT', 'sub', e];
      yield ['EOSE', 'sub'];
    });
  }
}
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
const CASE_PUBKEY = 'd4'.repeat(32);

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
    relayReturns([report([['e', TARGET_ID], ['p', 'd4'.repeat(32)]])], [content(TARGET_ID)]);

    const { result } = render();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual({ status: 'found', event: content(TARGET_ID), banned: false });
    expect(req).toHaveBeenNthCalledWith(1, [{ ids: [REPORT_ID] }], expect.anything());
    expect(req).toHaveBeenNthCalledWith(2, [{ ids: [TARGET_ID] }], expect.anything());
  });

  it('falls back to getbannedevent when the target is not publicly readable', async () => {
    relayReturns([report([['e', TARGET_ID]])], []);
    callRelayRpc.mockResolvedValueOnce(content(TARGET_ID));

    const { result } = render();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual({ status: 'found', event: content(TARGET_ID), banned: true });
    expect(callRelayRpc).toHaveBeenCalledWith('getbannedevent', [TARGET_ID]);
  });

  it('reports an account-level report instead of inventing a missing post', async () => {
    relayReturns([report([['p', 'd4'.repeat(32)]])]);

    const { result } = render();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ status: 'account_level' });
    expect(callRelayRpc).not.toHaveBeenCalled();
  });

  it('reports a missing report event distinctly from a missing target', async () => {
    relayReturns([]);

    const { result } = render();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ status: 'report_missing' });
  });

  it('treats "not banned" as a genuine negative, not an error', async () => {
    // Verified end to end against production, status code included: the relay
    // answers success:false with "Event not found or not banned" and the worker
    // returns that as HTTP 400, so the ApiError DOES carry a status.
    relayReturns([report([['e', TARGET_ID]])], []);
    callRelayRpc.mockRejectedValueOnce(new ApiError('Event not found or not banned', 400, 'Bad Request'));

    const { result } = render();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ status: 'target_missing', targetEventId: TARGET_ID });
  });

  it('surfaces a transport failure as an error rather than a missing target', async () => {
    // An expired CF Access session must never render as "the post was deleted".
    relayReturns([report([['e', TARGET_ID]])], []);
    callRelayRpc.mockRejectedValueOnce(new ApiError('Forbidden', 403, 'Forbidden'));

    const { result } = render();
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
  });

  it('refuses to show a target authored by someone other than the case subject', async () => {
    // NIP-56 does not require the reported event to be authored by the reported
    // pubkey, and case creation does not check it, so a crafted report could put
    // a stranger's video in front of a moderator as this account's content.
    const stranger = 'ee'.repeat(32);
    const foreign = { ...content(TARGET_ID), pubkey: stranger };
    relayReturns([report([['e', TARGET_ID]])], [foreign]);

    const { result } = renderHook(() => useReportedEvent(REPORT_ID, CASE_PUBKEY), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ status: 'target_foreign', targetEventId: TARGET_ID, authorPubkey: stranger });
  });

  it('shows a target authored by the case subject', async () => {
    const own = { ...content(TARGET_ID), pubkey: CASE_PUBKEY };
    relayReturns([report([['e', TARGET_ID]])], [own]);

    const { result } = renderHook(() => useReportedEvent(REPORT_ID, CASE_PUBKEY), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ status: 'found', event: own, banned: false });
  });

  it('errors rather than reporting a missing report when the relay closes the read', async () => {
    // A relay CLOSED resolves NPool.query to [] with no abort and no throw, which
    // would otherwise render as "the report event is no longer on the relay".
    req.mockImplementationOnce(async function* () {
      yield ['CLOSED', 'sub', 'error: could not complete query'];
    });

    const { result } = render();
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
  });

  it('does not interpret a non-report event as a report', async () => {
    relayReturns([{ ...content(REPORT_ID), kind: 1, tags: [['e', TARGET_ID]] }]);

    const { result } = render();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ status: 'report_missing' });
  });

  it('does not run without a report id', () => {
    const { result } = renderHook(() => useReportedEvent(undefined), { wrapper });
    expect(result.current.fetchStatus).toBe('idle');
    expect(req).not.toHaveBeenCalled();
  });
});
