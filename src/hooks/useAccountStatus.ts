// ABOUTME: Shared query for a pubkey's keycast account status (membership,
// ABOUTME: suspension, verified_minor). Consumed by the age-review view; the
// ABOUTME: reports-pane reuse is a planned follow-up (part C).
import { useQuery } from '@tanstack/react-query';
import { useAdminApi, useApiUrl } from './useAdminApi';

export function useAccountStatus(pubkey: string | undefined) {
  const api = useAdminApi();
  const apiUrl = useApiUrl();
  return useQuery({
    queryKey: ['account-status', apiUrl, pubkey],
    queryFn: () => api.getAccountStatus(pubkey!),
    enabled: !!apiUrl && !!pubkey,
    staleTime: 60_000, // verified_minor is durable; avoid refetch per case reopen
  });
}
