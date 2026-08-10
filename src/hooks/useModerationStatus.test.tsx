// ABOUTME: Pins that a verification which could not complete stays "unknown".
// ABOUTME: An inconclusive check must not borrow the ban list's answer.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

// The hook has two sources of truth: the NIP-86 ban lists and a live
// verification call. The lists swallow their own errors into `[]`, so
// "list unavailable" and "not in list" are the same value here. That is
// exactly why a check that came back inconclusive must not fall through to
// them — doing so converts "could not reach the relay" into "not banned".

const {
  listBannedPubkeys,
  listBannedEvents,
  listSuspendedPubkeys,
  verifyPubkeyBanned,
  verifyEventDeleted,
} = vi.hoisted(() => ({
  listBannedPubkeys: vi.fn(),
  listBannedEvents: vi.fn(),
  listSuspendedPubkeys: vi.fn(),
  verifyPubkeyBanned: vi.fn(),
  verifyEventDeleted: vi.fn(),
}));

vi.mock('@/hooks/useAdminApi', () => ({
  useAdminApi: () => ({
    listBannedPubkeys,
    listBannedEvents,
    listSuspendedPubkeys,
    verifyPubkeyBanned,
    verifyEventDeleted,
  }),
}));

import { useModerationStatus } from './useModerationStatus';

const PUBKEY = 'a'.repeat(64);
const EVENT_ID = 'b'.repeat(64);

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('useModerationStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listBannedPubkeys.mockResolvedValue([]);
    listBannedEvents.mockResolvedValue([]);
    listSuspendedPubkeys.mockResolvedValue([]);
    verifyEventDeleted.mockResolvedValue(null);
  });

  it('uses the ban list before any check has run', async () => {
    listBannedPubkeys.mockResolvedValue([{ pubkey: PUBKEY }]);
    verifyPubkeyBanned.mockResolvedValue(null);

    // An event report that was found normally does not auto-check, so this is
    // the "no verification has run" state. (A user-only report auto-checks.)
    const { result } = renderHook(() => useModerationStatus(PUBKEY, EVENT_ID, false), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(verifyPubkeyBanned).not.toHaveBeenCalled();
    expect(result.current.isUserBanned).toBe(true);
  });

  it('reports unknown, not "not banned", when the check could not complete', async () => {
    // The relay is unreachable: the list query resolves to [] and the
    // verification resolves null.
    verifyPubkeyBanned.mockResolvedValue(null);

    const { result } = renderHook(() => useModerationStatus(PUBKEY), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      result.current.recheck();
    });

    await waitFor(() => expect(result.current.checkedAt).not.toBeNull());
    // The regression this pins: `null ?? isUserBannedFromList` yielded false.
    expect(result.current.isUserBanned).toBeNull();
    expect(result.current.isUserBanned).not.toBe(false);
  });

  it('still reports a completed negative check as not banned', async () => {
    verifyPubkeyBanned.mockResolvedValue(false);

    const { result } = renderHook(() => useModerationStatus(PUBKEY), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      result.current.recheck();
    });

    await waitFor(() => expect(result.current.checkedAt).not.toBeNull());
    expect(result.current.isUserBanned).toBe(false);
  });

  it('still reports a completed positive check as banned', async () => {
    verifyPubkeyBanned.mockResolvedValue(true);

    const { result } = renderHook(() => useModerationStatus(PUBKEY), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      result.current.recheck();
    });

    await waitFor(() => expect(result.current.checkedAt).not.toBeNull());
    expect(result.current.isUserBanned).toBe(true);
  });
});
