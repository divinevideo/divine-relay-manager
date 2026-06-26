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
  // Called if the enqueue request itself fails (before a job exists).
  onError?: (error: Error) => void;
}

export function useBulkModerateJob({ pubkey, onComplete, onError }: UseBulkModerateJobOptions) {
  const api = useAdminApi();
  const [jobId, setJobId] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<BulkAction | null>(null);
  // Guard against re-firing onComplete on subsequent polls / re-renders.
  const notifiedJobId = useRef<string | null>(null);

  const statusQuery = useQuery({
    queryKey: ['bulk-job', pubkey, jobId],
    queryFn: () => api.getBulkJobStatus(jobId as string),
    enabled: jobId !== null,
    // Poll until terminal, then stop.
    refetchInterval: (query) =>
      isTerminal((query.state.data as BulkJob | undefined)?.status) ? false : POLL_INTERVAL_MS,
  });

  const job = statusQuery.data;

  useEffect(() => {
    if (job && isTerminal(job.status) && notifiedJobId.current !== job.jobId) {
      notifiedJobId.current = job.jobId;
      onComplete?.(job);
    }
  }, [job, onComplete]);

  const enqueue = useMutation({
    mutationFn: (action: BulkAction) => api.bulkModerate(pubkey, action, `Bulk ${action} by moderator`),
    onMutate: (action) => { setPendingAction(action); },
    onSuccess: (res) => { setJobId(res.jobId); },
    onError: (error: Error) => { setPendingAction(null); onError?.(error); },
  });

  // Running = enqueueing, or a job exists that hasn't reached a terminal state.
  const isRunning = enqueue.isPending || (jobId !== null && !isTerminal(job?.status));
  const runningAction: BulkAction | null = isRunning ? (job?.action ?? pendingAction) : null;

  return {
    start: (action: BulkAction) => enqueue.mutate(action),
    startAsync: (action: BulkAction) => enqueue.mutateAsync(action),
    job,
    isRunning,
    runningAction,
  };
}
