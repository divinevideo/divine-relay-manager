// ABOUTME: Reads every report naming an account, for the report pane's Related Reports card.
// ABOUTME: Independent of the queue's loaded rows, so the count does not follow the view or the pages loaded.

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAdminApi } from "@/hooks/useAdminApi";
import { useAppContext } from "@/hooks/useAppContext";
import type { ReportTarget } from "../../shared/report-target";
import { splitRelatedReports, type RelatedReports } from "@/lib/relatedReports";

export type RelatedReportsState =
  | { status: 'loading' }
  | { status: 'error'; retry: () => void }
  | ({ status: 'ready'; truncated: boolean } & RelatedReports);

export function useRelatedReports(
  pubkey: string,
  currentTarget: ReportTarget | null,
): RelatedReportsState {
  const { fetchReportsByTarget } = useAdminApi();
  const { config } = useAppContext();
  // The endpoint takes lowercase hex.
  const key = pubkey.toLowerCase();

  const query = useQuery({
    // Not "related-reports": EventDetail owns that namespace for its own capped read.
    // apiUrl is in the key: another environment's reports for the same pubkey
    // must never be served from this one's cache.
    queryKey: ['account-reports', config.apiUrl, key],
    queryFn: () => fetchReportsByTarget({ pubkey: key }),
    enabled: !!key,
    staleTime: 60_000,
  });

  const events = query.data?.events;
  const split = useMemo(
    () => (events ? splitRelatedReports(events, key, currentTarget) : null),
    [events, key, currentTarget],
  );

  // An error is checked before data: a failed refetch keeps the last good data
  // on the query, but a read that is failing now must not read as a total.
  if (query.isError) return { status: 'error', retry: () => void query.refetch() };
  if (!split) return { status: 'loading' };
  return { status: 'ready', truncated: query.data?.truncated === true, ...split };
}
