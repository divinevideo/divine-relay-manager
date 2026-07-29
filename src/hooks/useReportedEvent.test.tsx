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

const render = () => renderHook(() => useReportedEvent(REPORT_ID, undefined), { wrapper });

// Targeted: resetAllMocks would also clear the shared jsdom mocks in
// src/test/setup.ts (matchMedia, ResizeObserver), which any component render
// added to this file would then fail on.
beforeEach(() => { req.mockReset(); callRelayRpc.mockReset(); });

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
    expect(result.current.data).toEqual({ status: 'target_foreign', event: foreign, banned: false });
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
    // Distinct from report_missing: the event IS on the relay, it just is not a report.
    expect(result.current.data).toEqual({ status: 'not_a_report' });
  });

  it('labels a banned target authored by someone else, and marks it banned', async () => {
    // The banned path needs the same author check as the plain relay path.
    const stranger = 'ee'.repeat(32);
    relayReturns([report([['e', TARGET_ID]])], []);
    callRelayRpc.mockResolvedValueOnce({ ...content(TARGET_ID), pubkey: stranger });

    const { result } = renderHook(() => useReportedEvent(REPORT_ID, CASE_PUBKEY), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toMatchObject({ status: 'target_foreign', banned: true });
  });

  it('still tries the banned lookup when another tagged event was readable', async () => {
    // Regression: returning early on any readable event silently disabled the
    // banned fallback, which is the capability this feature exists for.
    const OTHER = 'cc'.repeat(32);
    const strangerRoot = { ...content(OTHER), pubkey: 'ee'.repeat(32) };
    const ownBanned = { ...content(TARGET_ID), pubkey: CASE_PUBKEY };
    relayReturns([report([['e', TARGET_ID], ['e', OTHER]])], [strangerRoot]);
    callRelayRpc.mockResolvedValueOnce(ownBanned);

    const { result } = renderHook(() => useReportedEvent(REPORT_ID, CASE_PUBKEY), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(callRelayRpc).toHaveBeenCalledWith('getbannedevent', [TARGET_ID]);
    expect(result.current.data).toEqual({ status: 'found', event: ownBanned, banned: true });
  });

  it('names the first tagged event, not whichever the relay returned first', async () => {
    // Relay arrival order is arbitrary; the pane must agree with any other code
    // that treats the first e tag as the target.
    const FIRST = 'cc'.repeat(32);
    const first = { ...content(FIRST), pubkey: 'ee'.repeat(32) };
    const second = { ...content(TARGET_ID), pubkey: 'ff'.repeat(32) };
    relayReturns([report([['e', FIRST], ['e', TARGET_ID]])], [second, first]);

    const { result } = renderHook(() => useReportedEvent(REPORT_ID, CASE_PUBKEY), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    // Identity, not just status: without it the ordering guard is unobservable.
    expect(result.current.data).toEqual({ status: 'target_foreign', event: first, banned: false });
  });

  it('ignores a malformed banned response instead of crashing on it', async () => {
    // Without the shape guard this reaches target_foreign with an undefined
    // author, which the pane then calls .slice() on during render.
    relayReturns([report([['e', TARGET_ID]])], []);
    callRelayRpc.mockResolvedValueOnce({ notAnEvent: true });

    const { result } = renderHook(() => useReportedEvent(REPORT_ID, CASE_PUBKEY), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ status: 'target_missing', targetEventId: TARGET_ID });
  });

  it('matches the case subject regardless of hex casing', async () => {
    const upper = { ...content(TARGET_ID), pubkey: CASE_PUBKEY.toUpperCase() };
    relayReturns([report([['e', TARGET_ID]])], [upper]);

    const { result } = renderHook(() => useReportedEvent(REPORT_ID, CASE_PUBKEY), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toMatchObject({ status: 'found', banned: false });
  });

  it('prefers a tagged event this account authored over another tagged event', async () => {
    // A threaded reply tags its root too, so the first e tag is not always the
    // reported post. Declaring it foreign would hide real evidence.
    const root = { ...content('ff'.repeat(32)), pubkey: 'ee'.repeat(32) };
    const own = { ...content(TARGET_ID), pubkey: CASE_PUBKEY };
    relayReturns([report([['e', 'ff'.repeat(32)], ['e', TARGET_ID]])], [root, own]);

    const { result } = renderHook(() => useReportedEvent(REPORT_ID, CASE_PUBKEY), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ status: 'found', event: own, banned: false });
  });

  it('does not claim an account-level report when the e tag is unparseable', async () => {
    relayReturns([report([['e', 'not-hex']])]);

    const { result } = render();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ status: 'target_unreadable' });
  });

  it('does not read a management-endpoint 404 as "not banned"', async () => {
    // The worker collapses every RPC failure to HTTP 400 and renders a relay
    // transport failure as "Relay error: 404 Not Found". Treating that as a
    // negative would tell a moderator the post was deleted during an outage.
    relayReturns([report([['e', TARGET_ID]])], []);
    callRelayRpc.mockRejectedValueOnce(new ApiError('Relay error: 404 Not Found', 400, 'Bad Request'));

    const { result } = render();
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
  });

  it('caps how many tagged ids it will chase, so a hostile report cannot fan out', async () => {
    // Each unresolved id costs a signed management request. The tag list comes
    // from an untrusted event, so it must be bounded.
    const many = Array.from({ length: 60 }, (_, i) => ['e', i.toString(16).padStart(2, '0').repeat(32)]);
    relayReturns([report(many)], []);
    callRelayRpc.mockRejectedValue(new ApiError('Event not found or not banned', 400, 'Bad Request'));

    const { result } = renderHook(() => useReportedEvent(REPORT_ID, CASE_PUBKEY), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(callRelayRpc.mock.calls.length).toBeLessThanOrEqual(16);
  });

  it('does not issue duplicate lookups for a repeated tag', async () => {
    relayReturns([report([['e', TARGET_ID], ['e', TARGET_ID], ['e', TARGET_ID]])], []);
    callRelayRpc.mockRejectedValue(new ApiError('Event not found or not banned', 400, 'Bad Request'));

    const { result } = renderHook(() => useReportedEvent(REPORT_ID, CASE_PUBKEY), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(callRelayRpc).toHaveBeenCalledTimes(1);
  });

  it('names the earliest tag even when a later one is readable and the earlier is banned', async () => {
    // Tag order must hold across the readable/banned boundary, or the pane names
    // a different event than the one the first tag points at.
    const FIRST = 'cc'.repeat(32);
    const bannedFirst = { ...content(FIRST), pubkey: 'ee'.repeat(32) };
    const readableSecond = { ...content(TARGET_ID), pubkey: 'ff'.repeat(32) };
    relayReturns([report([['e', FIRST], ['e', TARGET_ID]])], [readableSecond]);
    callRelayRpc.mockResolvedValueOnce(bannedFirst);

    const { result } = renderHook(() => useReportedEvent(REPORT_ID, CASE_PUBKEY), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ status: 'target_foreign', event: bannedFirst, banned: true });
  });

  it('keys the query by the case subject, so two cases cannot share a cached answer', async () => {
    // One shared client, or each render gets its own cache and the key cannot
    // be observed at all.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const shared = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const own = { ...content(TARGET_ID), pubkey: CASE_PUBKEY };
    relayReturns([report([['e', TARGET_ID]])], [own]);

    const first = renderHook(() => useReportedEvent(REPORT_ID, CASE_PUBKEY), { wrapper: shared });
    await waitFor(() => expect(first.result.current.isSuccess).toBe(true));
    const callsAfterFirst = req.mock.calls.length;

    // Same report id, different subject: the author check differs, so the answer
    // must be recomputed rather than served from the first case's entry.
    relayReturns([report([['e', TARGET_ID]])], [own]);
    const second = renderHook(() => useReportedEvent(REPORT_ID, 'ab'.repeat(32)), { wrapper: shared });
    await waitFor(() => expect(second.result.current.isSuccess).toBe(true));

    expect(req.mock.calls.length).toBeGreaterThan(callsAfterFirst);
    expect(second.result.current.data).toMatchObject({ status: 'target_foreign' });
  });

  it('keeps a retrieved post when a later unrelated lookup fails', async () => {
    // Regression: running the loop to completion exposed an already-settled
    // answer to an unrelated tag's failure, so the moderator lost content we
    // had in hand and saw a relay error instead.
    const OTHER = 'cc'.repeat(32);
    const ownBanned = { ...content(TARGET_ID), pubkey: CASE_PUBKEY };
    relayReturns([report([['e', TARGET_ID], ['e', OTHER]])], []);
    callRelayRpc
      .mockResolvedValueOnce(ownBanned)
      .mockRejectedValueOnce(new ApiError('Internal Server Error', 500, 'ISE'));

    const { result } = renderHook(() => useReportedEvent(REPORT_ID, CASE_PUBKEY), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ status: 'found', event: ownBanned, banned: true });
    // The second lookup should never have been issued.
    expect(callRelayRpc).toHaveBeenCalledTimes(1);
  });

  it('keeps a foreign target already in hand when a later lookup fails', async () => {
    // The early return only covers subject-owned events, so without the break a
    // later tag's failure still discarded a foreign target. This pane
    // deliberately shows those, labelled, so losing one hides real evidence.
    const OTHER = 'cc'.repeat(32);
    const strangerPost = { ...content(TARGET_ID), pubkey: 'ee'.repeat(32) };
    relayReturns([report([['e', TARGET_ID], ['e', OTHER]])], [strangerPost]);
    callRelayRpc.mockRejectedValueOnce(new ApiError('Internal Server Error', 500, 'ISE'));

    const { result } = renderHook(() => useReportedEvent(REPORT_ID, CASE_PUBKEY), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ status: 'target_foreign', event: strangerPost, banned: false });
  });

  it('still reports an error when a lookup fails and nothing was retrieved', async () => {
    // The counterpart: with nothing in hand, absence must not be asserted.
    relayReturns([report([['e', TARGET_ID]])], []);
    callRelayRpc.mockRejectedValueOnce(new ApiError('Internal Server Error', 500, 'ISE'));

    const { result } = renderHook(() => useReportedEvent(REPORT_ID, CASE_PUBKEY), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });

  it('rejects a banned response for a different event than the one requested', async () => {
    relayReturns([report([['e', TARGET_ID]])], []);
    callRelayRpc.mockResolvedValueOnce({ ...content('cc'.repeat(32)), pubkey: CASE_PUBKEY });

    const { result } = renderHook(() => useReportedEvent(REPORT_ID, CASE_PUBKEY), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ status: 'target_missing', targetEventId: TARGET_ID });
  });

  it('picks the earliest subject-owned tag, not the last', async () => {
    const FIRST = 'cc'.repeat(32);
    const firstOwn = { ...content(FIRST), pubkey: CASE_PUBKEY };
    const secondOwn = { ...content(TARGET_ID), pubkey: CASE_PUBKEY };
    relayReturns([report([['e', FIRST], ['e', TARGET_ID]])], [secondOwn, firstOwn]);

    const { result } = renderHook(() => useReportedEvent(REPORT_ID, CASE_PUBKEY), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ status: 'found', event: firstOwn, banned: false });
  });

  it('stops issuing lookups once the query has been cancelled', async () => {
    // Unmounting cancels the query and aborts its signal. callRelayRpc takes no
    // signal and can run for 30s, so without the in-loop check the remaining ids
    // keep costing signed requests after the moderator has moved on.
    const A = 'cc'.repeat(32);
    const B = 'dd'.repeat(32);
    relayReturns([report([['e', A], ['e', B]])], []);
    let settleFirst: () => void = () => {};
    callRelayRpc.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          settleFirst = () => reject(new ApiError('Event not found or not banned', 400, 'Bad Request'));
        }),
    );

    const { unmount } = renderHook(() => useReportedEvent(REPORT_ID, CASE_PUBKEY), { wrapper });
    await waitFor(() => expect(callRelayRpc).toHaveBeenCalledTimes(1));

    unmount();
    settleFirst();
    await new Promise((r) => setTimeout(r, 20));

    expect(callRelayRpc).toHaveBeenCalledTimes(1);
  });

  it('does not run without a report id', () => {
    const { result } = renderHook(() => useReportedEvent(undefined, undefined), { wrapper });
    expect(result.current.fetchStatus).toBe('idle');
    expect(req).not.toHaveBeenCalled();
  });
});
