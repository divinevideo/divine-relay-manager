// ABOUTME: Tests the shared age-review guard redirect used by every guarded-RPC call site.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { ApiError } from '@/lib/adminApi';
import { useAgeReviewGuardRedirect } from './useAgeReviewGuardRedirect';

const navigate = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => vi.fn());

vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()),
  useNavigate: () => navigate,
}));
vi.mock('@/hooks/useToast', () => ({ useToast: () => ({ toast }) }));

const PUBKEY = 'a'.repeat(64);

const guarded = () => new ApiError('under age review', 409, 'Conflict', 'age_review_active');

describe('useAgeReviewGuardRedirect', () => {
  beforeEach(() => {
    navigate.mockReset();
    toast.mockReset();
  });

  it('routes to the case and reports handled when the guard refuses', () => {
    const { result } = renderHook(() => useAgeReviewGuardRedirect());
    expect(result.current(guarded(), PUBKEY)).toBe(true);
    expect(navigate).toHaveBeenCalledWith(`/age-review?pubkey=${PUBKEY}`);
  });

  it('encodes the pubkey into the query string', () => {
    const { result } = renderHook(() => useAgeReviewGuardRedirect());
    result.current(guarded(), 'not/a/pubkey');
    expect(navigate).toHaveBeenCalledWith('/age-review?pubkey=not%2Fa%2Fpubkey');
  });

  it('leaves an unrelated ApiError to the caller', () => {
    // A 500 from the same endpoint must still surface as an error toast, not a
    // silent redirect, or a real failure would look like a guard refusal.
    const { result } = renderHook(() => useAgeReviewGuardRedirect());
    expect(result.current(new ApiError('boom', 500, 'Server Error'), PUBKEY)).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('leaves a 409 without the guard code to the caller', () => {
    // Status alone must not trigger the redirect: other conflicts exist.
    const { result } = renderHook(() => useAgeReviewGuardRedirect());
    expect(result.current(new ApiError('conflict', 409, 'Conflict', 'something_else'), PUBKEY)).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('leaves a plain Error to the caller', () => {
    const { result } = renderHook(() => useAgeReviewGuardRedirect());
    expect(result.current(new Error('network down'), PUBKEY)).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });
});
