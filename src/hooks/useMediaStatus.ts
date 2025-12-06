// ABOUTME: Hook to check moderation status of media hashes
// ABOUTME: Queries the moderation service to determine if media is blocked

import { useQuery } from "@tanstack/react-query";
import { checkMediaStatus, type MediaStatus } from "@/lib/adminApi";

export interface MediaStatusResult {
  hash: string;
  status: MediaStatus | null;
  isBlocked: boolean;
}

export function useMediaStatus(hashes: string[]) {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['media-status', ...hashes],
    queryFn: async () => {
      if (hashes.length === 0) return [];

      const results = await Promise.all(
        hashes.map(async (hash) => {
          const status = await checkMediaStatus(hash);
          return {
            hash,
            status,
            isBlocked: status?.action === 'PERMANENT_BAN' || status?.action === 'AGE_RESTRICTED',
          };
        })
      );

      return results;
    },
    enabled: hashes.length > 0,
    staleTime: 30000, // Cache for 30 seconds
  });

  // Check if any media is blocked
  const hasBlockedMedia = data?.some(r => r.isBlocked) ?? false;

  // Count blocked and unblocked
  const blockedCount = data?.filter(r => r.isBlocked).length ?? 0;
  const unblockedCount = data?.filter(r => !r.isBlocked).length ?? 0;

  // Get status for a specific hash
  const getStatus = (hash: string): MediaStatusResult | undefined => {
    return data?.find(r => r.hash === hash);
  };

  return {
    results: data || [],
    hasBlockedMedia,
    blockedCount,
    unblockedCount,
    getStatus,
    isLoading,
    error,
    refetch,
  };
}
