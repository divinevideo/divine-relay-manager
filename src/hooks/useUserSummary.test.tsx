// ABOUTME: Tests useUserSummary's request body — specifically that it caps the
// ABOUTME: reports/labels sent to the AI summarizer, independent of how much
// ABOUTME: history useUserStats now reads (#reports-queue-completeness).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { NostrEvent } from '@nostrify/nostrify';

vi.mock('@/hooks/useAdminApi', () => ({
  useApiUrl: () => 'https://api.example.test',
}));

import { useUserSummary, SUMMARY_HISTORY_LIMIT } from './useUserSummary';

const PUBKEY = 'd4'.repeat(32);

function event(kind: number, id: string, createdAt: number): NostrEvent {
  return { id, pubkey: PUBKEY, kind, tags: [], content: '', created_at: createdAt, sig: '' };
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('useUserSummary', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ summary: 'ok', riskLevel: 'low' }),
    }));
  });

  it('caps reports and labels sent to the AI summarizer at the newest 50, regardless of how much history is passed in', async () => {
    // Deliberately out of order and spanning more than 50, so a correct
    // implementation must both sort and slice rather than trust input order.
    const reports = Array.from({ length: 80 }, (_, i) => event(1984, i.toString(16).padStart(64, '0'), i));
    const labels = Array.from({ length: 80 }, (_, i) => event(1985, i.toString(16).padStart(64, '1'), i));
    // Shuffle so the newest-first assumption can't be satisfied by accident.
    const shuffledReports = [...reports].reverse();
    const shuffledLabels = [...labels].reverse();

    const { result } = renderHook(
      () => useUserSummary(PUBKEY, [event(1, 'a'.repeat(64), 1)], shuffledLabels, shuffledReports),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);

    expect(body.reportHistory).toHaveLength(SUMMARY_HISTORY_LIMIT);
    expect(body.existingLabels).toHaveLength(SUMMARY_HISTORY_LIMIT);

    // Newest 50 by created_at: 79 down to 30.
    const expectedCreatedAts = Array.from({ length: 50 }, (_, i) => 79 - i);
    expect(body.reportHistory.map((r: { created_at: number }) => r.created_at)).toEqual(expectedCreatedAts);
    expect(body.existingLabels.map((l: { created_at: number }) => l.created_at)).toEqual(expectedCreatedAts);

    // Inputs must not be mutated (the caller's arrays are shared with useUserStats' cache).
    expect(shuffledReports[0].created_at).toBe(79);
    expect(shuffledLabels[0].created_at).toBe(79);
  });
});
