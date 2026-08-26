// ABOUTME: Pure predicate for whether a consolidated report counts as resolved.
// ABOUTME: Adds event->author cross-resolution so a banned account clears its event reports.

export interface ResolvableReport {
  target: { type: 'event' | 'pubkey'; value: string };
  // The reported author (the report's `p` tag), when present. Event reports carry
  // both an `e` and a `p` tag, so an event-scoped report still knows its author.
  authorPubkey?: string;
}

// A consolidated report is resolved when its exact target key is already in
// `resolvedTargets`, OR — for an EVENT-scoped report — when its author pubkey is
// in the relay's banned-pubkey set.
//
// The event->author cross-resolution exists for one specific gap: "Ban User"
// (`banpubkey`) purges the account's events without registering each one in
// `listbannedevents`, so the event's own target key never appears in
// `resolvedTargets` and the report would linger even though the account is gone.
// Bulk "Delete All Content" does NOT need this — it `banevent`s each event, which
// resolves them through the normal `event:<id>` path.
//
// Keying on `bannedPubkeys` (not the decision log) is deliberate: suspension lives
// on a separate list, so a reversible holding action never cross-resolves.
export function isConsolidatedReportResolved(
  report: ResolvableReport,
  resolvedTargets: Set<string>,
  bannedPubkeys: Set<string>,
): boolean {
  if (resolvedTargets.has(`${report.target.type}:${report.target.value}`)) return true;
  // authorPubkey comes from a reporter-authored `p` tag and is not case-normalized
  // upstream; the ban set is relay-canonical lowercase. Lowercase before matching so
  // an uppercase tag still cross-resolves.
  if (
    report.target.type === 'event' &&
    report.authorPubkey &&
    bannedPubkeys.has(report.authorPubkey.toLowerCase())
  ) {
    return true;
  }
  return false;
}
