import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useAdminApi } from './useAdminApi';

// useAdminApi binds apiUrl onto each adminApi function. That binding is a hand
// written argument list per function, so an argument added downstream is
// silently dropped here unless the wrapper is updated too -- and TypeScript
// cannot see it, because the wrapper's own signature still declares the
// parameter it forgot to pass on. Component tests mock this hook wholesale, so
// nothing else exercises the real wrapper.

const API_URL = 'https://api.example';

vi.mock('@/hooks/useAppContext', () => ({
  useAppContext: () => ({ config: { apiUrl: API_URL, relayUrl: 'wss://relay.example' } }),
}));

const deleteDecisions = vi.hoisted(() => vi.fn());
vi.mock('@/lib/adminApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/adminApi')>()),
  deleteDecisions,
}));

describe('useAdminApi', () => {
  it('forwards the reopen target type through to adminApi', () => {
    const { result } = renderHook(() => useAdminApi());

    result.current.deleteDecisions('abc', 'pubkey');

    expect(deleteDecisions).toHaveBeenCalledWith(API_URL, 'abc', 'pubkey');
  });

  it('leaves the target type undefined when the caller omits it', () => {
    const { result } = renderHook(() => useAdminApi());

    result.current.deleteDecisions('abc');

    expect(deleteDecisions).toHaveBeenCalledWith(API_URL, 'abc', undefined);
  });
});
