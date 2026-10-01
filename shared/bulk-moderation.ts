// delete-kind deletes one event kind and nothing else. It is a separate action
// (not delete-all plus a kind) so a worker that predates it rejects it as
// unknown instead of running delete-all.
export const VALID_BULK_ACTIONS = ['age-restrict-all', 'un-age-restrict-all', 'delete-all', 'delete-kind'] as const;

export type BulkAction = typeof VALID_BULK_ACTIONS[number];

// The whole-account actions, the only ones the synchronous path can run.
export type AccountBulkAction = Exclude<BulkAction, 'delete-kind'>;

export interface BulkModerateResult {
  success: boolean;
  eventsProcessed: number;
  mediaProcessed: number;
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
//     delete-all only, 'media' (moderate each video blob).
//     age-restrict/un-age-restrict are media-only.
//   - cursor: opaque continuation for the current phase -- funnelcake v2
//     next_cursor for media, or the relay `until` timestamp (stringified) for
//     events. Absent = start of the phase.
//   - mediaPage: 0-based page index for the media phase, incremented each chunk.
//     Bounds the media phase on PAGES FETCHED (not items moderated), so a cursor
//     that advances forever while moderation fails still terminates. Absent = 0.
export interface BulkJobMessage {
  jobId: string;
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
