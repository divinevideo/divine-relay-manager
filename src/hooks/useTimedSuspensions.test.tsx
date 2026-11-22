// ABOUTME: Pins the three states a screen reads from the timed-suspensions list:
// ABOUTME: loading (undefined), answered without this account (null), and unreadable (isError).
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const listTimedSuspensions = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/useAdminApi', () => ({
  useAdminApi: () => ({ listTimedSuspensions }),
  useApiUrl: () => 'https://api.example',
}));

import { useTimedSuspension, useTimedSuspensions, TIMED_SUSPENSIONS_KEY } from './useTimedSuspensions';

const PK = 'ab'.repeat(32);
const record = { pubkey: PK, endsAt: '2026-11-24T14:00:00.000Z', status: 'active' as const, setBy: null, setAt: '2026-11-20T00:00:00.000Z', changedAt: null };

let client: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  listTimedSuspensions.mockReset();
  // The hook sets its own retry (1); keep delays out of the test.
  client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
});

describe('useTimedSuspension', () => {
  it('is undefined while the list is loading, then the record', async () => {
    listTimedSuspensions.mockResolvedValue({ suspensions: [record], autoLift: true });
    const { result } = renderHook(() => useTimedSuspension(PK), { wrapper });
    expect(result.current.record).toBeUndefined();
    expect(result.current.isLoading).toBe(true);
    await waitFor(() => expect(result.current.record).toEqual(record));
    expect(result.current.isError).toBe(false);
  });

  it('is null once the list has answered without this pubkey', async () => {
    listTimedSuspensions.mockResolvedValue({ suspensions: [{ ...record, pubkey: 'cd'.repeat(32) }], autoLift: true });
    const { result } = renderHook(() => useTimedSuspension(PK), { wrapper });
    await waitFor(() => expect(result.current.record).toBeNull());
  });

  it('matches the pubkey case-insensitively', async () => {
    listTimedSuspensions.mockResolvedValue({ suspensions: [record], autoLift: true });
    const { result } = renderHook(() => useTimedSuspension(PK.toUpperCase()), { wrapper });
    await waitFor(() => expect(result.current.record).toEqual(record));
  });

  it('reports isError, with no record, when the read fails and there is no data', async () => {
    listTimedSuspensions.mockRejectedValue(new Error('down'));
    const { result } = renderHook(() => useTimedSuspension(PK), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.record).toBeUndefined();
    expect(result.current.isLoading).toBe(false);
  });

  it('is not an error when a refetch fails but earlier data exists', async () => {
    listTimedSuspensions.mockResolvedValueOnce({ suspensions: [record], autoLift: true });
    const { result } = renderHook(() => useTimedSuspension(PK), { wrapper });
    await waitFor(() => expect(result.current.record).toEqual(record));
    listTimedSuspensions.mockRejectedValue(new Error('down'));
    await client.refetchQueries({ queryKey: TIMED_SUSPENSIONS_KEY });
    await waitFor(() => expect(client.getQueryState([...TIMED_SUSPENSIONS_KEY, 'https://api.example'])?.fetchStatus).toBe('idle'));
    expect(result.current.isError).toBe(false);
    expect(result.current.record).toEqual(record);
    // Quiet for the end line, but flagged: a decision must not rest on that older copy.
    expect(result.current.refreshFailed).toBe(true);
  });

  it('does not flag refreshFailed for a read that answered', async () => {
    listTimedSuspensions.mockResolvedValue({ suspensions: [record], autoLift: true });
    const { result } = renderHook(() => useTimedSuspension(PK), { wrapper });
    await waitFor(() => expect(result.current.record).toEqual(record));
    expect(result.current.refreshFailed).toBe(false);
  });

  // The app's default retry is higher; a dead list should surface its error after one retry.
  it('retries a failed read once', async () => {
    listTimedSuspensions.mockRejectedValue(new Error('down'));
    const { result } = renderHook(() => useTimedSuspension(PK), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(listTimedSuspensions).toHaveBeenCalledTimes(2);
  });

  it('says whether automatic lifting is on, as the worker answered', async () => {
    listTimedSuspensions.mockResolvedValue({ suspensions: [record], autoLift: true });
    const { result } = renderHook(() => useTimedSuspension(PK), { wrapper });
    await waitFor(() => expect(result.current.record).toEqual(record));
    expect(result.current.autoLift).toBe(true);
  });

  it('reads automatic lifting as off when it is off, unknown, or the list has not answered', async () => {
    listTimedSuspensions.mockReturnValueOnce(new Promise(() => {}));
    const loading = renderHook(() => useTimedSuspension(PK), { wrapper });
    expect(loading.result.current.autoLift).toBe(false);
    loading.unmount();

    for (const answer of [{ suspensions: [record], autoLift: false }, { suspensions: [record] }]) {
      client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
      listTimedSuspensions.mockResolvedValue(answer);
      const { result } = renderHook(() => useTimedSuspension(PK), { wrapper });
      await waitFor(() => expect(result.current.record).toEqual(record));
      expect(result.current.autoLift).toBe(false);
    }
  });

  it('does not read the list for no pubkey', () => {
    const { result } = renderHook(() => useTimedSuspension(null), { wrapper });
    expect(result.current.record).toBeUndefined();
    expect(result.current.isLoading).toBe(false);
  });

  it('shares one read between callers', async () => {
    listTimedSuspensions.mockResolvedValue({ suspensions: [record], autoLift: true });
    const a = renderHook(() => useTimedSuspensions(), { wrapper });
    const b = renderHook(() => useTimedSuspension(PK), { wrapper });
    await waitFor(() => expect(b.result.current.record).toEqual(record));
    expect(a.result.current.data).toEqual({ suspensions: [record], autoLift: true });
    expect(listTimedSuspensions).toHaveBeenCalledTimes(1);
  });
});
