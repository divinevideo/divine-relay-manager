// ABOUTME: Read every note a bulk run stored for a person (#299): a finished
// ABOUTME: queued job's, or an age-review case's latest step that kept any.
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

// What an age-review case kept from its latest transition that kept anything:
// the step (`state`), when it ran, its failure lines and notes, as the
// case-notes route reports them. The case does not store them; the worker
// keeps them under the case (see ageReviewNotesJobId), so they survive a
// reload.
export interface KeptAgeReviewResults {
  state: string;
  keptAt?: string;
  notes: BulkNote[];
  failures: string[];
}

export function useAgeReviewBulkNotes(caseId: string) {
  const api = useAdminApi();
  return useQuery({
    queryKey: ['age-review-bulk-notes', caseId],
    // Read again on every open, not cached for the app's default: a file may
    // have been restored meanwhile, in another session or on another screen,
    // and its row should say so. Not on every window focus, though: that
    // would page through up to MAX_NOTES_PER_WRITE rows each time the
    // moderator comes back to the tab. A Restore refreshes it itself.
    staleTime: 0,
    refetchOnWindowFocus: false,
    queryFn: async (): Promise<KeptAgeReviewResults | null> => {
      let found: { jobId: string | null; state?: string; keptAt?: string };
      try {
        found = await api.getAgeReviewBulkNotesJob(caseId);
      } catch (error) {
        if (routeMissing(error)) return null;
        throw error;
      }
      if (found.jobId === null || !found.state) return null;
      return { state: found.state, keptAt: found.keptAt, ...await readAllNotes(api, found.jobId) };
    },
  });
}
