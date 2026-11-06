// ABOUTME: Drops an account's cached authored-content reads after an action that changes
// ABOUTME: what the relay shows of it, and covers the relay's lag after it restores one.

import { useContext, useSyncExternalStore } from 'react';
import { AppContext } from '@/contexts/AppContext';
import type { Query, QueryClient } from '@tanstack/react-query';

// The relay hides a suspended or banned account's content, so a count read
// before the action describes the other state. Invalidating is not enough:
// with no cached data TanStack joins a read still in flight, which started
// before the action, and lands its answer as fresh. Resetting does both jobs:
// TanStack's Query.reset() destroys the query, which cancels a read in flight,
// then restores the initial state, and mounted screens read again.
//
// That re-read reflects the relay's answer now, which after an unsuspend,
// unban or allow is not yet the new state: see markRestored.
//
// Both caches of authored content: useUserStats (['user-stats', relayUrl,
// pubkey]) and BannedUserCard (['user-posts-stats', apiUrl, pubkey]). Matched
// on the pubkey across environments, since either key carries it third, and
// case-insensitively, since a report's p tag can carry an uppercase pubkey.
const AUTHORED_CONTENT_KEYS = new Set(['user-stats', 'user-posts-stats']);

export async function resetAccountContentReads(queryClient: QueryClient, pubkey: string): Promise<void> {
  const target = pubkey.toLowerCase();
  const predicate = (query: Query) =>
    AUTHORED_CONTENT_KEYS.has(query.queryKey[0] as string)
    && typeof query.queryKey[2] === 'string'
    && query.queryKey[2].toLowerCase() === target;
  await queryClient.resetQueries({ predicate });
}

/**
 * How long after an action that restores an account's visibility (unsuspend,
 * unban, allow) the relay may still hide its content. Funnelcake drops the
 * account from the suspended or banned list at once, but the read filters its
 * queries use catch up on a periodic refresh of about five minutes (the
 * worker's age-review notes say the same for suspensions). Until then a
 * re-read can come back empty, which with the account no longer hidden would
 * print as a plain "0 events". Content that survived the ban (a deferred
 * purge) can come back sooner, and is shown as the relay returns it.
 *
 * A minute longer than the refresh period: the refresh runs on fixed
 * five-minute boundaries and takes time of its own, so a restore that lands
 * just as one starts waits for the next to finish. A window of exactly five
 * minutes could close, and run its last re-read, before that.
 */
export const RESTORE_SETTLE_MS = 6 * 60_000;

// Session-local: which accounts this tab restored within the window, each with
// the timer that ends it. Another moderator's action is not seen here; their
// count reads as the relay answers. Keyed by the environment the action ran in
// (its relay URL, as userStatsQueryKey is) and the pubkey: switching
// environment clears the query cache but not this map, and a production
// restore must not read as "just restored" on staging. Callers capture the
// environment when the action starts, so one that lands after a switch still
// marks the environment it ran in.
const restoreWindows = new Map<string, ReturnType<typeof setTimeout>>();
const windowKey = (pubkey: string, environment: string | undefined) => `${environment ?? ''}|${pubkey.toLowerCase()}`;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach(listener => listener());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

/**
 * The environment a restore window belongs to: the selected relay URL. Read
 * from the context directly, so a component rendered without an AppProvider
 * (some tests) gets undefined rather than a throw.
 */
export function useRestoreEnvironment(): string | undefined {
  return useContext(AppContext)?.config.relayUrl;
}

/**
 * After an unsuspend, unban or allow that succeeded: reset the account's reads
 * now, mark it as just restored so an empty count says why, and reset once more
 * when the window ends, by which time the relay's read filters have caught up.
 * Another restore starts the window over.
 */
export async function markRestored(queryClient: QueryClient, pubkey: string, environment: string | undefined): Promise<void> {
  const key = windowKey(pubkey, environment);
  clearTimeout(restoreWindows.get(key));
  restoreWindows.set(key, setTimeout(() => {
    restoreWindows.delete(key);
    notify();
    void resetAccountContentReads(queryClient, pubkey);
  }, RESTORE_SETTLE_MS));
  notify();
  await resetAccountContentReads(queryClient, pubkey);
}

/** Ends the account's restore window in that environment, and its scheduled re-read. */
export function endRestoreWindow(pubkey: string, environment: string | undefined): void {
  const key = windowKey(pubkey, environment);
  if (!restoreWindows.has(key)) return;
  clearTimeout(restoreWindows.get(key));
  restoreWindows.delete(key);
  notify();
}

/**
 * After a ban or suspend that succeeded: the account is hidden again, so a
 * restore window still open would print "just restored" for it. Ends that
 * window and resets the reads.
 */
export async function markHidden(queryClient: QueryClient, pubkey: string, environment: string | undefined): Promise<void> {
  endRestoreWindow(pubkey, environment);
  await resetAccountContentReads(queryClient, pubkey);
}

/**
 * Runs an action that hides an account (a ban or suspend), then settles what
 * this tab shows of it, whatever the call did. One that landed hides the
 * account again, so it ends a restore window an earlier unban or unsuspend
 * left open (markHidden). Otherwise the reads are only reset: a call that could
 * not be confirmed may still have landed, and a reset after a failed one only
 * costs a re-read. Callers pass the account and environment they captured when
 * the action started, so one that lands after a switch settles the right ones.
 */
export async function runHidingAction<T>(
  queryClient: QueryClient,
  pubkey: string,
  environment: string | undefined,
  call: () => Promise<T>,
): Promise<T> {
  let hidden = false;
  try {
    const result = await call();
    hidden = true;
    return result;
  } finally {
    if (hidden) void markHidden(queryClient, pubkey, environment);
    else void resetAccountContentReads(queryClient, pubkey);
  }
}

/** True within RESTORE_SETTLE_MS of this tab restoring the account in the current environment. */
export function useJustRestored(pubkey: string | null | undefined): boolean {
  const environment = useRestoreEnvironment();
  return useSyncExternalStore(subscribe, () => !!pubkey && restoreWindows.has(windowKey(pubkey, environment)));
}
