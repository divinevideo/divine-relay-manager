// ABOUTME: Enqueue a bulk moderation job and poll its status until terminal.
// ABOUTME: /api/bulk-moderate returns a jobId immediately; the work runs in a
// queue consumer, so the UI enqueues then polls /api/bulk-moderate/status/:jobId.
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useAdminApi } from '@/hooks/useAdminApi';
import type { BulkAction, BulkJob } from '@/lib/adminApi';

const POLL_INTERVAL_MS = 1500;

const isTerminal = (status?: string): boolean => status === 'done' || status === 'failed';

interface UseBulkModerateJobOptions {
  pubkey: string;
  // Called once when a job reaches a terminal state (done or failed).
  onComplete?: (job: BulkJob) => void;
  // Called if the enqueue fails, or if the status poll keeps failing (worker
  // unreachable) so the UI doesn't poll — and stay disabled — forever.
  onError?: (error: Error) => void;
}

export function useBulkModerateJob({ pubkey, onComplete, onError }: UseBulkModerateJobOptions) {
  const api = useAdminApi();
  const [jobId, setJobId] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<BulkAction | null>(null);
  // Guard against re-firing onComplete/onError for the same job.
  const notifiedJobId = useRef<string | null>(null);

  const enqueue = useMutation({
    mutationFn: (action: BulkAction) => api.bulkModerate(pubkey, action, `Bulk ${action} by moderator`),
    onMutate: (action) => { setPendingAction(action); },
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
  }, [pubkey]);

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

  // Surface a persistent status-fetch failure so the buttons don't stay disabled
  // with no feedback.
  useEffect(() => {
    if (jobId && statusQuery.isError && notifiedJobId.current !== jobId) {
      notifiedJobId.current = jobId;
      onError?.(
        statusQuery.error instanceof Error
          ? statusQuery.error
          : new Error('Lost track of the bulk job. Re-check the user and retry if needed.'),
      );
    }
  }, [statusQuery.isError, statusQuery.error, jobId, onError]);

  // Running = enqueueing, or a job exists that hasn't reached a terminal state
  // and hasn't given up on polling.
  const isRunning =
    enqueue.isPending || (jobId !== null && !isTerminal(job?.status) && !statusQuery.isError);
  const runningAction: BulkAction | null = isRunning ? (job?.action ?? pendingAction) : null;

  return {
    start: (action: BulkAction) => enqueue.mutate(action),
    startAsync: (action: BulkAction) => enqueue.mutateAsync(action),
    job,
    isRunning,
    runningAction,
  };
}
