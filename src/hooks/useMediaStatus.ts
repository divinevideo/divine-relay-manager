// ABOUTME: Hook to check moderation status of media hashes
// ABOUTME: Queries the moderation service to determine if media is blocked or age-restricted

import { useQuery } from "@tanstack/react-query";
import { useAdminApi } from "@/hooks/useAdminApi";
import { isBlockedMediaAction, type MediaStatus } from "@/lib/adminApi";

export interface MediaStatusResult {
  hash: string;
  status: MediaStatus | null;
  /** The stored action, or null when there is none or it could not be read. */
  action: MediaStatus['action'] | null;
  isBlocked: boolean;
  isRestricted: boolean;
  /** The moderation service did not answer for this file, so its state is unknown. */
  unreadable: boolean;
}

export function useMediaStatus(hashes: string[]) {
  const { readMediaStatus } = useAdminApi();

  const { data, isLoading, isPending, isFetching, error, refetch } = useQuery({
    queryKey: ['media-status', ...hashes],
    queryFn: async () => {
      if (hashes.length === 0) return [];

      const results = await Promise.all(
        hashes.map(async (hash): Promise<MediaStatusResult> => {
          // A file whose status could not be read is unknown, not open: read as
          // open, a blocked file would be offered Age Restrict, which weakens it.
          let status: MediaStatus | null;
          try {
            status = await readMediaStatus(hash);
          } catch (error) {
            console.error('Failed to check media status:', error);
            return { hash, status: null, action: null, isBlocked: false, isRestricted: false, unreadable: true };
          }
          return {
            hash,
            status,
            action: status?.action ?? null,
            isBlocked: isBlockedMediaAction(status?.action),
            isRestricted: status?.action === 'AGE_RESTRICTED',
            unreadable: false,
          };
        })
      );

      return results;
    },
    enabled: hashes.length > 0,
    staleTime: 30000, // Cache for 30 seconds
  });

  // No whole-list totals: the list now holds thumbnails as well as videos, and a
  // file whose status could not be read is neither blocked nor open. Callers
  // decide from each file's own result.

  // Get status for a specific hash
  const getStatus = (hash: string): MediaStatusResult | undefined => {
    return data?.find(r => r.hash === hash);
  };

  return {
    results: data || [],
    getStatus,
    isLoading,
    isPending,
    isFetching,
    error,
    refetch,
  };
}
