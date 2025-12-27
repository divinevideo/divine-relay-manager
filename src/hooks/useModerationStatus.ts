// ABOUTME: Checks if a pubkey is banned or an event is deleted from the relay
// ABOUTME: Uses NIP-86 RPC to query relay moderation status

import { useQuery } from "@tanstack/react-query";
import { listBannedPubkeys, listBannedEvents } from "@/lib/adminApi";

export function useModerationStatus(
  pubkey?: string | null,
  eventId?: string | null
) {
  // Query banned pubkeys
  const bannedPubkeys = useQuery({
    queryKey: ['banned-pubkeys'],
    queryFn: async () => {
      try {
        return await listBannedPubkeys();
      } catch (error) {
        // Log the error so we can see if NIP-86 RPC is failing
        console.warn('NIP-86 listbannedpubkeys failed (relay may not support it):', error);
        return [];
      }
    },
    staleTime: 30 * 1000, // 30 seconds
  });

  // Query banned events
  const bannedEvents = useQuery({
    queryKey: ['banned-events'],
    queryFn: async () => {
      try {
        return await listBannedEvents();
      } catch (error) {
        // Log the error so we can see if NIP-86 RPC is failing
        console.warn('NIP-86 listbannedevents failed (relay may not support it):', error);
        return [];
      }
    },
    staleTime: 30 * 1000, // 30 seconds
  });

  const isBanned = pubkey ? (bannedPubkeys.data?.some(entry => 
    typeof entry === 'string' ? entry === pubkey : entry.pubkey === pubkey
  ) ?? false) : false;
  const bannedEvent = eventId
    ? bannedEvents.data?.find(e => e.id === eventId)
    : undefined;
  const isDeleted = !!bannedEvent;

  return {
    isBanned,
    isDeleted,
    deleteReason: bannedEvent?.reason,
    isLoading: bannedPubkeys.isLoading || bannedEvents.isLoading,
    refetch: () => {
      bannedPubkeys.refetch();
      bannedEvents.refetch();
    },
  };
}
