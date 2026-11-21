// ABOUTME: One shared read of the timed suspensions in force. Screens ask it about one
// ABOUTME: account at a time and tell "still loading" from "no timer" from "could not read".
import { useQuery } from '@tanstack/react-query';
import type { TimedSuspensionView } from '../../shared/suspension';
import { useAdminApi, useApiUrl } from './useAdminApi';

/** Prefix key: invalidate with this after a suspend, unban or end-date change. */
export const TIMED_SUSPENSIONS_KEY = ['timed-suspensions'] as const;

export function useTimedSuspensions(opts?: { enabled?: boolean }) {
  const api = useAdminApi();
  const apiUrl = useApiUrl();
  return useQuery({
    // The environment is part of the key, so switching it never shows another
    // environment's timers. TIMED_SUSPENSIONS_KEY still invalidates by prefix.
    queryKey: [...TIMED_SUSPENSIONS_KEY, apiUrl],
    queryFn: () => api.listTimedSuspensions(),
    enabled: !!apiUrl && (opts?.enabled ?? true),
    staleTime: 30_000,
    retry: 1,
  });
}

/**
 * This account's timer record.
 * - `undefined`: the list has not answered yet (or no pubkey was given)
 * - `null`: the list answered and this account has no timer
 * - a record: its timer
 * `isError` is true only when the read failed and there is no data to show, so a
 * failed background refetch over earlier data stays quiet. `refreshFailed` says
 * that case happened: the record is from an older copy that may predate a
 * suspend, fine to show but not to choose a default from (the unban prompt).
 */
export function useTimedSuspension(pubkey: string | null | undefined): {
  record: TimedSuspensionView | null | undefined;
  isError: boolean;
  isLoading: boolean;
  refreshFailed: boolean;
} {
  const query = useTimedSuspensions({ enabled: !!pubkey });
  const target = pubkey?.toLowerCase();
  const record = !target || !query.data
    ? undefined
    : query.data.find(entry => typeof entry.pubkey === 'string' && entry.pubkey.toLowerCase() === target) ?? null;
  return {
    record,
    isError: !!pubkey && query.isError && !query.data,
    isLoading: !!pubkey && query.isLoading,
    refreshFailed: !!pubkey && query.isError && !!query.data,
  };
}
