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
//     next_cursor for media, or the relay `until` timestamp (stringified) for
//     events. Absent = start of the phase.
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
//                                  be read or its two sources disagree (#291)
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

export function eventFailure(eventId: string, error: string): string {
  return `event:${eventId}:${error}`;
}

export function mediaFailure(sha256: string, error: string): string {
  return `media:${sha256}:${error}`;
}

export function enumerationWarning(pubkey: string, warning: string): string {
  return `enumeration:${pubkey}:${warning}`;
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
