// ABOUTME: The account-status query's cache key, and the one way to refresh a single
// ABOUTME: account's entry; shared by the hook, age review and the report view.
import type { QueryClient } from '@tanstack/react-query';

// Lowercased: the worker accepts only lowercase hex, and age review and the report
// view must share one entry per account.
export function accountStatusKey(apiUrl: string | undefined, pubkey: string | undefined) {
  return ['account-status', apiUrl, pubkey?.toLowerCase()] as const;
}

/** Refresh one account's status, in every environment it was cached for. */
export function invalidateAccountStatus(queryClient: QueryClient, pubkey: string): Promise<void> {
  const subject = accountStatusKey(undefined, pubkey)[2];
  return queryClient.invalidateQueries({
    queryKey: ['account-status'],
    predicate: (query) => query.queryKey[2] === subject,
  });
}

// The worker mirrors a report-view ban or suspension into Keycast after it has
// responded (enforceKeycastState in worker/src/index.ts, via waitUntil), so a
// refresh at once can read the status from before the action. Not measured
// against Keycast's real latency: the mirror is one status write, expected to
// finish well inside this. A slower mirror still leaves the label stale until
// the next read.
export const KEYCAST_MIRROR_SETTLE_MS = 5_000;

/**
 * Refresh one account's status now, and once more after the Keycast mirror has
 * had time to land. Age review doesn't need this: its write to Keycast finishes
 * before the worker responds.
 */
export function refreshAccountStatusAfterMirror(queryClient: QueryClient, pubkey: string): void {
  void invalidateAccountStatus(queryClient, pubkey);
  // Never cancelled on unmount or an environment switch: with nothing on screen
  // the refresh only marks the entry stale, so reopening the report reads it again.
  setTimeout(() => {
    void invalidateAccountStatus(queryClient, pubkey);
  }, KEYCAST_MIRROR_SETTLE_MS);
}
