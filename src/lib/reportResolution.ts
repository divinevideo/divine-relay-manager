// ABOUTME: Pure predicate for whether a consolidated report counts as resolved.
// ABOUTME: Adds event->author cross-resolution so a banned account clears its event reports.

export interface ResolvableReport {
  target: { type: 'event' | 'pubkey'; value: string };
  // The reported author (the report's `p` tag), when present. Optional because an
  // `e`-tagged report need not carry one: NIP-56's own blob-report example is
  // `x` + `e` + `server` with no `p` at all, and the caller also leaves this
  // undefined when a group's reports disagree about the author.
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
  // Both sides of this comparison are lowercased, because neither one is canonical.
  // authorPubkey is a reporter-authored `p` tag, validated as hex without being
  // case-normalized. The relay's side is no better: funnelcake's hex check accepts
  // A-F, stores what `banpubkey` was handed and reads it back verbatim, so an
  // uppercase ban really does come back uppercase from `listbannedpubkeys`. The
  // caller lowercases the set it passes in (Reports.tsx `bannedPubkeySet`); this
  // lowercases the tag. Drop either half and the ban that clears an account's own
  // event reports stops clearing them.
  if (
    report.target.type === 'event' &&
    report.authorPubkey &&
    bannedPubkeys.has(report.authorPubkey.toLowerCase())
  ) {
    return true;
  }
  return false;
}
