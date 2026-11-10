import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
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

  it('names the newest handling decision, not a failed auto-hide logged after it', async () => {
    getDecisions.mockResolvedValue([
      { action: 'auto_hide_failed', moderator_pubkey: 'auto' },
      { action: 'reviewed', moderator_pubkey: 'e'.repeat(64) },
    ]);

    const { result } = renderHook(() => useDecisionLog('event-id'), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.latestDecision?.action).toBe('auto_hide_failed');
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

// Report detail ranks a recorded delete first among the reasons a post is
// gone, so a delete a moderator has since undone must not still count: a
// restored post that later goes missing for another reason (a suspension)
// would read as "Removed by Moderation".
describe('useDecisionLog delete state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('counts a delete', async () => {
    getDecisions.mockResolvedValue([{ action: 'delete_event' }]);
    const { result } = renderHook(() => useDecisionLog('event-id'), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.isDeleted).toBe(true);
  });

  it('does not count a delete followed by a restore', async () => {
    getDecisions.mockResolvedValue([{ action: 'restore_event' }, { action: 'delete_event' }]);
    const { result } = renderHook(() => useDecisionLog('event-id'), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.isDeleted).toBe(false);
  });

  it('counts a delete made after a restore', async () => {
    getDecisions.mockResolvedValue([{ action: 'delete_event' }, { action: 'restore_event' }, { action: 'delete_event' }]);
    const { result } = renderHook(() => useDecisionLog('event-id'), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.isDeleted).toBe(true);
  });
});

// ReportDetail reads isPending to tell "no decisions read yet" from "nothing
// recorded". A read held back offline is pending without fetching, so
// isLoading is false there and would let an unread log pass for an empty one.
describe('useDecisionLog read state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('stays pending while its first read is held back offline', async () => {
    onlineManager.setOnline(false);
    try {
      getDecisions.mockResolvedValue([]);
      const { result } = renderHook(() => useDecisionLog('event-id'), { wrapper });

      await waitFor(() => expect(result.current.isLoading).toBe(false));
      expect(result.current.isPending).toBe(true);
      expect(getDecisions).not.toHaveBeenCalled();
    } finally {
      onlineManager.setOnline(true);
    }
  });
});

// Reopen (#324) writes a dated `reopened` row instead of deleting the target's
// history. Only rows after the newest reopen say the report is handled, so the
// pane, the Reopen button and the queue agree. Rows come newest first.
describe('useDecisionLog reopen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not count handling from before the newest reopen', async () => {
    getDecisions.mockResolvedValue([
      { action: 'reopened', moderator_pubkey: null, created_at: '2026-11-09 00:03:20' },
      { action: 'ban_user', moderator_pubkey: 'e'.repeat(64), created_at: '2026-11-09 00:01:40' },
    ]);

    const { result } = renderHook(() => useDecisionLog('pubkey-id'), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.hasDecisions).toBe(true);
    expect(result.current.hasHandlingDecisions).toBe(false);
    expect(result.current.latestHandlingDecision).toBeUndefined();
    expect(result.current.isReopened).toBe(true);
  });

  it('counts handling recorded after the reopen', async () => {
    getDecisions.mockResolvedValue([
      { action: 'ban_user', moderator_pubkey: 'e'.repeat(64), created_at: '2026-11-09 00:05:00' },
      { action: 'reopened', moderator_pubkey: null, created_at: '2026-11-09 00:03:20' },
    ]);

    const { result } = renderHook(() => useDecisionLog('pubkey-id'), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.hasHandlingDecisions).toBe(true);
    expect(result.current.latestHandlingDecision?.action).toBe('ban_user');
    expect(result.current.isReopened).toBe(false);
  });

  // The newest reopen is the cutoff, not the oldest: handling between two
  // reopens was itself reopened.
  it('reads from the newest reopen when there are several', async () => {
    getDecisions.mockResolvedValue([
      { action: 'reopened', moderator_pubkey: null },
      { action: 'reviewed', moderator_pubkey: 'e'.repeat(64) },
      { action: 'reopened', moderator_pubkey: null },
      { action: 'ban_user', moderator_pubkey: 'e'.repeat(64) },
    ]);

    const { result } = renderHook(() => useDecisionLog('pubkey-id'), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.hasHandlingDecisions).toBe(false);
    expect(result.current.isReopened).toBe(true);
  });

  // A reopen is not a decision about the target, so it never names one.
  it('never names the reopen as the handling decision', async () => {
    getDecisions.mockResolvedValue([{ action: 'reopened', moderator_pubkey: null }]);

    const { result } = renderHook(() => useDecisionLog('event-id'), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.latestHandlingDecision).toBeUndefined();
    expect(result.current.isReopened).toBe(true);
  });

  it('is not reopened when no reopen was recorded', async () => {
    getDecisions.mockResolvedValue([{ action: 'reviewed', moderator_pubkey: 'e'.repeat(64) }]);

    const { result } = renderHook(() => useDecisionLog('event-id'), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.hasHandlingDecisions).toBe(true);
    expect(result.current.isReopened).toBe(false);
  });
});
