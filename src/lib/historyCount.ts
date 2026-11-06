// ABOUTME: Renders a history count honestly when the read that produced it stopped early.

// A count from a walk that hit its page bound is a floor, not a total. Printing
// it bare is the silent-cap bug this replaced: the pane said 50 when the answer
// was 80.
export function historyCount(count: number, truncated: boolean): string {
  return truncated ? `${count}+` : String(count);
}

export function historyStat(
  count: number,
  truncated: boolean,
  incomplete: boolean,
  noun: string,
): string {
  if (incomplete) return `${noun} unavailable`;
  return `${historyCount(count, truncated)} ${noun}`;
}

/**
 * An account's authored-content count, for the user cards.
 *
 * Funnelcake hides a suspended account's content from every read the relay
 * manager makes, so for a suspended account an empty read says nothing about
 * what the account has posted. That is stated as the reason, ahead of a read
 * failure, because it holds whatever the read did. The relay hides that content
 * at once, so a count above zero beside a current suspension was read before it
 * (a cached read): it is printed, marked as from before the suspension. Beside
 * a last-known suspension it is printed as is, since that may have been lifted.
 *
 * `count` is undefined until the read answers, which is not a zero either.
 * `limit` is the read's own cap: a read that came back with that many events
 * may have stopped short of the account's total, so it prints as a floor
 * ("20+"), the convention reportsFiledLabel uses.
 * `suspendedStale` is useModerationStatus's isUserSuspendedStale: the
 * suspension comes from a copy of the list that could not be refreshed.
 * `suspended` is null while the suspended list has not confirmed either way.
 * An empty read then proves nothing, so it says why (`suspensionChecking`: a
 * read of the suspended list is in flight, otherwise it could not be read).
 * `justRestored`: this tab unsuspended, unbanned or allowed the account moments
 * ago, and the relay's read filters can lag those lists by a few minutes, so an
 * empty read is not yet an empty account (lib/userStatsCache, markRestored).
 * `lastKnown`: the count is from an earlier read whose refresh failed, which
 * React Query keeps as `data`. Marked on a printed count only.
 */
export function authoredContentStat(opts: {
  count: number | undefined;
  incomplete: boolean;
  suspended: boolean | null;
  suspendedStale: boolean;
  suspensionChecking?: boolean;
  noun: string;
  limit: number;
  justRestored?: boolean;
  lastKnown?: boolean;
}): string {
  const { count, incomplete, suspended, suspendedStale, suspensionChecking = false, noun, limit, justRestored = false, lastKnown = false } = opts;
  if (suspended === true && !(count !== undefined && count > 0)) {
    return suspendedStale ? `${noun} hidden (last known: suspended)` : `${noun} hidden (account suspended)`;
  }
  if (count === undefined) return `checking ${noun}`;
  if (incomplete) return historyStat(count, false, true, noun);
  let stat = historyStat(count, count >= limit, false, noun);
  if (suspended === true && !suspendedStale && count > 0) {
    stat += ' (before suspension)';
  }
  if (justRestored && count === 0) {
    stat += ' (just restored; posts can take a few minutes to reappear)';
  } else if (suspended === null && count === 0) {
    stat += suspensionChecking ? ' (checking suspension)' : " (couldn't check suspension)";
  }
  return lastKnown ? `${stat} (last known)` : stat;
}

// For a read capped at `limit` events: reaching the cap means there may be
// more, so the count is printed as a floor rather than an exact total.
export function reportsFiledLabel(count: number, limit: number): string {
  return `${historyCount(count, count >= limit)} report${count === 1 ? '' : 's'} filed`;
}
