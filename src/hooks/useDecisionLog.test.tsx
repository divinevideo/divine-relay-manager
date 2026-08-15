import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getDecisions = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/useAdminApi', () => ({
  useAdminApi: () => ({ getDecisions }),
}));

import { useDecisionLog } from './useDecisionLog';

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('useDecisionLog auto-hide state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('offers pending-review controls for a newer unresolved auto-hide', async () => {
    getDecisions.mockResolvedValue([
      { action: 'auto_hide_unresolved' },
      { action: 'auto_hide_restored' },
    ]);

    const { result } = renderHook(() => useDecisionLog('event-id'), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.isAutoHidden).toBe(true);
    expect(result.current.isPendingReview).toBe(true);
    expect(result.current.isAutoHideRestored).toBe(false);
  });

  it('does not reopen controls after a newer restore settles unresolved state', async () => {
    getDecisions.mockResolvedValue([
      { action: 'auto_hide_restored' },
      { action: 'auto_hide_unresolved' },
    ]);

    const { result } = renderHook(() => useDecisionLog('event-id'), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.isAutoHidden).toBe(false);
    expect(result.current.isPendingReview).toBe(false);
    expect(result.current.isAutoHideRestored).toBe(true);
  });
});
