import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const { useDivineSession, getPublicKey, DivineRpcSigner } = vi.hoisted(() => {
  const getPublicKey = vi.fn();
  return {
    useDivineSession: vi.fn(),
    getPublicKey,
    DivineRpcSigner: vi.fn().mockImplementation(() => ({ getPublicKey, signEvent: vi.fn() })),
  };
});
vi.mock('@/hooks/useDivineSession', () => ({ useDivineSession }));
vi.mock('@/lib/divineSigner', () => ({ DivineRpcSigner }));
vi.mock('@/hooks/useAuthor', () => ({
  useAuthor: () => ({ data: { metadata: { name: 'Mod' } } }),
}));

import { useCurrentUser } from './useCurrentUser';

const PUBKEY = 'b'.repeat(64);

beforeEach(() => {
  vi.clearAllMocks();
  getPublicKey.mockResolvedValue(PUBKEY);
});

describe('useCurrentUser', () => {
  it('returns undefined user with no session', () => {
    useDivineSession.mockReturnValue({ credentials: null });
    const { result } = renderHook(() => useCurrentUser());
    expect(result.current.user).toBeUndefined();
  });

  it('resolves the moderator pubkey from the session token', async () => {
    useDivineSession.mockReturnValue({ credentials: { accessToken: 'tok', bunkerUrl: 'bunker://x' } });
    const { result } = renderHook(() => useCurrentUser());
    await waitFor(() => expect(result.current.user?.pubkey).toBe(PUBKEY));
    expect(result.current.metadata).toEqual({ name: 'Mod' });
  });

  it('yields no user when getPublicKey returns a non-canonical pubkey', async () => {
    useDivineSession.mockReturnValue({ credentials: { accessToken: 'tok', bunkerUrl: 'bunker://x' } });
    getPublicKey.mockResolvedValue('NOT-HEX');
    const { result } = renderHook(() => useCurrentUser());
    await new Promise((r) => setTimeout(r, 20));
    expect(result.current.user).toBeUndefined();
  });

  it('yields no user when getPublicKey rejects', async () => {
    useDivineSession.mockReturnValue({ credentials: { accessToken: 'tok', bunkerUrl: 'bunker://x' } });
    getPublicKey.mockRejectedValue(new Error('rpc down'));
    const { result } = renderHook(() => useCurrentUser());
    await new Promise((r) => setTimeout(r, 20));
    expect(result.current.user).toBeUndefined();
  });
});
