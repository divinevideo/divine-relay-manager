// age-restrict-all is the age-review withhold (hides a suspected minor's videos
// from everyone but the owner). age-gate-all is the moderator's "Age Restrict All"
// (puts the videos behind the 18+ gate). Keep them separate: #290.
// delete-kind deletes one event kind and nothing else. It is a separate action
// (not delete-all plus a kind) so a worker that predates it rejects it as
// unknown instead of running delete-all.
export const VALID_BULK_ACTIONS = ['age-restrict-all', 'age-gate-all', 'un-age-restrict-all', 'delete-all', 'delete-kind'] as const;

export type BulkAction = typeof VALID_BULK_ACTIONS[number];

// Kinds a relay keeps older versions of: replaceable (0, 3, 10000-19999) and
// addressable (30000-39999), per NIP-01. A listing of one shows only the newest
// version of each coordinate, so deleting it can reveal the one before.
export function isVersionedKind(kind: number): boolean {
  return kind === 0 || kind === 3 || (kind >= 10000 && kind < 20000) || (kind >= 30000 && kind < 40000);
}

// The whole-account actions, the only ones the synchronous path can run.
export type AccountBulkAction = Exclude<BulkAction, 'delete-kind'>;

export interface BulkModerateResult {
  success: boolean;
  eventsProcessed: number;
  // Media changed. Media the action left alone on purpose (see
  // decideMediaChange in worker/src/bulk-moderate.ts) is mediaSkipped, and is
  // not a failure.
  mediaProcessed: number;
  mediaSkipped: number;
  failures: string[];
  // Files left for a person to look at (see BulkNote). They do not make the
  // run a failure. Every one, never capped.
  notes: BulkNote[];
}

// A file a bulk action left for a person to look at (#299). Not a failure: the
// action did what it should, and the file is named so a moderator can act on
// it. Kept apart from `failures`, so it never reads as "finished with issues",
// never fails age review's bulk leg, and never crowds a real failure out of the
// stored list. Hashes and pubkeys are full lowercase hex.
//   still-hidden: an owned video still hidden when Un-age-restrict All ended:
//     one it did not choose (it chooses from funnelcake's list only, so
//     another decision may have hidden it, #295), or one it could not change
//     (also listed as a failure). Check why, then restore it by hand.
//   not-owned: another account owns this file, so the action left it unchanged.
//   A still-hidden note carries `restoredAt` once a guarded Restore made that
//   file public (see markStillHiddenRestored in worker/src/bulk-notes.ts).
export type BulkNote =
  | { kind: 'still-hidden'; sha256: string; restoredAt?: string }
  | { kind: 'not-owned'; sha256: string; owner: string };

// The most notes one invocation writes (see storeBulkNotes in
// worker/src/bulk-notes.ts for the D1 limits behind it).
export const MAX_NOTES_PER_WRITE = 5_000;

// Age review keeps each transition's notes, and its failure lines, in the same
// table as queued jobs' notes (bulk_job_notes), under
// age-review:<case id>:<version>:<state>, where version
// is the case version the transition's compare-and-swap wrote. That is unique
// per transition and the same on a repeat, so a repeated write stores nothing
// new. No case storage is added: the case screen asks for its case's latest.
//
// A case id is a UUID. Refusing anything but letters, digits and "-" keeps a
// ":" out, so one case's keys can never fall in another case's range.
const AGE_REVIEW_CASE_ID = /^[A-Za-z0-9-]+$/;

function ageReviewNotesPrefix(caseId: string): string {
  if (!AGE_REVIEW_CASE_ID.test(caseId)) throw new Error(`not an age review case id: ${JSON.stringify(caseId)}`);
  return `age-review:${caseId}:`;
}

export function ageReviewNotesJobId(caseId: string, version: number, state: string): string {
  return `${ageReviewNotesPrefix(caseId)}${version}:${state}`;
}

// The step (case state) a key was kept for, or null for a key that is not an
// age-review transition's. Whatever follows the version is the state, as
// written: a state added later in another shape still reads back, rather than
// quietly hiding its step's kept results.
export function ageReviewNotesStep(jobId: string): string | null {
  const match = /^age-review:[A-Za-z0-9-]+:\d+:(.+)$/s.exec(jobId);
  return match ? match[1] : null;
}

// Every key of one case's notes is in [start, end): its prefix, up to the same
// prefix with its last ":" raised to the next character, ";".
export function ageReviewNotesJobRange(caseId: string): { start: string; end: string } {
  const start = ageReviewNotesPrefix(caseId);
  return { start, end: `${start.slice(0, -1)};` };
}

// One page of a queued job's notes, or of an age-review transition's notes and
// failure lines, oldest first. `next` is the cursor for the following page, or
// null after the last one.
// `failures` are the failure lines age review kept beside a transition's notes
// (a queued job's stay on its bulk_jobs row); absent from a worker that keeps
// none.
export interface BulkNotesPage {
  notes: BulkNote[];
  failures?: string[];
  next: string | null;
}

// Async job model: /api/bulk-moderate enqueues a job and returns a jobId; a queue
// consumer runs the work and writes progress to the bulk_jobs table; the UI polls
// /api/bulk-moderate/status/:jobId.
// `done` means the consumer ran to completion; it does NOT imply every item
// succeeded -- partial per-item failures live in `failures[]`. Only a thrown /
// catastrophic error (or an abandoned, self-healed job) is `failed`. Callers
// derive overall success from `failures.length === 0`, mirroring BulkModerateResult.
export type BulkJobStatus = 'pending' | 'running' | 'done' | 'failed';

export type BulkJobPhase = 'events' | 'media';

// A bulk job is processed in chunks across multiple queue messages so an account
// of any size drains without hitting a single worker invocation's subrequest
// ceiling. The first message omits phase/cursor (start); each chunk re-enqueues
// the next with its continuation state, or finalizes the job.
//   - phase: 'events' (delete-all and delete-kind: ban per event) then, for
//     delete-all only, 'media' (moderate each video blob). The other actions
//     are media-only.
//   - cursor: opaque continuation for the current phase -- funnelcake v2
//     next_cursor for media's funnelcake walk, or the relay `until` timestamp
//     (stringified) for events. Absent = start of the phase.
//   - mediaPage: 0-based page index for the media phase, incremented each chunk.
//     Bounds the media phase on PAGES FETCHED (not items moderated), so a cursor
//     that advances forever while moderation fails still terminates. Absent = 0.
//   - jobId / kindJobId: the bulk_jobs row. A delete-kind message carries it as
//     kindJobId and never as jobId. A consumer from before delete-kind looks the
//     job up by msg.jobId; with none, its D1 bind throws inside its try before
//     any relay or media call, and it acks the message having done nothing. So a
//     worker rollback while a delete-kind job drains cannot run it as a whole-
//     account job. Every other action keeps jobId, the shape already in queues.
export type BulkJobMessage = BulkJobMessageFields & (
  | { jobId: string; kindJobId?: never }
  | { kindJobId: string; jobId?: never }
);

// The bulk_jobs id a message refers to, from the field its action uses.
export function bulkJobIdOf(msg: BulkJobMessage): string | undefined {
  return msg.action === 'delete-kind' ? msg.kindJobId : msg.jobId;
}

// The id field for a message of this action (see BulkJobMessage).
export function bulkJobIdField(action: BulkAction, jobId: string): { jobId: string } | { kindJobId: string } {
  return action === 'delete-kind' ? { kindJobId: jobId } : { jobId };
}

interface BulkJobMessageFields {
  pubkey: string;
  action: BulkAction;
  reason?: string;
  phase?: BulkJobPhase;
  cursor?: string;
  mediaPage?: number;
  // Event ids left from the current relay page. Carrying them in the next
  // message bounds serialized relay mutations without advancing the cursor.
  eventIds?: string[];
  version?: number;
  // delete-kind only (required there): the one event kind to delete. A
  // delete-kind job has no media phase.
  kind?: number;
  // delete-kind only: which sweep of the kind this is (0 = the first), and
  // how many events this sweep has deleted so far. A sweep that deleted
  // anything is followed by another, because banning the newest version of a
  // replaceable or addressable event makes the previous version visible.
  sweep?: number;
  sweepDeleted?: number;
  // delete-kind only: the job's sweep ceiling (unix seconds), fixed at enqueue
  // and used as `until` on the first page of every sweep.
  sweepUntil?: number;
  // Attribution for the per-event decision rows. Absent = the worker's signing
  // key and no report, which is what delete-all has always written.
  moderatorPubkey?: string;
  reportId?: string;
  // Media phase: which list this chunk walks (#299). Blossom's per-uploader
  // list first ('blossom', by hash, after `mediaAfter`), then funnelcake's
  // video list ('funnelcake', from `cursor`) for any file the uploader list
  // missed. Absent means start the media walk from the beginning. That
  // includes a media message from a worker that predates these fields: it
  // carries only funnelcake's `cursor`, which is ignored. A worker that
  // predates these fields ignores them and walks funnelcake's list.
  // un-age-restrict-all walks only funnelcake's list, from `cursor`, whatever
  // these say.
  mediaWalk?: 'blossom' | 'funnelcake';
  mediaAfter?: string;
  // Set on the funnelcake walk once a blossom-walk read of the uploader list
  // failed. The blossom walk then did not handle what the list shows, so the
  // funnelcake walk must not exclude it. Absent means the blossom walk ran to
  // its end. A worker that predates it never excludes anyway.
  mediaFallback?: boolean;
}

export interface BulkJob {
  jobId: string;
  pubkey: string;
  action: BulkAction;
  kind?: number;
  status: BulkJobStatus;
  eventsProcessed: number;
  mediaProcessed: number;
  // Optional because a worker older than #291 does not send it.
  mediaSkipped?: number;
  failures: string[];
  // How many notes the job stored (see BulkNote), counted by the status route;
  // the notes themselves are read from /api/bulk-moderate/notes/:jobId. Sent
  // only once the job is done or failed, and only by a worker that stores
  // notes (#299).
  noteCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface BulkEnqueueResponse {
  success: boolean;
  jobId: string;
}

// Per-kind event counts for one author, from a full paged relay listing.
// `complete` is false when the listing was cut short, so the counts are a
// lower bound.
export interface BulkKindCounts {
  counts: Record<string, number>;
  complete: boolean;
}

// How long the dialog waits for the kind counts. The worker's listing budget
// (KIND_COUNT_BUDGET_MS) must finish inside it, or the dialog gets a timeout
// instead of a lower bound it can show.
export const KIND_COUNTS_REQUEST_TIMEOUT_MS = 30_000;

// A job's `failures` are strings the worker writes and the by-kind dialog reads
// back. Both sides build and parse them only through these, so a reworded
// message can't silently stop the other side from recognising it:
//   event:<event id>:<error>       one event that could not be deleted
//   media:<sha256>:<error>         one file that could not be changed, or was
//                                  left unchanged because its status could not
//                                  be read or its two sources disagree (#291).
//                                  Files left for a person are notes, not
//                                  failures (see BulkNote)
//   enumeration:<pubkey>:<warning> something about listing the account
//   job:<reason>                   why the job stopped
//   +<N> more                      N more failures past the stored cap
// Event ids, sha256s and pubkeys are hex, so the first colon after one ends
// it; an error or warning may contain colons of its own.

const OVERFLOW_MARKER = /^\+(\d+) more$/;

export function formatOverflowMarker(dropped: number): string {
  return `+${dropped} more`;
}

// The count an overflow marker stands for, or null for any other string.
export function parseOverflowMarker(failure: string): number | null {
  const match = OVERFLOW_MARKER.exec(failure);
  return match ? Number(match[1]) : null;
}

// Age review keeps at most MAX_NOTES_PER_WRITE rows of a step's results; this
// marker, the last row kept, says how many more there were (notes and
// failures alike). An enumeration line, so a screen that does not know it
// still shows it.
const NOT_SAVED = / more file\(s\) or problem\(s\) from this step were not saved$/;

export function notSavedWarning(pubkey: string, count: number): string {
  return enumerationWarning(pubkey, `${count} more file(s) or problem(s) from this step were not saved`);
}

// The count a "not saved" marker stands for, or null for any other string.
export function parseNotSavedMarker(failure: string): number | null {
  const parsed = parseFailure(failure);
  if (parsed.type !== 'enumeration' || !NOT_SAVED.test(parsed.warning)) return null;
  const count = /^(\d+) /.exec(parsed.warning);
  return count ? Number(count[1]) : null;
}

// How many problems a job's failures stand for: each stored failure is one,
// except the "+N more" overflow marker and age review's "not saved" marker,
// which stand for N each.
export function countIssues(failures: string[]): number {
  return failures.reduce((n, failure) => n + (parseOverflowMarker(failure) ?? parseNotSavedMarker(failure) ?? 1), 0);
}

export function eventFailure(eventId: string, error: string): string {
  return `event:${eventId}:${error}`;
}

export function mediaFailure(sha256: string, error: string): string {
  return `media:${sha256}:${error}`;
}

// A media failure's error when the worker left the file alone instead of
// changing it (#291; mayChangeMedia in worker/src/bulk-moderate.ts): its owner
// or one of its two statuses could not be read, and an unreadable status is
// never treated as open.
export function statusUnreadableCause(error: string): string {
  return `could not read current status, left unchanged: ${error}`;
}

// The same, when the media server and the moderation record disagree, each
// status named as its service gave it.
export function statusDisagreeCause(blossomStatus: string, moderationStatus: string): string {
  return `status sources disagree (blossom ${blossomStatus}, moderation-service ${moderationStatus}), left unchanged`;
}

export function enumerationWarning(pubkey: string, warning: string): string {
  return `enumeration:${pubkey}:${warning}`;
}

// A queued job's chunk keeps at most MAX_NOTES_PER_WRITE notes; this counts
// the rest, which running the same action again lists.
export function notesOverflowWarning(pubkey: string, count: number): string {
  return enumerationWarning(pubkey, `${count} more note(s) than one run can store; act on these, then run it again to list the rest`);
}

// A queued job's chunk whose notes D1 would not store.
export function notesNotStoredWarning(pubkey: string, count: number, error: string): string {
  return enumerationWarning(pubkey, `could not store ${count} note(s) for a person: ${error}`);
}

// A bulk run that threw before it could report (a list it depends on could
// not be read, a relay timeout), so it has no failure lines of its own.
export function bulkLegStoppedWarning(pubkey: string, error: string): string {
  return enumerationWarning(pubkey, `the content step stopped before it finished: ${error}`);
}

// The media server's list of the account's files (#299) could not be read, so
// files were chosen from funnelcake's list alone: every file, or (a failed
// blossom-walk read) the rest of the walk. `error` names why.
// The count clause is a queued job's only: after its fallback the "left as
// they were" count can be off (see MediaPass in worker/src/bulk-moderate.ts),
// and its toast shows that count. The synchronous path walks every file once,
// so its count is exact. The files themselves are not affected either way.
export function listFallbackWarning(
  pubkey: string,
  error: string,
  { which = 'files', countMayBeOff }: { which?: 'files' | 'the rest'; countMayBeOff: boolean },
): string {
  const clause = countMayBeOff ? ', so the count of files left as they were may be off' : '';
  return enumerationWarning(pubkey, `${error}; ${which} were chosen from the relay's list only${clause}`);
}

// The end-of-walk check (#299) could not read the media server's list.
export function recheckUnreadableWarning(pubkey: string, error: string): string {
  return enumerationWarning(pubkey, `${error}; could not check for files left unchanged`);
}

// The end-of-walk check (#299) found more owned videos the action may still
// change than its one chunk takes.
export function stillUnchangedWarning(pubkey: string, count: number): string {
  return enumerationWarning(pubkey, `${count} more owned video files still listed unchanged after the walk`);
}

// Un-age-restrict All's report of files still hidden (#299) could not read
// the media server's list.
export function stillHiddenUnreadableWarning(pubkey: string, error: string): string {
  return enumerationWarning(pubkey, `${error}; the files still hidden could not be listed`);
}

// The relay sent events outside the requested author or kind; none were acted on.
export function outOfScopeWarning(pubkey: string, count: number): string {
  return enumerationWarning(pubkey, `relay returned ${count} event(s) outside the requested author or kind; ignored them`);
}

// The expiry cron keeps this line for a case it closed, before its bans, and
// clears it once the case's auto-delete has run and its own lines are kept.
// One still there means the delete did not run, or its outcome could not be
// recorded; the invocation ending first is the usual cause.
export function autoDeletePendingWarning(pubkey: string): string {
  return enumerationWarning(
    pubkey,
    'Auto-delete was not confirmed for this account: the expiry run may have stopped before deleting its content. Unless someone has done it since, open the account in the Users tab and run Delete All Content.',
  );
}

export function jobFailure(reason: string): string {
  return `job:${reason}`;
}

// Written by the status endpoint's stale-job heal.
export const ABANDONED_REASON = 'abandoned (no terminal update; worker likely evicted mid-run)';

export type ParsedFailure =
  | { type: 'overflow'; count: number }
  | { type: 'event'; id: string; error: string }
  | { type: 'media'; sha256: string; error: string }
  | { type: 'enumeration'; pubkey: string; warning: string }
  | { type: 'job'; reason: string; abandoned: boolean }
  | { type: 'other'; text: string };

export function parseFailure(failure: string): ParsedFailure {
  const count = parseOverflowMarker(failure);
  if (count !== null) return { type: 'overflow', count };
  const job = /^job:(.*)$/s.exec(failure);
  if (job) return { type: 'job', reason: job[1], abandoned: job[1].startsWith('abandoned') };
  const enumeration = /^enumeration:([^:]+):(.*)$/s.exec(failure);
  if (enumeration) return { type: 'enumeration', pubkey: enumeration[1], warning: enumeration[2] };
  const event = /^event:([^:]+):(.*)$/s.exec(failure);
  if (event) return { type: 'event', id: event[1], error: event[2] };
  const media = /^media:([^:]+):(.*)$/s.exec(failure);
  if (media) return { type: 'media', sha256: media[1], error: media[2] };
  return { type: 'other', text: failure };
}

// The two warnings that say a listing may have missed events, as opposed to
// the out-of-scope and sweep-bound ones. A later listing that finds nothing can
// disprove them; isListingGapWarning recognises them for that.
const SAME_SECOND = 'events share one timestamp';
const UNPAGINATED = 'relay could not be fully paginated';

export function sameSecondGapWarning(pubkey: string, pageSize: number): string {
  return enumerationWarning(pubkey, `more than ${pageSize} ${SAME_SECOND}; some at that second may be unprocessed`);
}

// `consequence` says what the caller did with the partial listing.
export function unpaginatedGapWarning(pubkey: string, consequence: string): string {
  return enumerationWarning(pubkey, `${UNPAGINATED}; ${consequence}`);
}

export function isListingGapWarning(failure: string): boolean {
  const parsed = parseFailure(failure);
  if (parsed.type !== 'enumeration') return false;
  return new RegExp(`^more than \\d+ ${SAME_SECOND}`).test(parsed.warning) || parsed.warning.startsWith(UNPAGINATED);
}
