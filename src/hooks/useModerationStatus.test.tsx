// ABOUTME: Tests for useModerationStatus hook
// ABOUTME: Verifies ban/delete status queries via NIP-86 RPC

import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { AppContext, type AppContextType } from '@/contexts/AppContext';
import { useModerationStatus } from './useModerationStatus';

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  const appContext: AppContextType = {
    config: {
      theme: 'dark',
      relayUrl: 'wss://relay.test.com',
      apiUrl: 'https://api.test.com',
    },
    updateConfig: vi.fn(),
  };

  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <AppContext.Provider value={appContext}>
        <QueryClientProvider client={queryClient}>
          {children}
        </QueryClientProvider>
      </AppContext.Provider>
    );
  };
}

// Helper to mock RPC responses based on method
function mockRpcResponses(opts: {
  bannedPubkeys?: string[];
  bannedEvents?: Array<{ id: string; reason?: string }>;
} = {}) {
  mockFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(init.body as string) : {};

    if (body.method === 'listbannedpubkeys') {
      return {
        ok: true,
        json: async () => ({
          success: true,
          result: opts.bannedPubkeys || [],
        }),
      };
    }

    if (body.method === 'listbannedevents') {
      return {
        ok: true,
        json: async () => ({
          success: true,
          result: opts.bannedEvents || [],
        }),
      };
    }

    return { ok: true, json: async () => ({ success: true, result: [] }) };
  });
}

describe('useModerationStatus', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('should return not banned when pubkey is not in banned list', async () => {
    mockRpcResponses({ bannedPubkeys: ['other_pubkey'] });

    const { result } = renderHook(
      () => useModerationStatus('my_pubkey', null),
      { wrapper: createWrapper() }
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.isBanned).toBe(false);
    expect(result.current.isDeleted).toBe(false);
  });

  it('should return banned when pubkey is in banned list', async () => {
    mockRpcResponses({ bannedPubkeys: ['target_pubkey'] });

    const { result } = renderHook(
      () => useModerationStatus('target_pubkey', null),
      { wrapper: createWrapper() }
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.isBanned).toBe(true);
  });

  it('should return deleted when event is in banned events list', async () => {
    mockRpcResponses({
      bannedEvents: [{ id: 'event123', reason: 'CSAM' }],
    });

    const { result } = renderHook(
      () => useModerationStatus(null, 'event123'),
      { wrapper: createWrapper() }
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.isDeleted).toBe(true);
    expect(result.current.deleteReason).toBe('CSAM');
  });

  it('should return not deleted when event is not banned', async () => {
    mockRpcResponses({ bannedEvents: [] });

    const { result } = renderHook(
      () => useModerationStatus(null, 'event456'),
      { wrapper: createWrapper() }
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.isDeleted).toBe(false);
    expect(result.current.deleteReason).toBeUndefined();
  });

  it('should handle both pubkey and event queries simultaneously', async () => {
    mockRpcResponses({
      bannedPubkeys: ['bad_pubkey'],
      bannedEvents: [{ id: 'bad_event', reason: 'Spam' }],
    });

    const { result } = renderHook(
      () => useModerationStatus('bad_pubkey', 'bad_event'),
      { wrapper: createWrapper() }
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.isBanned).toBe(true);
    expect(result.current.isDeleted).toBe(true);
    expect(result.current.deleteReason).toBe('Spam');
  });

  it('should return empty status when no pubkey or event provided', async () => {
    mockRpcResponses();

    const { result } = renderHook(
      () => useModerationStatus(null, null),
      { wrapper: createWrapper() }
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.isBanned).toBe(false);
    expect(result.current.isDeleted).toBe(false);
  });

  it('should handle API errors gracefully', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));

    const { result } = renderHook(
      () => useModerationStatus('some_pubkey', null),
      { wrapper: createWrapper() }
    );

    // Should eventually settle (catch block returns [])
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.isBanned).toBe(false);
  });

  it('should provide refetch function', async () => {
    mockRpcResponses({ bannedPubkeys: [] });

    const { result } = renderHook(
      () => useModerationStatus('pubkey1', null),
      { wrapper: createWrapper() }
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(typeof result.current.refetch).toBe('function');

    // Update the mock to return new data
    mockRpcResponses({ bannedPubkeys: ['pubkey1'] });

    // Call refetch
    result.current.refetch();

    await waitFor(() => expect(result.current.isBanned).toBe(true));
  });

  it('should normalize listBannedPubkeys string array to objects', async () => {
    // listBannedPubkeys in adminApi normalizes string[] to {pubkey: string}[]
    // The hook checks entry.pubkey === pubkey
    mockRpcResponses({ bannedPubkeys: ['exact_match_pubkey'] });

    const { result } = renderHook(
      () => useModerationStatus('exact_match_pubkey', null),
      { wrapper: createWrapper() }
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.isBanned).toBe(true);
  });
});
