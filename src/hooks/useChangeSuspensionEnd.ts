// ABOUTME: Changes a suspended account's end date. Owns its toasts (one per refusal
// ABOUTME: code) and the cache refresh, so every screen that offers it says the same thing.
import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';
import { useAdminApi } from '@/hooks/useAdminApi';
import { useAgeReviewGuardRedirect } from '@/hooks/useAgeReviewGuardRedirect';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useToast } from '@/hooks/useToast';
import { TIMED_SUSPENSIONS_KEY } from '@/hooks/useTimedSuspensions';
import { ApiError } from '@/lib/adminApi';
import { invalidateResolutionState } from '@/lib/queueInvalidation';
import { formatSuspensionEnd, type SuspensionDuration } from '../../shared/suspension';

// The worker's refusal codes (POST /api/suspensions/end), in the moderator's words.
// age_review_active is not here: it routes to the case instead.
// A Map, so a code such as "toString" can't pick up an Object prototype member.
const REFUSALS = new Map<string, string>([
  ['account_banned', 'This account is banned. Unban it first.'],
  ['not_suspended', 'This account is no longer suspended.'],
  ['suspension_ending', 'This suspension is ending now. Check again in a few minutes.'],
  ['conflict', 'Someone changed this suspension at the same time. Try again.'],
  ['status_unavailable', "Could not check the account's status. Try again."],
]);

export function useChangeSuspensionEnd(): UseMutationResult<
  { endsAt: string; decisionRecorded: boolean }, Error, { pubkey: string; duration: SuspensionDuration }
> {
  const api = useAdminApi();
  const { getModeratorToken } = useCurrentUser();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const redirectIfGuarded = useAgeReviewGuardRedirect();

  return useMutation({
    // The login is taken at the click, so a sign-out mid-request can't change
    // who the change is recorded as. Account links can use uppercase hex;
    // their timers and the worker's edit route use lowercase hex.
    mutationFn: ({ pubkey, duration }) =>
      api.asModerator(getModeratorToken()).changeSuspensionEnd(pubkey.toLowerCase(), duration),
    onSuccess: ({ endsAt, decisionRecorded }) => {
      const changed = `End date changed to ${formatSuspensionEnd(endsAt)}`;
      // The end is saved either way; a missing decision row is the one thing
      // to warn about, and the app shows one toast at a time.
      toast(decisionRecorded
        ? { title: changed }
        : { title: 'Action applied; audit log not recorded', description: changed });
      // The worker's decision can change which reports count as handled.
      queryClient.invalidateQueries({ queryKey: ['decisions'] });
      invalidateResolutionState(queryClient);
    },
    onError: (error, { pubkey }) => {
      if (redirectIfGuarded(error, pubkey)) return;
      const refusal = error instanceof ApiError && error.code ? REFUSALS.get(error.code) : undefined;
      toast(refusal
        ? { title: refusal, variant: 'destructive' }
        : { title: 'Failed to change end date', description: error.message, variant: 'destructive' });
    },
    // Success or refusal, the timers on screen may be out of date: a refusal
    // such as conflict or not_suspended means someone else moved them. Reset,
    // not invalidate: if the re-read fails, the old end must not stay on
    // screen as if current, so the line says the end is unavailable instead.
    onSettled: () => {
      void queryClient.resetQueries({ queryKey: TIMED_SUSPENSIONS_KEY });
    },
  });
}
