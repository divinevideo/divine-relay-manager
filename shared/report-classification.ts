// ABOUTME: Classifies a kind-1984 report: which category it carries and whether it signals CSAM.
// ABOUTME: Pure and tolerant of malformed tags, so the browser and worker can share one reading.

// Categories where media should be hidden by default for moderator safety.
export const HIGH_PRIORITY_CATEGORIES: readonly string[] = [
  'sexual_minors', 'csam', 'NS-csam',
  'nonconsensual_sexual_content', 'terrorism_extremism', 'credible_threats',
  'NS-underageUser', 'NS-childSafety',
];

// The categories that route a report as CSAM. Deliberately narrower than
// HIGH_PRIORITY_CATEGORIES: NS-childSafety is not in it. Compared ignoring case.
export const CSAM_CATEGORIES: readonly string[] = ['sexual_minors', 'csam', 'NS-csam'];

export interface ReportClassification {
  category: string;
  csamSignal: boolean;
}

const NOS_NAMESPACE = 'social.nos.ontology';

// Older builds put the reason only in the content, as a "Reason: csam" line.
// [ \t] rather than \s: \s also matches newlines, which made the leading \s*
// backtrack quadratically on content made of many blank lines. CRLF still
// matches: with /m, $ also stops before \r, which JS counts as a line end.
const CSAM_REASON_LINE = /^[ \t]*Reason:[ \t]*(csam|sexual_minors)[ \t]*$/im;
// Free text from other apps. A match is either "csam" with no ASCII letter,
// digit or underscore on either side, or "child" with no ASCII letter or digit
// before it, then any run of whitespace, hyphens or underscores (or none), then
// "porn" or "sexual abuse". "porn" is anchored on the left only, so "child
// pornography" matches. "sexual" and "abuse" need at least one separator
// between them, and "abuse" no ASCII letter or digit after it. So
// "is_child_porn" and "child_sexual_abuse_material" match, and
// "grandchildporn" and "child sexual abuser" do not. The (?:^|[^a-z0-9])
// prefix stands in for a lookbehind: Safari before 16.4 cannot parse one, and
// this module loads with the app. \s is safe here, unlike in the Reason line
// above, because each run of it follows a literal "child" or "sexual".
const CSAM_FREE_TEXT = /\bcsam\b|(?:^|[^a-z0-9])child[\s_-]*(?:sexual[\s_-]+abuse(?![a-z0-9])|porn)/i;

function tagList(event: { tags?: unknown }): string[][] {
  return Array.isArray(event.tags)
    ? (event.tags as unknown[]).filter((t): t is string[] => Array.isArray(t))
    : [];
}

function hasValue(t: string[]): boolean {
  return typeof t[1] === 'string' && t[1] !== '';
}

// NIP-01 lets an e or p tag carry a relay URL third, where NIP-56 puts the
// report type. A relay URL there is a hint, not a type.
const RELAY_HINT = /^wss?:\/\//i;

function isReportType(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && !RELAY_HINT.test(value);
}

function isCsamValue(value: unknown): boolean {
  return typeof value === 'string'
    && CSAM_CATEGORIES.some(c => c.toLowerCase() === value.toLowerCase());
}

function categoryOf(tags: string[][]): string {
  const report = tags.find(t => t[0] === 'report');
  if (report && hasValue(report)) return report[1];

  // Prefer a high-priority Divine label, so a spam label listed first cannot
  // hide a CSAM label listed second.
  const nos = tags.filter(t => t[0] === 'l' && t[2] === NOS_NAMESPACE && hasValue(t));
  const nosPick = nos.find(t => HIGH_PRIORITY_CATEGORIES.includes(t[1])) ?? nos[0];
  if (nosPick) return nosPick[1];

  const otherLabel = tags.find(t => t[0] === 'l' && t[2] !== NOS_NAMESPACE && hasValue(t));
  if (otherLabel) return otherLabel[1];

  // NIP-56 puts the report type on the target tag.
  const eType = tags.find(t => t[0] === 'e')?.[2];
  if (isReportType(eType)) return eType;
  const pType = tags.find(t => t[0] === 'p')?.[2];
  if (isReportType(pType)) return pType;

  return 'other';
}

// The category from the tags alone, without classifyReport's content scan, for
// callers such as sort comparators that ask on every comparison.
export function reportCategory(event: { tags?: unknown }): string {
  return categoryOf(tagList(event));
}

export function classifyReport(event: { tags?: unknown; content?: unknown }): ReportClassification {
  const tags = tagList(event);
  const content = typeof event.content === 'string' ? event.content : '';

  const csamSignal =
    tags.some(t => (t[0] === 'report' || t[0] === 'l') && isCsamValue(t[1]))
    || CSAM_REASON_LINE.test(content)
    || CSAM_FREE_TEXT.test(content);

  return { category: reportCategory(event), csamSignal };
}

// Must match the worker's category extraction in ReportWatcher.handleReportEvent
// (report > nos label > MOD label > e type > p type), including taking the
// first Divine label rather than the high-priority one: age review is gated
// on the same value the worker computes.
// TODO(#322): move ReportWatcher onto classifyReport
export function ageReviewCategory(event: { tags?: unknown }): string {
  const tags = tagList(event);
  return tags.find(t => t[0] === 'report')?.[1]
    || tags.find(t => t[0] === 'l' && t[2] === NOS_NAMESPACE)?.[1]
    || tags.find(t => t[0] === 'l' && t[2] === 'MOD')?.[1]
    || tags.find(t => t[0] === 'e')?.[2]
    || tags.find(t => t[0] === 'p')?.[2]
    || 'unknown';
}
