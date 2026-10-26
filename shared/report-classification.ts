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
const CSAM_REASON_LINE = /^\s*Reason:\s*(csam|sexual_minors)\s*$/im;
// Free text from other apps. \b keeps "csamuel" out; "child porn" also matches
// "child pornography" because only its left edge is anchored.
const CSAM_FREE_TEXT = /\b(csam|child sexual abuse)\b|\bchild porn/i;

function tagList(event: { tags?: unknown }): string[][] {
  return Array.isArray(event.tags)
    ? (event.tags as unknown[]).filter((t): t is string[] => Array.isArray(t))
    : [];
}

function hasValue(t: string[]): boolean {
  return typeof t[1] === 'string' && t[1] !== '';
}

function isCsamValue(value: unknown): boolean {
  return typeof value === 'string'
    && CSAM_CATEGORIES.some(c => c.toLowerCase() === value.toLowerCase());
}

function categoryOf(tags: string[][]): string {
  const report = tags.find(t => t[0] === 'report' && hasValue(t));
  if (report) return report[1];

  // Prefer a high-priority Divine label, so a spam label listed first cannot
  // hide a CSAM label listed second.
  const nos = tags.filter(t => t[0] === 'l' && t[2] === NOS_NAMESPACE && hasValue(t));
  const nosPick = nos.find(t => HIGH_PRIORITY_CATEGORIES.includes(t[1])) ?? nos[0];
  if (nosPick) return nosPick[1];

  const otherLabel = tags.find(t => t[0] === 'l' && t[2] !== NOS_NAMESPACE && hasValue(t));
  if (otherLabel) return otherLabel[1];

  // NIP-56 puts the report type on the target tag.
  const eType = tags.find(t => t[0] === 'e')?.[2];
  if (eType) return eType;
  const pType = tags.find(t => t[0] === 'p')?.[2];
  if (pType) return pType;

  return 'other';
}

export function classifyReport(event: { tags?: unknown; content?: unknown }): ReportClassification {
  const tags = tagList(event);
  const content = typeof event.content === 'string' ? event.content : '';

  const csamSignal =
    tags.some(t => (t[0] === 'report' || t[0] === 'l') && isCsamValue(t[1]))
    || CSAM_REASON_LINE.test(content)
    || CSAM_FREE_TEXT.test(content);

  return { category: categoryOf(tags), csamSignal };
}

// Must match the worker's category extraction in ReportWatcher.handleReportEvent
// (report > nos label > MOD label > e type > p type), including taking the
// first Divine label rather than the high-priority one: age review is gated
// on the same value the worker computes.
// TODO(#NNN): move ReportWatcher onto classifyReport
export function ageReviewCategory(event: { tags?: unknown }): string {
  const tags = tagList(event);
  return tags.find(t => t[0] === 'report')?.[1]
    || tags.find(t => t[0] === 'l' && t[2] === NOS_NAMESPACE)?.[1]
    || tags.find(t => t[0] === 'l' && t[2] === 'MOD')?.[1]
    || tags.find(t => t[0] === 'e')?.[2]
    || tags.find(t => t[0] === 'p')?.[2]
    || 'unknown';
}
