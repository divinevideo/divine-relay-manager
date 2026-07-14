import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const { useDivineSession } = vi.hoisted(() => ({ useDivineSession: vi.fn() }));
vi.mock('@/hooks/useDivineSession', () => ({ useDivineSession }));
vi.mock('@/hooks/useAuthor', () => ({
  useAuthor: (pubkey?: string) => ({ data: { metadata: pubkey ? { name: 'Mod' } : undefined } }),
}));

import { useCurrentUser } from './useCurrentUser';

const PUBKEY = 'b'.repeat(64);
const signer = { getPublicKey: vi.fn(), signEvent: vi.fn() };

beforeEach(() => vi.clearAllMocks());

describe('useCurrentUser', () => {
  it('returns undefined user when the session has no pubkey', () => {
    useDivineSession.mockReturnValue({ pubkey: undefined, signer: null });
    const { result } = renderHook(() => useCurrentUser());
    expect(result.current.user).toBeUndefined();
    expect(result.current.users).toEqual([]);
  });

  it('returns the moderator user when pubkey and signer are present', () => {
    useDivineSession.mockReturnValue({ pubkey: PUBKEY, signer });
    const { result } = renderHook(() => useCurrentUser());
    expect(result.current.user).toEqual({ pubkey: PUBKEY, signer });
    expect(result.current.users).toEqual([{ pubkey: PUBKEY, signer }]);
    expect(result.current.metadata).toEqual({ name: 'Mod' });
  });

  it('returns undefined user when a pubkey exists but the signer is missing', () => {
    useDivineSession.mockReturnValue({ pubkey: PUBKEY, signer: null });
    const { result } = renderHook(() => useCurrentUser());
    expect(result.current.user).toBeUndefined();
  });
});
