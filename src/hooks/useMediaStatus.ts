// ABOUTME: Hook to check moderation status of media hashes
// ABOUTME: Queries the moderation service to determine if media is blocked

import { useQuery } from "@tanstack/react-query";
import { useAdminApi } from "@/hooks/useAdminApi";
import type { MediaStatus } from "@/lib/adminApi";

export interface MediaStatusResult {
  hash: string;
  status: MediaStatus | null;
  isBlocked: boolean;
  isRestricted: boolean;
}

export function useMediaStatus(hashes: string[]) {
  const { checkMediaStatus } = useAdminApi();

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
            isBlocked: status?.action === 'PERMANENT_BAN',
            isRestricted: status?.action === 'AGE_RESTRICTED',
          };
        })
      );

      return results;
    },
    enabled: hashes.length > 0,
    staleTime: 30000, // Cache for 30 seconds
  });

  // Check if any media is blocked or restricted
  const hasBlockedMedia = data?.some(r => r.isBlocked) ?? false;
  const hasRestrictedMedia = data?.some(r => r.isRestricted) ?? false;
  const hasModeratedMedia = hasBlockedMedia || hasRestrictedMedia;

  // Count by state
  const blockedCount = data?.filter(r => r.isBlocked).length ?? 0;
  const restrictedCount = data?.filter(r => r.isRestricted).length ?? 0;
  const unblockedCount = data?.filter(r => !r.isBlocked && !r.isRestricted).length ?? 0;

  // Get status for a specific hash
  const getStatus = (hash: string): MediaStatusResult | undefined => {
    return data?.find(r => r.hash === hash);
  };

  return {
    results: data || [],
    hasBlockedMedia,
    hasRestrictedMedia,
    hasModeratedMedia,
    blockedCount,
    restrictedCount,
    unblockedCount,
    getStatus,
    isLoading,
    error,
    refetch,
  };
}
