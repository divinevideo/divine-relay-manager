// ABOUTME: Shared query for a pubkey's account status (keycast membership,
// ABOUTME: suspension, verified_minor; registry protected_minor). Consumed by the
// ABOUTME: age-review view and the report view's account-type labels.
import { useQuery } from '@tanstack/react-query';
import { isHex64 } from '@/lib/constants';
import { useAdminApi, useApiUrl } from './useAdminApi';

export function useAccountStatus(pubkey: string | undefined) {
  const api = useAdminApi();
  const apiUrl = useApiUrl();
  return useQuery({
    queryKey: ['account-status', apiUrl, pubkey],
    queryFn: () => {
      // Age review passes a case's pubkey, stored verbatim from a report's p tag,
      // and its Retry calls refetch(), which ignores `enabled`. So the guard sits
      // here too: a bare '..' survives URL escaping and would reach /api/.
      if (!isHex64(pubkey)) throw new Error('Not a valid pubkey');
      return api.getAccountStatus(pubkey);
    },
    enabled: !!apiUrl && isHex64(pubkey),
    staleTime: 60_000, // verified_minor is durable; avoid refetch per case reopen
  });
}
