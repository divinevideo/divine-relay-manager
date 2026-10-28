import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BulkJob } from '@/lib/adminApi';

const getBulkJobNotes = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/useAdminApi', () => ({
  useAdminApi: () => ({ getBulkJobNotes }),
}));

import { useBulkJobNotes } from './useBulkJobNotes';

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const JOB = { jobId: 'job-1', status: 'done', noteCount: 3 } as BulkJob;
const note = (n: number) => ({ kind: 'still-hidden' as const, sha256: String(n).repeat(64) });

describe('useBulkJobNotes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reads every page of a finished job's notes, following each page's cursor", async () => {
    getBulkJobNotes
      .mockResolvedValueOnce({ notes: [note(1), note(2)], next: '2' })
      .mockResolvedValueOnce({ notes: [note(3)], next: null });

    const { result } = renderHook(() => useBulkJobNotes(JOB), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual([note(1), note(2), note(3)]);
    expect(getBulkJobNotes.mock.calls).toEqual([['job-1', undefined], ['job-1', '2']]);
  });

  // A broken cursor must end in an error the panel shows, not a read that
  // never ends.
  it('stops with an error when a page does not move the cursor on', async () => {
    // The same cursor twice, then an end: without the guard the read would
    // finish with a page counted twice instead of failing.
    getBulkJobNotes
      .mockResolvedValueOnce({ notes: [note(1)], next: '7' })
      .mockResolvedValueOnce({ notes: [note(1)], next: '7' })
      .mockResolvedValue({ notes: [], next: null });

    const { result } = renderHook(() => useBulkJobNotes(JOB), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect((result.current.error as Error).message).toBe('the notes did not page forward');
    expect(getBulkJobNotes).toHaveBeenCalledTimes(2);
  });
});
