// ABOUTME: What to refresh after anything that can change whether a report is resolved.
// ABOUTME: One list, so no resolving or reopening handler can leave a report feed stale.

import type { QueryClient } from '@tanstack/react-query';

// First element of the resolved-history query key (useResolvedHistory).
export const RESOLVED_HISTORY_KEY_ROOT = 'reports-resolved';

// Resolving or reopening a target changes three cached reads:
// - the queue's client-side resolved set and pending-review split;
// - the needs-attention feed, which the worker filters by the same decisions
//   and labels, so a resolved target leaves it and a reopened one returns;
// - loaded resolved history, the complement of that feed. Without this a newly
//   resolved target shows in neither view until history is next read, and a
//   reopened one shows in both. Every loaded page is re-read while the history
//   view is open; otherwise the pages are marked stale and re-read when it
//   opens.
export function invalidateResolutionState(queryClient: QueryClient): void {
  queryClient.invalidateQueries({ queryKey: ['resolution-state'] });
  queryClient.invalidateQueries({ queryKey: ['reports'] });
  queryClient.invalidateQueries({ queryKey: [RESOLVED_HISTORY_KEY_ROOT] });
}
