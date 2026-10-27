// ABOUTME: Read every note a finished queued bulk job stored for a person (#299),
// ABOUTME: a page at a time.
import { useQuery } from '@tanstack/react-query';
import { useAdminApi } from '@/hooks/useAdminApi';
import { isTerminal } from '@/hooks/useBulkModerateJob';
import { ApiError, type BulkJob, type BulkNote } from '@/lib/adminApi';

type AdminApi = ReturnType<typeof useAdminApi>;

// Every page of one job's notes and kept failure lines, from
// /api/bulk-moderate/notes/:jobId.
async function readAllNotes(api: AdminApi, jobId: string): Promise<{ notes: BulkNote[]; failures: string[] }> {
  const notes: BulkNote[] = [];
  const failures: string[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await api.getBulkJobNotes(jobId, after);
    notes.push(...page.notes);
    failures.push(...(page.failures ?? []));
    if (page.next === null) return { notes, failures };
    // Every page must move on, or a broken cursor would read forever.
    if (page.next === after) throw new Error('the notes did not page forward');
    after = page.next;
  }
}

// A worker that predates notes has no such route, and stored none.
const routeMissing = (error: unknown) => error instanceof ApiError && error.statusCode === 404;

// Read once the job has ended. A job whose status says it stored none is not
// read at all. One whose status carries no count is read anyway: the worker
// either predates notes (its 404 for the route means none) or could not count
// them (the route then answers, or its error is shown).
export function useBulkJobNotes(job: BulkJob | undefined) {
  const api = useAdminApi();
  const jobId = job?.jobId;
  const noteCount = job?.noteCount;
  return useQuery({
    queryKey: ['bulk-job-notes', jobId],
    enabled: job !== undefined && isTerminal(job.status) && noteCount !== 0,
    // A finished job's notes change only when one is marked restored, and a
    // Restore refreshes this query itself (BulkNotesPanel).
    staleTime: Infinity,
    queryFn: async (): Promise<BulkNote[]> => {
      try {
        return (await readAllNotes(api, jobId as string)).notes;
      } catch (error) {
        if (noteCount === undefined && routeMissing(error)) return [];
        throw error;
      }
    },
  });
}
