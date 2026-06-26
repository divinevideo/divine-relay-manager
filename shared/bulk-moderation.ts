export const VALID_BULK_ACTIONS = ['age-restrict-all', 'un-age-restrict-all', 'delete-all'] as const;

export type BulkAction = typeof VALID_BULK_ACTIONS[number];

export interface BulkModerateResult {
  success: boolean;
  eventsProcessed: number;
  mediaProcessed: number;
  failures: string[];
}

// Async job model: /api/bulk-moderate enqueues a job and returns a jobId; a queue
// consumer runs the work and writes progress to the bulk_jobs table; the UI polls
// /api/bulk-moderate/status/:jobId.
export type BulkJobStatus = 'pending' | 'running' | 'done' | 'failed';

export interface BulkJobMessage {
  jobId: string;
  pubkey: string;
  action: BulkAction;
  reason?: string;
}

export interface BulkJob {
  jobId: string;
  pubkey: string;
  action: BulkAction;
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
