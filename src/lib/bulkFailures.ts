// ABOUTME: One bulk-job failure line in plain words, for every screen that lists
// ABOUTME: them (Bulk Delete by Kind). IDs stay whole.
import { parseFailure } from '../../shared/bulk-moderation';

// The listing error the worker wraps every uploader-list failure in
// (listAccountVideos in worker/src/media-server.ts); the lines below already
// say that, so only the cause after it is shown.
const listCause = (error: string) => error.replace(/^could not list this account's files: /, '');

// The worker's listing lines (enumerationWarning in worker/src/bulk-moderate.ts
// and age-review.ts), each matched to words a moderator reads without knowing
// how the job lists files. A line not listed here is shown as written.
const LISTING_LINES: Array<[RegExp, (m: RegExpExecArray) => string]> = [
  // A queued job's line adds that its count may be off; an age-review step's
  // (the synchronous path, whose count is exact) does not.
  [/^(.*); (files|the rest) were chosen from the relay's list only(, so the count of files left as they were may be off)?$/s, (m) =>
    `the media server's list of this account's files could not be read (${listCause(m[1])}), so ${m[2] === 'files' ? 'its files' : 'the rest of its files'} were chosen from the relay's list only${m[3] ? ', and the count of files left as they were may be off' : ''}`],
  [/^(.*); could not check for files left unchanged$/s, (m) => `could not check for files left unchanged at the end (${listCause(m[1])})`],
  [/^(\d+) more owned video files still listed unchanged after the walk$/, (m) => `${m[1]} of this account's videos were still unchanged after the walk`],
  [/^(.*); the files still hidden could not be listed$/s, (m) => `could not list the files still hidden (${listCause(m[1])})`],
  // notesOverflowWarning and notesNotStoredWarning in shared/bulk-moderation.ts.
  [/^(\d+) more note\(s\) than one run can store; act on these, then run it again to list the rest$/, (m) =>
    `${m[1]} more files to check than one run can store; act on these, then run the same action again to list the rest`],
  [/^could not store (\d+) note\(s\) for a person: (.*)$/s, (m) => `${m[1]} files to check could not be saved (${m[2]})`],
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
