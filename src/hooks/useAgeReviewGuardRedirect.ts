// ABOUTME: Routes a moderator to the Age Review case when the worker's age-review
// guard refuses an enforcement action, instead of surfacing a raw error.

import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError } from '@/lib/adminApi';
import { useToast } from '@/hooks/useToast';

/**
 * The worker refuses `suspendpubkey`, `unsuspendpubkey` and `unbanpubkey` on a
 * pubkey with an open age-review case, answering with a 409 carrying
 * `code: 'age_review_active'`. Enforcement must not drift from the case out of
 * band, so a refused action sends the moderator to the case rather than showing
 * a dead-end error toast.
 *
 * `banpubkey` is deliberately not guarded and so never produces this code: it is
 * the severe-action escape hatch.
 *
 * Returns a predicate. Call it first in a mutation's `onError`; if it returns
 * true it has already handled the error and the caller should return.
 *
 * This is shared rather than copied because it is needed at every call site of a
 * guarded RPC, and a copied block is easy to omit on a new one. It was, on the
 * `allow_user` path, which reached `unbanpubkey` and dead-ended.
 */
export function useAgeReviewGuardRedirect() {
  const navigate = useNavigate();
  const { toast } = useToast();

  return useCallback(
    (error: unknown, pubkey: string): boolean => {
      if (!(error instanceof ApiError) || error.code !== 'age_review_active') return false;
      toast({
        title: 'This account is under age review',
        description: 'Opening it in the Age Review flow.',
      });
      navigate(`/age-review?pubkey=${encodeURIComponent(pubkey)}`);
      return true;
    },
    [navigate, toast],
  );
}
