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
