import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { useBulkModerateJob } from './useBulkModerateJob';

// Two environments' clients; the hook uses whichever is current at render.
const clients = vi.hoisted(() => {
  const make = () => ({ bulkModerate: vi.fn(), getBulkJobStatus: vi.fn() });
  const staging = make();
  const production = make();
  return { staging, production, current: staging };
});
vi.mock('@/hooks/useAdminApi', () => ({ useAdminApi: () => clients.current }));

const ACCOUNT = 'a'.repeat(64);

describe('useBulkModerateJob start', () => {
  it('enqueues on the environment it was started in, even if it changes before the enqueue runs', async () => {
    for (const client of [clients.staging, clients.production]) {
      client.bulkModerate.mockResolvedValue({ success: true, jobId: 'job-1' });
    }
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
    const { result, rerender } = renderHook(() => useBulkModerateJob({ pubkey: ACCOUNT }), { wrapper });

    // The caller holds the start from the render where the moderator confirmed,
    // and awaits something (the moderator's identity) before calling it.
    const confirmedStart = result.current.startAsync;
    clients.current = clients.production;
    rerender();
    await act(async () => { await confirmedStart('delete-kind', { kind: 7 }); });

    expect(clients.staging.bulkModerate).toHaveBeenCalledTimes(1);
    expect(clients.production.bulkModerate).not.toHaveBeenCalled();
    // The job runs detached: the now-selected environment does not poll it.
    expect(clients.production.getBulkJobStatus).not.toHaveBeenCalled();
    clients.current = clients.staging;
  });
});
