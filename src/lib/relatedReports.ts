// ABOUTME: Splits an account's complete report read into the Related Reports card's two groups.
// ABOUTME: Reports on the account itself, and reports on its events, minus the open report's own target.

import type { NostrEvent } from "@nostrify/nostrify";
import { getReportTarget, reportTargetKey } from "../../shared/report-target";

export interface RelatedReports {
  userReports: NostrEvent[];
  eventReports: NostrEvent[];
}

export function splitRelatedReports(
  events: NostrEvent[],
  pubkey: string,
  // reportTargetKey of the open report's target, or '' when there is none.
  currentTargetKey: string,
): RelatedReports {
  const userPubkey = pubkey.toLowerCase();
  const userReports: NostrEvent[] = [];
  const eventReports: NostrEvent[] = [];

  for (const r of events) {
    const target = getReportTarget(r);
    if (!target) continue;
    // The open report's own target is not "related" to itself.
    if (reportTargetKey(target) === currentTargetKey) continue;
    if (target.type === 'pubkey') {
      // getReportTarget is presence-based so a malformed report stays visible: a
      // bare ["p"] tag gives a pubkey target with no value. Guard it here, or one
      // hostile report would crash the pane for its whole account.
      if (typeof target.value === 'string' && target.value.toLowerCase() === userPubkey) userReports.push(r);
    } else if (target.type === 'event') {
      // The read is by `p` tag, so an event report here names this account in
      // its `p` tag; the check keeps the card to reports that say so.
      if (r.tags.some(t => t[0] === 'p' && t[1]?.toLowerCase() === userPubkey)) eventReports.push(r);
    }
  }
  return { userReports, eventReports };
}
