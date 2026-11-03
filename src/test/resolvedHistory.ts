// ABOUTME: Resolved-history response bodies for tests that stub the worker.
// ABOUTME: Shaped like GET /api/reports/resolved so the client's parser accepts them.

export function resolvedPage(
  events: unknown[],
  paging: { nextCursor: number | null; done: boolean; skippedWithinSecond?: boolean; resolutionTruncated?: boolean },
) {
  return {
    success: true,
    events,
    next_cursor: paging.nextCursor,
    done: paging.done,
    skipped_within_second: paging.skippedWithinSecond ?? false,
    resolution_truncated: paging.resolutionTruncated ?? false,
  };
}

// For suites that never page history: an empty page at the end.
export const EMPTY_RESOLVED_PAGE = resolvedPage([], { nextCursor: null, done: true });
