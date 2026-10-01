// ABOUTME: Groups reports by the target they name: one entry per target, with its reporters and categories.
// ABOUTME: The queue's grouped rows, its counts and its sorts are all built from these entries.

import type { NostrEvent } from '@nostrify/nostrify';
import { getReportCategory, getReportTargetIds } from '@/lib/constants';
import { getReportTarget, reportTargetKey, type ReportTarget } from '../../shared/report-target';

export interface ConsolidatedReport {
  target: ReportTarget;
  reports: NostrEvent[];
  categories: string[];
  reporters: string[];
  latestReport: NostrEvent;
  oldestReport: NostrEvent;
  // The reported author (report `p` tag), used to cross-resolve an event-scoped
  // report when its author has been banned. Undefined if no valid `p` tag.
  authorPubkey?: string;
}

export function consolidateReports(reports: NostrEvent[]): ConsolidatedReport[] {
  const byTarget = new Map<string, ConsolidatedReport>();
  // Reporters already listed per target. A targeted lookup can return tens of
  // thousands of reports for one account, and scanning the reporter list for
  // each of them is quadratic in its reporters.
  const reportersSeen = new Map<string, Set<string>>();

  for (const report of reports) {
    const target = getReportTarget(report);
    if (!target) continue;

    const key = reportTargetKey(target);
    const category = getReportCategory(report);

    if (!byTarget.has(key)) {
      reportersSeen.set(key, new Set());
      byTarget.set(key, {
        target,
        reports: [],
        categories: [],
        reporters: [],
        latestReport: report,
        oldestReport: report,
      });
    }

    const consolidated = byTarget.get(key)!;
    consolidated.reports.push(report);

    if (!consolidated.categories.includes(category)) {
      consolidated.categories.push(category);
    }

    const seen = reportersSeen.get(key)!;
    if (!seen.has(report.pubkey)) {
      seen.add(report.pubkey);
      consolidated.reporters.push(report.pubkey);
    }

    if (report.created_at > consolidated.latestReport.created_at) {
      consolidated.latestReport = report;
    }
    if (report.created_at < consolidated.oldestReport.created_at) {
      consolidated.oldestReport = report;
    }
  }

  // Derive each group's author from ALL its reports, not just the first-processed
  // (newest) one. Cross-resolution hides a whole consolidated group from the default
  // queue, so taking the author from a single unverified `p` tag is gameable: a newer
  // report naming any banned pubkey would bury the genuine older report with it
  // (NIP-56 warns reports "can be easily gamed"). Require agreement instead — cross-
  // resolve only when every report carries a valid `p` tag and names the same author.
  // A missing author cannot be ignored: otherwise one later report naming a banned
  // pubkey could still bury an existing report that supplied no author. Lowercased so
  // a casing difference is not a false disagreement; undefined when any author is
  // missing or the reports conflict, in which case the group is never cross-resolved.
  for (const consolidated of byTarget.values()) {
    const authors = consolidated.reports.map(r => getReportTargetIds(r).pubkey);
    const uniqueAuthors = new Set(authors.filter((p): p is string => !!p).map(p => p.toLowerCase()));
    consolidated.authorPubkey = authors.every((p): p is string => !!p) && uniqueAuthors.size === 1
      ? [...uniqueAuthors][0]
      : undefined;
  }

  // Sort by number of reports (most reported first), then by latest report date
  return Array.from(byTarget.values()).sort((a, b) => {
    if (b.reports.length !== a.reports.length) {
      return b.reports.length - a.reports.length;
    }
    return b.latestReport.created_at - a.latestReport.created_at;
  });
}
