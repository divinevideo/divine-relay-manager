// ABOUTME: Pins which pubkeys the shared account-status query will look up. A report's
// ABOUTME: p tag is written by whoever filed it, so a non-hex value must never reach the worker.
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getAccountStatus = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/useAdminApi', () => ({
  useAdminApi: () => ({ getAccountStatus }),
  useApiUrl: () => 'https://api.example',
}));

import { useAccountStatus } from './useAccountStatus';
import { createQueryClient } from '@/lib/queryClient';

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const VALID = 'a'.repeat(64);

describe('useAccountStatus', () => {
  beforeEach(() => {
    getAccountStatus.mockReset();
    getAccountStatus.mockResolvedValue({ success: true, status: 'active' });
  });

  it('looks up a 64-hex pubkey', async () => {
    const { result } = renderHook(() => useAccountStatus(VALID), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getAccountStatus).toHaveBeenCalledExactlyOnceWith(VALID);
  });

  // Age review passes a case's pubkey, stored verbatim from the report's p tag.
  // encodeURIComponent leaves a bare '..' or '.' alone, and the URL parser then
  // collapses '/api/account-status/..' into '/api/'.
  it.each(['..', '.', '../info', 'abc', `${'a'.repeat(63)}g`, ''])(
    'never looks up %j',
    (pubkey) => {
      const { result } = renderHook(() => useAccountStatus(pubkey), { wrapper });

      expect(result.current.fetchStatus).toBe('idle');
      expect(getAccountStatus).not.toHaveBeenCalled();
    },
  );

  // refetch() runs the query function even while the query is disabled, and age
  // review's Retry button calls it.
  it('still refuses a non-hex pubkey when refetch is called on the disabled query', async () => {
    const { result } = renderHook(() => useAccountStatus('..'), { wrapper });

    // Read from what refetch resolves to: the hook only re-renders for the
    // fields it read, and this one reads none.
    const outcome = await result.current.refetch();

    expect(outcome.isError).toBe(true);
    expect(outcome.error?.message).toBe('Not a valid pubkey');
    expect(getAccountStatus).not.toHaveBeenCalled();
  });

  // The app's QueryClient (createQueryClient) keeps TanStack's default of 3 retries. A Retry on a
  // malformed pubkey must not spend them on a throw that can never succeed.
  it('fails a refetch on a non-hex pubkey at once, without retries, under the app defaults', async () => {
    const client = createQueryClient();
    const appWrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useAccountStatus('..'), { wrapper: appWrapper });

    const outcome = await result.current.refetch();

    expect(outcome.isError).toBe(true);
    expect(outcome.failureCount).toBe(1);
  });

  // A real lookup that fails can be transient, so it keeps the app's default retries.
  it('still retries a failed lookup for a valid pubkey under the app defaults', async () => {
    getAccountStatus.mockRejectedValue(new Error('network'));
    const client = createQueryClient();
    const appWrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useAccountStatus(VALID), { wrapper: appWrapper });

    await waitFor(() => expect(result.current.failureCount).toBe(1));
    // Still retrying: with retry off, this first failure would already be the error.
    expect(result.current.isError).toBe(false);
    expect(result.current.fetchStatus).toBe('fetching');
    client.clear();
  });

  // The worker accepts only lowercase hex.
  it('looks an uppercase pubkey up in lowercase', async () => {
    const { result } = renderHook(() => useAccountStatus(VALID.toUpperCase()), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getAccountStatus).toHaveBeenCalledExactlyOnceWith(VALID);
  });
});
