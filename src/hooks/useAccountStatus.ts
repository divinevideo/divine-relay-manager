// ABOUTME: Shared query for a pubkey's account status (keycast membership,
// ABOUTME: suspension, verified_minor; registry protected_minor). Consumed by the
// ABOUTME: age-review view and the report view's account-type labels.
import { useQuery } from '@tanstack/react-query';
import { accountStatusKey } from '@/lib/accountStatusCache';
import { isHex64 } from '@/lib/constants';
import { useAdminApi, useApiUrl } from './useAdminApi';

export function useAccountStatus(pubkey: string | undefined) {
  const api = useAdminApi();
  const apiUrl = useApiUrl();
  const queryKey = accountStatusKey(apiUrl, pubkey);
  const subject = queryKey[2];
  const valid = isHex64(subject);
  return useQuery({
    queryKey,
    queryFn: () => {
      // Age review passes a case's pubkey, stored verbatim from a report's p tag,
      // and its Retry calls refetch(), which ignores `enabled`. So the guard sits
      // here too: a bare '..' survives URL escaping and would reach /api/.
      if (!isHex64(subject)) throw new Error('Not a valid pubkey');
      return api.getAccountStatus(subject);
    },
    enabled: !!apiUrl && valid,
    // That throw can never succeed, so a Retry on a malformed pubkey goes straight
    // to the error instead of retrying it. Valid lookups keep the app's default.
    ...(valid ? {} : { retry: false }),
    staleTime: 60_000, // verified_minor is durable; avoid refetch per case reopen
  });
}
