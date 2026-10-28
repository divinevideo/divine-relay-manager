import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getDecisions = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/useAdminApi', () => ({
  useAdminApi: () => ({ getDecisions }),
}));

import { useDecisionLog } from './useDecisionLog';

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('useDecisionLog auto-hide state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('offers pending-review controls for a newer unresolved auto-hide', async () => {
    getDecisions.mockResolvedValue([
      { action: 'auto_hide_unresolved' },
      { action: 'auto_hide_restored' },
    ]);

    const { result } = renderHook(() => useDecisionLog('event-id'), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.isAutoHidden).toBe(true);
    expect(result.current.isPendingReview).toBe(true);
    expect(result.current.isAutoHideRestored).toBe(false);
    expect(result.current.isAutoHideUnresolved).toBe(true);
  });

  it('does not call a hide unresolved once a newer auto-hide landed', async () => {
    getDecisions.mockResolvedValue([
      { action: 'auto_hidden' },
      { action: 'auto_hide_unresolved' },
    ]);

    const { result } = renderHook(() => useDecisionLog('event-id'), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.isPendingReview).toBe(true);
    expect(result.current.isAutoHideUnresolved).toBe(false);
  });

  it('does not reopen controls after a newer restore settles unresolved state', async () => {
    getDecisions.mockResolvedValue([
      { action: 'auto_hide_restored' },
      { action: 'auto_hide_unresolved' },
    ]);

    const { result } = renderHook(() => useDecisionLog('event-id'), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.isAutoHidden).toBe(false);
    expect(result.current.isPendingReview).toBe(false);
    expect(result.current.isAutoHideRestored).toBe(true);
  });

  it('keeps failed restore compensation pending without permitting confirmation', async () => {
    getDecisions.mockResolvedValue([{ action: 'auto_hide_restore_failed' }]);

    const { result } = renderHook(() => useDecisionLog('event-id'), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.isPendingReview).toBe(true);
    expect(result.current.isAutoHideRestoreFailed).toBe(true);
  });
});

describe('useDecisionLog handling decisions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not count a skipped or pending auto-hide as handling the report', async () => {
    getDecisions.mockResolvedValue([
      { action: 'auto_hide_skipped' },
      { action: 'auto_hide_pending' },
    ]);

    const { result } = renderHook(() => useDecisionLog('event-id'), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.hasDecisions).toBe(true);
    expect(result.current.hasHandlingDecisions).toBe(false);
  });

  // The worker logs a failed auto-hide when the relay refuses the hide, so the
  // content is still up and the report is still waiting for a moderator.
  it('does not count a failed auto-hide as handling the report', async () => {
    getDecisions.mockResolvedValue([
      { action: 'auto_hide_failed', moderator_pubkey: 'auto' },
    ]);

    const { result } = renderHook(() => useDecisionLog('event-id'), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.hasDecisions).toBe(true);
    expect(result.current.hasHandlingDecisions).toBe(false);
    expect(result.current.latestHandlingDecision).toBeUndefined();
  });

  it('counts a moderator decision beside a skipped auto-hide', async () => {
    getDecisions.mockResolvedValue([
      { action: 'reviewed' },
      { action: 'auto_hide_skipped' },
    ]);

    const { result } = renderHook(() => useDecisionLog('event-id'), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.hasHandlingDecisions).toBe(true);
  });

  it('names the newest handling decision, not a skip logged after it', async () => {
    getDecisions.mockResolvedValue([
      { action: 'auto_hide_skipped' },
      { action: 'reviewed' },
      { action: 'mark_ok' },
    ]);

    const { result } = renderHook(() => useDecisionLog('event-id'), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.latestDecision?.action).toBe('auto_hide_skipped');
    expect(result.current.latestHandlingDecision?.action).toBe('reviewed');
  });

  // The worker records 'auto' as the moderator on decisions it makes by
  // itself, such as opening an age-review case. No person handled the report.
  it('does not count a decision the worker made by itself as handling the report', async () => {
    getDecisions.mockResolvedValue([
      { action: 'age_review_case_created', moderator_pubkey: 'auto' },
    ]);

    const { result } = renderHook(() => useDecisionLog('pubkey-id'), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.hasDecisions).toBe(true);
    expect(result.current.hasHandlingDecisions).toBe(false);
    expect(result.current.latestHandlingDecision).toBeUndefined();
  });

  it("names a person's decision, not the worker's own logged after it", async () => {
    getDecisions.mockResolvedValue([
      { action: 'age_review_case_created', moderator_pubkey: 'auto' },
      { action: 'reviewed', moderator_pubkey: 'e'.repeat(64) },
    ]);

    const { result } = renderHook(() => useDecisionLog('pubkey-id'), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.latestHandlingDecision?.action).toBe('reviewed');
  });

  // The worker also writes 'auto' on a person's confirm or restore of an
  // auto-hide that came without a pubkey, and on its own hide. Those keep
  // counting as they always have.
  it.each(['auto_hidden', 'auto_hide_confirmed', 'auto_hide_restored'])(
    'still counts %s recorded with the worker as moderator',
    async (action) => {
      getDecisions.mockResolvedValue([{ action, moderator_pubkey: 'auto' }]);

      const { result } = renderHook(() => useDecisionLog('event-id'), { wrapper });
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      expect(result.current.hasHandlingDecisions).toBe(true);
      expect(result.current.latestHandlingDecision?.action).toBe(action);
    },
  );
});
