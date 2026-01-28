// ABOUTME: Hook that provides admin API functions bound to the current environment's apiUrl
// ABOUTME: Enables environment switching without changing component code

import { useMemo } from 'react';
import { useAppContext } from '@/hooks/useAppContext';
import * as adminApi from '@/lib/adminApi';

/**
 * Hook that provides admin API functions pre-bound to the current environment's apiUrl.
 * Components using this hook automatically use the correct worker based on the selected environment.
 *
 * @example
 * ```tsx
 * const { banPubkey, listBannedPubkeys } = useAdminApi();
 *
 * // No need to pass apiUrl - it's automatically included
 * await banPubkey(pubkey, reason);
 * const banned = await listBannedPubkeys();
 * ```
 */
export function useAdminApi() {
  const { config } = useAppContext();
  const { apiUrl, relayUrl } = config;

  // Memoize bound functions to prevent unnecessary re-renders
  const boundApi = useMemo(() => ({
    // Info
    getWorkerInfo: () => adminApi.getWorkerInfo(apiUrl),

    // Event publishing
    publishEvent: (event: adminApi.UnsignedEvent) => adminApi.publishEvent(apiUrl, event),

    // Moderation actions
    moderateAction: (params: Parameters<typeof adminApi.moderateAction>[1]) =>
      adminApi.moderateAction(apiUrl, params),
    deleteEvent: (eventId: string, reason?: string) =>
      adminApi.deleteEvent(apiUrl, eventId, reason),
    banPubkeyViaModerate: (pubkey: string, reason?: string) =>
      adminApi.banPubkeyViaModerate(apiUrl, pubkey, reason),
    allowPubkey: (pubkey: string) =>
      adminApi.allowPubkey(apiUrl, pubkey),

    // NIP-86 RPC
    callRelayRpc: <T = unknown>(method: string, params?: (string | number | undefined)[]) =>
      adminApi.callRelayRpc<T>(apiUrl, method, params),
    banPubkey: (pubkey: string, reason?: string) =>
      adminApi.banPubkey(apiUrl, pubkey, reason),
    unbanPubkey: (pubkey: string) =>
      adminApi.unbanPubkey(apiUrl, pubkey),
    listBannedPubkeys: () =>
      adminApi.listBannedPubkeys(apiUrl),
    listBannedEvents: () =>
      adminApi.listBannedEvents(apiUrl),

    // Labels
    publishLabel: (params: adminApi.LabelParams) =>
      adminApi.publishLabel(apiUrl, params),
    publishLabelAndBan: (params: adminApi.LabelParams & { shouldBan?: boolean }) =>
      adminApi.publishLabelAndBan(apiUrl, params),
    markAsReviewed: (
      targetType: 'event' | 'pubkey',
      targetValue: string,
      status?: adminApi.ResolutionStatus,
      comment?: string
    ) => adminApi.markAsReviewed(apiUrl, targetType, targetValue, status, comment),

    // Media moderation
    moderateMedia: (sha256: string, action: adminApi.ModerationAction, reason?: string) =>
      adminApi.moderateMedia(apiUrl, sha256, action, reason),
    checkMediaStatus: (sha256: string) =>
      adminApi.checkMediaStatus(apiUrl, sha256),
    unblockMedia: (sha256: string, reason?: string) =>
      adminApi.unblockMedia(apiUrl, sha256, reason),

    // Decision log
    logDecision: (params: Parameters<typeof adminApi.logDecision>[1]) =>
      adminApi.logDecision(apiUrl, params),
    getDecisions: (targetId: string) =>
      adminApi.getDecisions(apiUrl, targetId),
    getAllDecisions: () =>
      adminApi.getAllDecisions(apiUrl),
    deleteDecisions: (targetId: string) =>
      adminApi.deleteDecisions(apiUrl, targetId),

    // AI Detection (proxied through worker to handle CF Access)
    getAIDetectionResult: (eventId: string) =>
      adminApi.getAIDetectionResult(apiUrl, eventId),
    submitAIDetection: (videoUrl: string, sha256: string, eventId?: string) =>
      adminApi.submitAIDetection(apiUrl, videoUrl, sha256, eventId),

    // Verification
    verifyPubkeyBanned: (pubkey: string) =>
      adminApi.verifyPubkeyBanned(apiUrl, pubkey),
    verifyPubkeyUnbanned: (pubkey: string) =>
      adminApi.verifyPubkeyUnbanned(apiUrl, pubkey),
    verifyEventDeleted: (eventId: string) =>
      adminApi.verifyEventDeleted(eventId, relayUrl),
    verifyMediaBlocked: (sha256: string) =>
      adminApi.verifyMediaBlocked(apiUrl, sha256),
    verifyModerationAction: (eventId: string, mediaHashes: string[]) =>
      adminApi.verifyModerationAction(apiUrl, eventId, mediaHashes, relayUrl),
  }), [apiUrl, relayUrl]);

  return boundApi;
}

/**
 * Hook that returns the current apiUrl directly.
 * Useful when you need to pass apiUrl to non-hook contexts.
 */
export function useApiUrl(): string {
  const { config } = useAppContext();
  return config.apiUrl;
}
