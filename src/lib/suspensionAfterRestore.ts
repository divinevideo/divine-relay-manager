// ABOUTME: The suspension to act on just after this tab unsuspended the account, so a stale
// ABOUTME: copy of the suspended list cannot contradict a confirmed Unsuspend.

/**
 * This tab's restore window (lib/userStatsCache, markRestored) opens only
 * after a confirmed Unsuspend. A suspension known only from a copy of the
 * suspended list whose re-read failed (most likely the copy from before that
 * Unsuspend) does not contradict it, so while the window is open it counts as
 * not suspended. A suspension the list confirmed since (another moderator
 * suspended the account again) still counts while that read is current, and an
 * unknown suspension stays unknown.
 *
 * `stale` is useModerationStatus's isUserSuspendedStale.
 */
export function suspensionAfterRestore(suspended: boolean | null, stale: boolean, justRestored: boolean): boolean | null {
  return justRestored && suspended === true && stale ? false : suspended;
}
