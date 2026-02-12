// ABOUTME: Tests for useDecisionLog hook
// ABOUTME: Verifies decision fetching, status flags, and auto-hide logic

import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { AppContext, type AppContextType } from '@/contexts/AppContext';
import { useDecisionLog } from './useDecisionLog';

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

function mockDecisions(decisions: Array<{ action: string; [key: string]: unknown }>) {
  mockFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ success: true, decisions }),
  });
}

describe('useDecisionLog', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('should fetch decisions for a target', async () => {
    mockDecisions([
      { action: 'ban_user', target_id: 'target1', created_at: '2026-01-01' },
    ]);

    const { result } = renderHook(
      () => useDecisionLog('target1'),
      { wrapper: createWrapper() }
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.decisions).toHaveLength(1);
    expect(result.current.hasDecisions).toBe(true);
    expect(result.current.latestDecision).toEqual(
      expect.objectContaining({ action: 'ban_user' })
    );
  });

  it('should not fetch when targetId is null', async () => {
    const { result } = renderHook(
      () => useDecisionLog(null),
      { wrapper: createWrapper() }
    );

    // Should not be loading since query is disabled
    expect(result.current.isLoading).toBe(false);
    expect(result.current.decisions).toEqual([]);
    expect(result.current.hasDecisions).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('should not fetch when targetId is undefined', async () => {
    const { result } = renderHook(
      () => useDecisionLog(undefined),
      { wrapper: createWrapper() }
    );

    expect(result.current.isLoading).toBe(false);
    expect(result.current.decisions).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('should return empty state when no decisions exist', async () => {
    mockDecisions([]);

    const { result } = renderHook(
      () => useDecisionLog('clean_target'),
      { wrapper: createWrapper() }
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.hasDecisions).toBe(false);
    expect(result.current.latestDecision).toBeUndefined();
    expect(result.current.isBanned).toBe(false);
    expect(result.current.isDeleted).toBe(false);
    expect(result.current.isMediaBlocked).toBe(false);
    expect(result.current.isReviewed).toBe(false);
    expect(result.current.isFalsePositive).toBe(false);
  });

  // =========================================================================
  // Action type detection
  // =========================================================================

  it('should detect isBanned from ban_user action', async () => {
    mockDecisions([{ action: 'ban_user' }]);

    const { result } = renderHook(
      () => useDecisionLog('target1'),
      { wrapper: createWrapper() }
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.isBanned).toBe(true);
  });

  it('should detect isBanned from ban action (legacy)', async () => {
    mockDecisions([{ action: 'ban' }]);

    const { result } = renderHook(
      () => useDecisionLog('target1'),
      { wrapper: createWrapper() }
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.isBanned).toBe(true);
  });

  it('should detect isDeleted from delete_event action', async () => {
    mockDecisions([{ action: 'delete_event' }]);

    const { result } = renderHook(
      () => useDecisionLog('target1'),
      { wrapper: createWrapper() }
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.isDeleted).toBe(true);
  });

  it('should detect isDeleted from delete action (legacy)', async () => {
    mockDecisions([{ action: 'delete' }]);

    const { result } = renderHook(
      () => useDecisionLog('target1'),
      { wrapper: createWrapper() }
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.isDeleted).toBe(true);
  });

  it('should detect isMediaBlocked from block_media action', async () => {
    mockDecisions([{ action: 'block_media' }]);

    const { result } = renderHook(
      () => useDecisionLog('target1'),
      { wrapper: createWrapper() }
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.isMediaBlocked).toBe(true);
  });

  it('should detect isMediaBlocked from PERMANENT_BAN action', async () => {
    mockDecisions([{ action: 'PERMANENT_BAN' }]);

    const { result } = renderHook(
      () => useDecisionLog('target1'),
      { wrapper: createWrapper() }
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.isMediaBlocked).toBe(true);
  });

  it('should detect isReviewed from reviewed action', async () => {
    mockDecisions([{ action: 'reviewed' }]);

    const { result } = renderHook(
      () => useDecisionLog('target1'),
      { wrapper: createWrapper() }
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.isReviewed).toBe(true);
  });

  it('should detect isReviewed from mark_ok action (legacy)', async () => {
    mockDecisions([{ action: 'mark_ok' }]);

    const { result } = renderHook(
      () => useDecisionLog('target1'),
      { wrapper: createWrapper() }
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.isReviewed).toBe(true);
  });

  it('should detect isFalsePositive from false_positive action', async () => {
    mockDecisions([{ action: 'false_positive' }]);

    const { result } = renderHook(
      () => useDecisionLog('target1'),
      { wrapper: createWrapper() }
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.isFalsePositive).toBe(true);
  });

  it('should detect isFalsePositive from false-positive action (kebab)', async () => {
    mockDecisions([{ action: 'false-positive' }]);

    const { result } = renderHook(
      () => useDecisionLog('target1'),
      { wrapper: createWrapper() }
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.isFalsePositive).toBe(true);
  });

  // =========================================================================
  // Auto-hide logic
  // =========================================================================

  it('should detect isAutoHidden', async () => {
    mockDecisions([{ action: 'auto_hidden' }]);

    const { result } = renderHook(
      () => useDecisionLog('target1'),
      { wrapper: createWrapper() }
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.isAutoHidden).toBe(true);
  });

  it('should set isPendingReview when auto-hidden but not confirmed or restored', async () => {
    mockDecisions([{ action: 'auto_hidden' }]);

    const { result } = renderHook(
      () => useDecisionLog('target1'),
      { wrapper: createWrapper() }
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.isAutoHidden).toBe(true);
    expect(result.current.isPendingReview).toBe(true);
    expect(result.current.isAutoHideConfirmed).toBe(false);
    expect(result.current.isAutoHideRestored).toBe(false);
  });

  it('should clear isPendingReview when auto_hide_confirmed', async () => {
    mockDecisions([
      { action: 'auto_hidden' },
      { action: 'auto_hide_confirmed' },
    ]);

    const { result } = renderHook(
      () => useDecisionLog('target1'),
      { wrapper: createWrapper() }
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.isAutoHidden).toBe(true);
    expect(result.current.isAutoHideConfirmed).toBe(true);
    expect(result.current.isPendingReview).toBe(false);
  });

  it('should clear isPendingReview when auto_hide_restored', async () => {
    mockDecisions([
      { action: 'auto_hidden' },
      { action: 'auto_hide_restored' },
    ]);

    const { result } = renderHook(
      () => useDecisionLog('target1'),
      { wrapper: createWrapper() }
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.isAutoHidden).toBe(true);
    expect(result.current.isAutoHideRestored).toBe(true);
    expect(result.current.isPendingReview).toBe(false);
  });

  // =========================================================================
  // Multiple decision types
  // =========================================================================

  it('should detect multiple action types in decision history', async () => {
    mockDecisions([
      { action: 'auto_hidden' },
      { action: 'delete_event' },
      { action: 'ban_user' },
    ]);

    const { result } = renderHook(
      () => useDecisionLog('target1'),
      { wrapper: createWrapper() }
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.isBanned).toBe(true);
    expect(result.current.isDeleted).toBe(true);
    expect(result.current.isAutoHidden).toBe(true);
    expect(result.current.latestDecision).toEqual(
      expect.objectContaining({ action: 'auto_hidden' })
    );
  });

  it('should provide refetch function', async () => {
    mockDecisions([]);

    const { result } = renderHook(
      () => useDecisionLog('target1'),
      { wrapper: createWrapper() }
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(typeof result.current.refetch).toBe('function');
  });
});
