// age-restrict-all is the age-review withhold (hides a suspected minor's videos
// from everyone but the owner). age-gate-all is the moderator's "Age Restrict All"
// (puts the videos behind the 18+ gate). Keep them separate: #290.
export const VALID_BULK_ACTIONS = ['age-restrict-all', 'age-gate-all', 'un-age-restrict-all', 'delete-all'] as const;

export type BulkAction = typeof VALID_BULK_ACTIONS[number];

export interface BulkModerateResult {
  success: boolean;
  eventsProcessed: number;
  // Media changed. Media left alone because its current status already met or
  // beat the action (see MAY_CHANGE_FROM in worker/src/bulk-moderate.ts) is
  // mediaSkipped, and is not a failure.
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
//   - phase: 'events' (delete-all only: ban per event) then 'media'
//     (moderate each video blob). The other actions are media-only.
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
}

export interface BulkJob {
  jobId: string;
  pubkey: string;
  action: BulkAction;
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
