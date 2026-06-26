// ABOUTME: Enqueue a bulk moderation job and poll its status until terminal.
// ABOUTME: /api/bulk-moderate returns a jobId immediately; the work runs in a
// queue consumer, so the UI enqueues then polls /api/bulk-moderate/status/:jobId.
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useAdminApi } from '@/hooks/useAdminApi';
import type { BulkAction, BulkJob } from '@/lib/adminApi';

const POLL_INTERVAL_MS = 1500;
// Give up polling after this long even if the job never reaches a terminal state
// (e.g. the consumer was evicted mid-run and the server-side stale-heal hasn't
// fired yet). Generous: real jobs finish well within a worker invocation's
// budget; this only bounds the abandoned case so the buttons don't stay disabled.
const MAX_POLL_MS = 10 * 60 * 1000;

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
  // Set true once we stop waiting on a job that never went terminal in time.
  const [gaveUp, setGaveUp] = useState(false);
  // Guard against re-firing onComplete/onError for the same job.
  const notifiedJobId = useRef<string | null>(null);

  const enqueue = useMutation({
    mutationFn: (action: BulkAction) => api.bulkModerate(pubkey, action, `Bulk ${action} by moderator`),
    onMutate: (action) => { setPendingAction(action); },
    onSuccess: (res) => { setGaveUp(false); setJobId(res.jobId); },
    onError: (error: Error) => { setPendingAction(null); onError?.(error); },
  });

  // Detach from any in-flight job when the target user changes. UserActions is
  // reused (not remounted) across user selections, so without this the next
  // user's buttons would reflect the previous job and onComplete would log the
  // audit under the wrong pubkey. The worker still finishes the detached job.
  useEffect(() => {
    setJobId(null);
    setPendingAction(null);
    setGaveUp(false);
    notifiedJobId.current = null;
  }, [pubkey]);

  // Bound the wait: if the job hasn't gone terminal within MAX_POLL_MS, stop.
  useEffect(() => {
    if (jobId === null) return;
    const timer = setTimeout(() => setGaveUp(true), MAX_POLL_MS);
    return () => clearTimeout(timer);
  }, [jobId]);

  const statusQuery = useQuery({
    queryKey: ['bulk-job', pubkey, jobId],
    queryFn: () => api.getBulkJobStatus(jobId as string),
    enabled: jobId !== null && !gaveUp,
    refetchInterval: (query) => {
      if (isTerminal((query.state.data as BulkJob | undefined)?.status)) return false;
      // Persistent fetch failure (after the QueryClient's retries): stop polling.
      if (query.state.status === 'error') return false;
      return POLL_INTERVAL_MS;
    },
  });

  const job = statusQuery.data;

  // Surface the give-up so the buttons re-enable and the moderator gets feedback.
  useEffect(() => {
    if (gaveUp && jobId && !isTerminal(job?.status) && notifiedJobId.current !== jobId) {
      notifiedJobId.current = jobId;
      onError?.(new Error('Bulk job is taking too long to confirm. Re-check the user and retry if needed.'));
    }
  }, [gaveUp, jobId, job, onError]);

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
    enqueue.isPending || (jobId !== null && !isTerminal(job?.status) && !statusQuery.isError && !gaveUp);
  const runningAction: BulkAction | null = isRunning ? (job?.action ?? pendingAction) : null;

  return {
    start: (action: BulkAction) => enqueue.mutate(action),
    startAsync: (action: BulkAction) => enqueue.mutateAsync(action),
    job,
    isRunning,
    runningAction,
  };
}
