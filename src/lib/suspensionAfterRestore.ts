// ABOUTME: Orders suspended-list requests against confirmed Unsuspends in this tab.

let latestReadId = 0;

export function beginSuspendedListRead(): number {
  return ++latestReadId;
}

export function latestSuspendedListRead(): number {
  return latestReadId;
}

/**
 * A confirmed Unsuspend supersedes a positive from a request that started
 * before it. A later positive remains the last known suspension even after
 * a failed refresh. The ID recorded at Unsuspend expires with the restore window.
 */
export function suspensionAfterRestore(suspended: boolean | null, readId: number | undefined, restoreReadId: number | undefined): boolean | null {
  return suspended === true && readId !== undefined && restoreReadId !== undefined && readId <= restoreReadId
    ? false
    : suspended;
}
