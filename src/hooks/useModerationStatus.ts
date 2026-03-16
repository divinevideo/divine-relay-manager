// ABOUTME: Unified moderation status hook - checks ban lists + WebSocket event verification
// ABOUTME: Auto-runs on report load, exposes refetch for manual re-check after actions

import { useState, useEffect, useCallback, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAdminApi } from "@/hooks/useAdminApi";

interface ModerationStatus {
  /** User's pubkey is in the relay's ban list */
  isUserBanned: boolean | null;
  /** Event ID is in the relay's ban list */
  isEventBanned: boolean | null;
  /** Event is not queryable from the relay (deleted, banned, or never existed) */
  isEventGone: boolean | null;
  /** Ban list data is still loading */
  isLoading: boolean;
  /** WebSocket verification is in progress */
  isChecking: boolean;
  /** When the last check completed */
  checkedAt: Date | null;
  /** Re-run all checks (ban lists + WebSocket verification) */
  recheck: () => void;
}

export function useModerationStatus(
  pubkey?: string | null,
  eventId?: string | null,
  /** Set true when the event could not be found via normal relay queries or banned event lookup */
  eventNotFound?: boolean,
): ModerationStatus {
  const { listBannedPubkeys, listBannedEvents, verifyEventDeleted, verifyPubkeyBanned } = useAdminApi();
  const [wsResult, setWsResult] = useState<{
    userBanned: boolean | null;
    eventGone: boolean | null;
    checkedAt: Date | null;
    isChecking: boolean;
  }>({ userBanned: null, eventGone: null, checkedAt: null, isChecking: false });

  // Track which report we've auto-checked to avoid re-running on every render
  const autoCheckedRef = useRef<string | null>(null);

  // Ban list queries (shared across all reports via query key)
  const bannedPubkeys = useQuery({
    queryKey: ['banned-pubkeys'],
    queryFn: async () => {
      try {
        return await listBannedPubkeys();
      } catch (error) {
        console.warn('NIP-86 listbannedpubkeys failed:', error);
        return [];
      }
    },
    staleTime: 30 * 1000,
  });

  const bannedEvents = useQuery({
    queryKey: ['banned-events'],
    queryFn: async () => {
      try {
        return await listBannedEvents();
      } catch (error) {
        console.warn('NIP-86 listbannedevents failed:', error);
        return [];
      }
    },
    staleTime: 30 * 1000,
  });

  // Derive ban list status
  const isUserBannedFromList = pubkey
    ? bannedPubkeys.data?.some(entry => entry.pubkey === pubkey) ?? null
    : null;
  const isEventBannedFromList = eventId
    ? bannedEvents.data?.some(e => e.id === eventId) ?? null
    : null;
  const banListsLoading = bannedPubkeys.isLoading || bannedEvents.isLoading;

  // WebSocket + fresh ban list verification
  const runCheck = useCallback(async () => {
    setWsResult(prev => ({ ...prev, isChecking: true }));
    try {
      const results: { userBanned: boolean | null; eventGone: boolean | null } = {
        userBanned: null,
        eventGone: null,
      };

      if (pubkey) {
        results.userBanned = await verifyPubkeyBanned(pubkey);
      }

      if (eventId) {
        results.eventGone = await verifyEventDeleted(eventId);
      }

      setWsResult({
        userBanned: results.userBanned,
        eventGone: results.eventGone,
        checkedAt: new Date(),
        isChecking: false,
      });

      // Also refresh ban lists so badges stay in sync
      bannedPubkeys.refetch();
      bannedEvents.refetch();
    } catch (error) {
      console.error('Moderation status check failed:', error);
      setWsResult(prev => ({ ...prev, isChecking: false }));
    }
  }, [pubkey, eventId, verifyPubkeyBanned, verifyEventDeleted, bannedPubkeys, bannedEvents]);

  // Auto-check: for events when not found, for users always (just a ban list refresh)
  useEffect(() => {
    const checkKey = `${eventId || ''}:${pubkey || ''}`;
    if (autoCheckedRef.current === checkKey || banListsLoading || wsResult.isChecking) return;

    const shouldAutoCheck =
      // Event not found via normal queries: run WebSocket verification
      (eventNotFound && eventId) ||
      // User report (no event): check ban status
      (pubkey && !eventId);

    if (shouldAutoCheck) {
      autoCheckedRef.current = checkKey;
      runCheck();
    }
  }, [eventNotFound, eventId, pubkey, banListsLoading, wsResult.isChecking, runCheck]);

  // Reset when report changes
  useEffect(() => {
    setWsResult({ userBanned: null, eventGone: null, checkedAt: null, isChecking: false });
    autoCheckedRef.current = null;
  }, [eventId, pubkey]);

  return {
    // User ban: WebSocket check result takes precedence over ban list
    isUserBanned: wsResult.userBanned ?? isUserBannedFromList,
    // Event in ban list (separate from "gone" — banned events can be retrieved via admin API)
    isEventBanned: isEventBannedFromList,
    // Event gone from relay (WebSocket verified, or known from ban list)
    isEventGone: wsResult.eventGone ?? (isEventBannedFromList === true ? true : null),
    isLoading: banListsLoading,
    isChecking: wsResult.isChecking,
    checkedAt: wsResult.checkedAt,
    recheck: runCheck,
  };
}
