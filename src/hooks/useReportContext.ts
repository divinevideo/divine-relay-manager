// ABOUTME: Aggregates all context needed for moderating a report
// ABOUTME: Combines thread, user stats, reporter info into single hook

import { useNostr } from "@nostrify/react";
import { useQuery } from "@tanstack/react-query";
import { useAuthor } from "@/hooks/useAuthor";
import { useThread } from "@/hooks/useThread";
import { useUserStats } from "@/hooks/useUserStats";
import type { NostrEvent } from "@nostrify/nostrify";

interface ReportTarget {
  type: 'event' | 'pubkey';
  value: string;
}

function getReportTarget(event: NostrEvent): ReportTarget | null {
  const eTag = event.tags.find(t => t[0] === 'e');
  if (eTag) return { type: 'event', value: eTag[1] };

  const pTag = event.tags.find(t => t[0] === 'p');
  if (pTag) return { type: 'pubkey', value: pTag[1] };

  return null;
}

function getReportedPubkey(event: NostrEvent): string | null {
  // If report targets a pubkey directly
  const pTag = event.tags.find(t => t[0] === 'p');
  if (pTag) return pTag[1];

  return null;
}

export function useReportContext(report: NostrEvent | null) {
  const { nostr } = useNostr();

  const target = report ? getReportTarget(report) : null;
  const reportedEventId = target?.type === 'event' ? target.value : undefined;
  const reportedPubkey = report ? getReportedPubkey(report) : null;
  const reporterPubkey = report?.pubkey;

  // Get thread context if report is about an event
  const thread = useThread(reportedEventId, 3);

  // Get the pubkey of the reported user (from event author or direct p tag)
  const targetPubkey = thread.data?.event?.pubkey || reportedPubkey;

  // Get reported user's profile and stats
  const reportedUser = useAuthor(targetPubkey || undefined);
  const userStats = useUserStats(targetPubkey || undefined);

  // Get reporter's profile
  const reporter = useAuthor(reporterPubkey);

  // Get reporter's report count
  const reporterStats = useQuery({
    queryKey: ['reporter-stats', reporterPubkey],
    queryFn: async ({ signal }) => {
      if (!reporterPubkey) return { reportCount: 0 };

      const reports = await nostr.query(
        [{ kinds: [1984], authors: [reporterPubkey], limit: 100 }],
        { signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]) }
      );

      return { reportCount: reports.length };
    },
    enabled: !!reporterPubkey,
  });

  const isLoading = thread.isLoading || reportedUser.isLoading ||
                    userStats.isLoading || reporter.isLoading;

  const error = thread.error || reportedUser.error ||
                userStats.error || reporter.error;

  return {
    target,
    thread: thread.data,
    reportedUser: {
      profile: reportedUser.data?.metadata,
      pubkey: targetPubkey,
    },
    userStats: userStats.data,
    reporter: {
      profile: reporter.data?.metadata,
      pubkey: reporterPubkey,
      reportCount: reporterStats.data?.reportCount || 0,
    },
    isLoading,
    error,
  };
}
