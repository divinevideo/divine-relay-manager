// ABOUTME: Pins that a media status the moderation service could not answer is
// ABOUTME: marked unreadable, never read as "not blocked".

import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { useMediaStatus } from './useMediaStatus';

// Full-length 64-char hex hashes, never truncated.
const VIDEO = '81661ca024bec2be842557ff7e07c833660038f134203f10293568f5ea11863f';
const THUMB = 'b06e68dbec25463be257e44b06b0bcbb376d3cd1d5fa47e41747ead9e290e068';

const readMediaStatus = vi.hoisted(() => vi.fn());
vi.mock('@/hooks/useAdminApi', () => ({ useAdminApi: () => ({ readMediaStatus }) }));

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe('useMediaStatus', () => {
  it('marks a status it could not read as unreadable, not as open', async () => {
    readMediaStatus.mockImplementation(async (hash: string) => {
      if (hash === THUMB) throw new Error('HTTP 500: Internal Server Error');
      return { sha256: VIDEO, action: 'PERMANENT_BAN' };
    });

    const { result } = renderHook(() => useMediaStatus([VIDEO, THUMB]), { wrapper });

    await waitFor(() => expect(result.current.results).toHaveLength(2));
    expect(result.current.results).toEqual([
      expect.objectContaining({ hash: VIDEO, action: 'PERMANENT_BAN', isBlocked: true, unreadable: false }),
      expect.objectContaining({ hash: THUMB, action: null, isBlocked: false, isRestricted: false, unreadable: true }),
    ]);
  });

  it('reads no decision as open and readable', async () => {
    readMediaStatus.mockResolvedValue(null);

    const { result } = renderHook(() => useMediaStatus([VIDEO]), { wrapper });

    await waitFor(() => expect(result.current.results).toHaveLength(1));
    expect(result.current.results[0]).toEqual(
      expect.objectContaining({ hash: VIDEO, action: null, isBlocked: false, isRestricted: false, unreadable: false }),
    );
  });
});
