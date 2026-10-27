// ABOUTME: One bulk-job failure line in plain words, for every screen that lists
// ABOUTME: them (Bulk Delete by Kind). IDs stay whole.
import { parseFailure } from '../../shared/bulk-moderation';

// The worker's listing lines (enumerationWarning in worker/src/bulk-moderate.ts),
// each matched to words a moderator reads without knowing
// how the job lists files. A line not listed here is shown as written.
const LISTING_LINES: Array<[RegExp, (m: RegExpExecArray) => string]> = [
  [/^relay returned (\d+) event\(s\) outside the requested author or kind; ignored them$/, (m) =>
    `the relay returned ${m[1]} event(s) from another account or of another kind; they were left alone`],
  [/^relay could not be fully paginated; (.*)$/s, (m) => `the relay's list of events could not be read in full; ${m[1]}`],
];

// A fragment, not a sentence: a caller embeds it ("Reason: ...") or capitalises
// it for a list.
export function describeBulkFailure(failure: string): string {
  const parsed = parseFailure(failure);
  switch (parsed.type) {
    case 'overflow':
      return `${parsed.count} more ${parsed.count === 1 ? 'problem was' : 'problems were'} not stored`;
    case 'job':
      // The stale-job heal's reason, in words; any other reason as given.
      return parsed.abandoned ? 'the server stopped reporting progress' : parsed.reason;
    case 'event':
      return `event ${parsed.id} failed: ${parsed.error}`;
    case 'media':
      return `file ${parsed.sha256} could not be changed: ${parsed.error}`;
    case 'enumeration': {
      // The account is already the screen's subject, so its pubkey is dropped.
      for (const [pattern, words] of LISTING_LINES) {
        const match = pattern.exec(parsed.warning);
        if (match) return words(match);
      }
      return parsed.warning;
    }
    default:
      return failure;
  }
}
