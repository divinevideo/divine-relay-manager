// ABOUTME: The three NIP-86 relay list reads, defined once for every screen that reads them.
// ABOUTME: One cache key must not have two failure contracts.

import { useQuery } from '@tanstack/react-query';
import { useAdminApi } from '@/hooks/useAdminApi';
import { RESOLUTION_READ_TIMEOUT_MS } from '@/lib/constants';

const BAN_LIST_STALE_MS = 30_000;

/**
 * Why these live here rather than beside their callers.
 *
 * `['banned-pubkeys']` and `['banned-events']` are read by both the reports
 * queue and the report detail pane. React Query keys one cache entry per key,
 * and the `queryFn` that runs is the one belonging to whichever observer
 * triggers the fetch. The two copies had drifted into opposite contracts: the
 * queue rethrew so its per-source failure pane could fire, while the pane
 * swallowed the error into `[]`. A failure during the pane's turn therefore
 * wrote an empty list into the shared entry as a SUCCESS, and the queue read
 * "nothing is banned" instead of "the read failed" -- silently restoring every
 * handled target to the queue with no banner to explain it.
 *
 * Aligning the copies by hand would have left the same trap for whoever edits
 * one of them next, so every reader goes through here: the reports queue, the
 * report and event detail panes, the events list and settings. RelayStats and
 * EventModeration read through here too but are not currently mounted anywhere.
 * useRelayBanLists.test.ts fails if any other file defines or writes one of the
 * three keys as a literal. A key held in a variable would get past it.
 *
 * The contract: a failed read throws. It never resolves to an empty list,
 * because "the relay did not answer" and "the list is empty" are different
 * answers and only one of them is safe to show a moderator. That contract holds
 * at the query. How a screen renders the error is its own business, and relay
 * stats, settings and the events list still render it as zero or unbanned --
 * a separate fix.
 */
interface BanListOptions {
  /** The queue drops this to 0 on a deep link so a fresh ban status is read. */
  staleTime?: number;
  /** Only the queue polls. The detail pane reads on mount and on demand. */
  refetchInterval?: number | false;
  /** Screens that wait for a relay to be configured before reading anything. */
  enabled?: boolean;
}

function baseOptions(opts?: BanListOptions) {
  return {
    staleTime: opts?.staleTime ?? BAN_LIST_STALE_MS,
    refetchInterval: opts?.refetchInterval ?? (false as const),
    enabled: opts?.enabled ?? true,
    // Deliberately no `placeholderData: prev => prev`, which the queue's copies
    // used to carry. These keys never change, so the option never helped a
    // refresh: React Query keeps `data` across a failed refetch on its own. Its
    // only effect was after an environment switch, which calls
    // queryClient.clear() -- a still-mounted observer then seeded the new
    // environment's empty query with the OLD environment's list, reported as a
    // success. The pane stated it as that account's ban status and the queue
    // filtered by it. Without the option, these three lists behave after an
    // environment switch exactly as on a fresh page load: nothing until the new
    // environment answers. (The queue's other reads -- reports,
    // resolution-state, resolution-label-targets -- still carry the option, so
    // the queue as a whole does not behave that way yet.)
    // One retry, matching the queue's other resolution reads. The React Query
    // default of three stacks backoff onto an already-slow relay.
    retry: 1,
  };
}

export function useBannedPubkeys(opts?: BanListOptions) {
  const { listBannedPubkeys } = useAdminApi();
  return useQuery({
    queryKey: ['banned-pubkeys'],
    queryFn: async () => {
      try {
        return await listBannedPubkeys({ timeoutMs: RESOLUTION_READ_TIMEOUT_MS });
      } catch (error) {
        console.warn('NIP-86 listbannedpubkeys failed:', error);
        throw error;
      }
    },
    ...baseOptions(opts),
  });
}

export function useBannedEvents(opts?: BanListOptions) {
  const { listBannedEvents } = useAdminApi();
  return useQuery({
    queryKey: ['banned-events'],
    queryFn: async () => {
      try {
        return await listBannedEvents({ timeoutMs: RESOLUTION_READ_TIMEOUT_MS });
      } catch (error) {
        console.warn('NIP-86 listbannedevents failed:', error);
        throw error;
      }
    },
    ...baseOptions(opts),
  });
}

export function useSuspendedPubkeys(opts?: BanListOptions) {
  const { listSuspendedPubkeys } = useAdminApi();
  return useQuery({
    queryKey: ['suspended-pubkeys'],
    queryFn: async () => {
      try {
        return await listSuspendedPubkeys({ timeoutMs: RESOLUTION_READ_TIMEOUT_MS });
      } catch (error) {
        console.warn('NIP-86 listsuspendedpubkeys failed:', error);
        throw error;
      }
    },
    ...baseOptions(opts),
  });
}

/**
 * What one of these lists says about one target, given how the read went.
 *
 * React Query keeps the previous result in `data` when a refresh fails, so the
 * list on hand may be stale. Presence and absence are treated differently:
 *
 * - `true` when the target is in the list, even if the latest refresh failed.
 *   Membership from the last good read is the best evidence available, and the
 *   reports queue already keeps treating it as current. Dropping it after one
 *   failed poll would swap "Unban" for "Ban" on a banned account.
 * - `false` only when the latest read succeeded and the target is absent.
 * - `null` when the list has never answered, or when the target is absent from
 *   a copy whose refresh then failed. Absence from a stale list is not a
 *   confirmed negative.
 *
 * Used by useModerationStatus, and so by both the report and event detail
 * panes, which state these as a status to a moderator. The queue reads the
 * lists directly for filtering.
 */
export function listMembership<T>(
  query: { isError: boolean; data: T[] | undefined },
  isTarget: (entry: T) => boolean,
): boolean | null {
  if (query.data === undefined) return null;
  if (query.data.some(isTarget)) return true;
  return query.isError ? null : false;
}
