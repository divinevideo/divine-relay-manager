// ABOUTME: Enqueue a bulk moderation job and poll its status until terminal.
// ABOUTME: /api/bulk-moderate returns a jobId immediately; the work runs in a
// queue consumer, so the UI enqueues then polls /api/bulk-moderate/status/:jobId.
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useAdminApi } from '@/hooks/useAdminApi';
import type { BulkAction, BulkJob, BulkModerateOptions } from '@/lib/adminApi';

const POLL_INTERVAL_MS = 1500;

const isTerminal = (status?: string): boolean => status === 'done' || status === 'failed';

// Optional per-job settings. `reason` defaults to "Bulk <action> by moderator";
// the rest scopes or attributes the job (see BulkModerateOptions).
export interface BulkJobStart extends BulkModerateOptions {
  reason?: string;
}

interface UseBulkModerateJobOptions {
  pubkey: string;
  // Called once when a job reaches a terminal state (done or failed).
  onComplete?: (job: BulkJob) => void;
  // Called if the enqueue fails. A failed status poll is not reported here: the
  // job may still be running, so it is tracking that was lost, not the job.
  onError?: (error: Error) => void;
  // Called once each time the status poll gives out while a job is held (see
  // `trackingLost`).
  onTrackingLost?: () => void;
}

export function useBulkModerateJob({ pubkey, onComplete, onError, onTrackingLost }: UseBulkModerateJobOptions) {
  const api = useAdminApi();
  const [jobId, setJobId] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<BulkAction | null>(null);
  // Guard against re-firing onComplete for the same job.
  const notifiedJobId = useRef<string | null>(null);
  // Guard against re-firing onTrackingLost for the same loss.
  const lostNotified = useRef(false);

  const enqueue = useMutation({
    mutationFn: ({ action, options }: { action: BulkAction; options?: BulkJobStart }) => {
      const reason = options?.reason ?? `Bulk ${action} by moderator`;
      if (!options) return api.bulkModerate(pubkey, action, reason);
      // Rest-spread, not a field list, so a new BulkModerateOptions field is
      // forwarded without this line having to learn about it.
      const { reason: _reason, ...scope } = options;
      return api.bulkModerate(pubkey, action, reason, scope);
    },
    onMutate: ({ action }) => { setPendingAction(action); },
    onSuccess: (res) => { setJobId(res.jobId); },
    onError: (error: Error) => { setPendingAction(null); onError?.(error); },
  });

  // Detach from any in-flight job when the target user changes. UserActions is
  // reused (not remounted) across user selections, so without this the next
  // user's buttons would reflect the previous job and onComplete would log the
  // audit under the wrong pubkey. The worker still finishes the detached job.
  useEffect(() => {
    setJobId(null);
    setPendingAction(null);
    notifiedJobId.current = null;
    lostNotified.current = false;
  }, [pubkey]);

  // No fixed client give-up timer: a chunked job can legitimately run longer than
  // any timer, and re-enabling the destructive buttons under a still-running job
  // would let a moderator start a second, duplicate job against the same target.
  // Instead the buttons stay disabled until the job is terminal. The worker's
  // stale-heal flips an abandoned job to `failed` within STALE_JOB_MS, so a
  // terminal status is always reached. A persistent status-fetch failure stops
  // polling and sets `trackingLost`; `checkAgain` resumes it.
  const statusQuery = useQuery({
    queryKey: ['bulk-job', pubkey, jobId],
    queryFn: () => api.getBulkJobStatus(jobId as string),
    enabled: jobId !== null,
    refetchInterval: (query) => {
      if (isTerminal((query.state.data as BulkJob | undefined)?.status)) return false;
      // Persistent fetch failure (after the QueryClient's retries): stop polling.
      if (query.state.status === 'error') return false;
      return POLL_INTERVAL_MS;
    },
  });

  const job = statusQuery.data;

  // Fire onComplete once per job, only while it still belongs to the selected user.
  useEffect(() => {
    if (job && isTerminal(job.status) && job.pubkey === pubkey && notifiedJobId.current !== job.jobId) {
      notifiedJobId.current = job.jobId;
      onComplete?.(job);
    }
  }, [job, pubkey, onComplete]);

  // The status read failed while a job is held and not known to be finished.
  // That is not a failed job: it may still be running on the server. Callers
  // keep their destructive buttons off and offer `checkAgain`.
  const trackingLost = jobId !== null && statusQuery.isError && !isTerminal(job?.status);

  useEffect(() => {
    if (trackingLost && !lostNotified.current) {
      lostNotified.current = true;
      onTrackingLost?.();
    } else if (!trackingLost) {
      lostNotified.current = false;
    }
  }, [trackingLost, onTrackingLost]);

  // Running = enqueueing, or a job exists that hasn't reached a terminal state and
  // whose status we can still read. Lost tracking is reported separately.
  const isRunning =
    enqueue.isPending || (jobId !== null && !isTerminal(job?.status) && !statusQuery.isError);
  const runningAction: BulkAction | null = isRunning ? (job?.action ?? pendingAction) : null;

  return {
    start: (action: BulkAction, options?: BulkJobStart) => enqueue.mutate({ action, options }),
    startAsync: (action: BulkAction, options?: BulkJobStart) => enqueue.mutateAsync({ action, options }),
    job,
    isRunning,
    runningAction,
    trackingLost,
    // Re-read the held job's status after tracking was lost.
    checkAgain: () => { void statusQuery.refetch(); },
  };
}
