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
 * Shared rather than copied because extending the guard to `unbanpubkey` makes
 * four new call sites able to receive this code — `UserActions` un-ban,
 * `UserManagement` allow_user and un-ban, and `EventDetail` un-ban — on top of
 * the four that already handled it (`UserActions` suspend, unsuspend and bulk;
 * `UserManagement` unsuspend, which was its own inline copy). Eight
 * near-identical copies is how one gets missed, so the handling lives here.
 *
 * Only covers the 409. The same three RPCs also answer 503
 * `age_review_check_failed` when the check cannot run at all, which is not a
 * routable case — there is no case id to route to — so this returns false and
 * each site shows its own error toast. That message is already actionable.
 *
 * `DebugPanel` deliberately does not use this. It issues arbitrary RPC methods
 * as a raw diagnostic and reports whatever came back, rather than running a
 * moderator workflow with somewhere to be sent. The test is whether a moderator
 * is waiting on the outcome, not whether the RPC is guarded. (It does toast, and
 * currently reports a guard refusal as "Partial success", which is misleading
 * but is a DebugPanel problem rather than one this hook should solve.)
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
