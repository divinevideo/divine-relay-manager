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
  return useMemo(() => ({
    ...buildAdminApi(apiUrl, relayUrl),
    /**
     * The same API with the moderator's login token bound to every call that
     * records who acted. Take the token once at the click
     * (`api.asModerator(getModeratorToken())`) and use the result for every
     * request in that action, so a sign-out or account switch mid-action
     * cannot change who it is recorded as.
     */
    asModerator: (loginToken: string | undefined) => buildAdminApi(apiUrl, relayUrl, loginToken),
  }), [apiUrl, relayUrl]);
}

/** The admin API as `asModerator(token)` returns it: one moderator's action. */
export type ModeratorApi = ReturnType<typeof buildAdminApi>;

/**
 * The admin API bound to one environment and, optionally, one moderator login.
 * Every call that writes an attribution passes `{ loginToken }` on here, in one
 * place, so a caller cannot forget it. useAdminApi.attribution.test.ts holds a
 * row per such call; a new one belongs there too.
 */
function buildAdminApi(apiUrl: string, relayUrl: string, loginToken?: string) {
  const login: adminApi.LoginOpts = { loginToken };
  return {
    getSexualQuarantineCases: (cursor?: string) => adminApi.getSexualQuarantineCases(apiUrl, cursor),
    getSexualQuarantineCase: (eventId: string) => adminApi.getSexualQuarantineCase(apiUrl, eventId),
    getSexualQuarantineHistory: (eventId: string) => adminApi.getSexualQuarantineHistory(apiUrl, eventId),
    decideSexualQuarantine: (eventId: string, body: Parameters<typeof adminApi.decideSexualQuarantine>[2]) =>
      adminApi.decideSexualQuarantine(apiUrl, eventId, body, login),
    // Info
    getWorkerInfo: () => adminApi.getWorkerInfo(apiUrl),

    // Event publishing
    publishEvent: (event: adminApi.UnsignedEvent) => adminApi.publishEvent(apiUrl, event, login),

    // Moderation actions
    moderateAction: (params: Parameters<typeof adminApi.moderateAction>[1]) =>
      adminApi.moderateAction(apiUrl, params, login),
    deleteEvent: (eventId: string, reason?: string, pubkey?: string) =>
      adminApi.deleteEvent(apiUrl, eventId, reason, pubkey, login),
    hideEvent: (eventId: string, reason?: string) =>
      adminApi.hideEvent(apiUrl, eventId, reason, login),
    restoreEvent: (eventId: string, reason?: string) =>
      adminApi.restoreEvent(apiUrl, eventId, reason, login),
    banPubkey: (pubkey: string, reason?: string) =>
      adminApi.banPubkey(apiUrl, pubkey, reason, login),
    allowPubkey: (pubkey: string) =>
      adminApi.allowPubkey(apiUrl, pubkey, login),

    // NIP-86 RPC. /api/relay-rpc records the verified moderator for account
    // actions, so the raw call carries the login as well.
    callRelayRpc: <T = unknown>(method: string, params?: (string | number | undefined)[]) =>
      adminApi.callRelayRpc<T>(apiUrl, method, params, login),
    banEvent: (eventId: string, reason?: string) =>
      adminApi.banEvent(apiUrl, eventId, reason, login),
    allowEvent: (eventId: string) =>
      adminApi.allowEvent(apiUrl, eventId, login),
    unbanPubkey: (pubkey: string) =>
      adminApi.unbanPubkey(apiUrl, pubkey, login),
    // opts threads a per-call timeout through. The reports queue's resolution
    // reads, and every read of the relay lists through useRelayBanLists, pass
    // RESOLUTION_READ_TIMEOUT_MS; other callers omit it and keep the default
    // (#221).
    listBannedPubkeys: (opts?: { timeoutMs?: number }) =>
      adminApi.listBannedPubkeys(apiUrl, opts),
    listBannedEvents: (opts?: { timeoutMs?: number }) =>
      adminApi.listBannedEvents(apiUrl, opts),
    suspendPubkey: (pubkey: string, reason?: string) =>
      adminApi.suspendPubkey(apiUrl, pubkey, reason, login),
    unsuspendPubkey: (pubkey: string) =>
      adminApi.unsuspendPubkey(apiUrl, pubkey, login),
    listSuspendedPubkeys: (opts?: { timeoutMs?: number }) =>
      adminApi.listSuspendedPubkeys(apiUrl, opts),

    // Server-side relay queries (replaces browser WebSocket for freshness)
    fetchReportsByTarget: (target: { event: string } | { pubkey: string }) =>
      adminApi.fetchReportsByTarget(apiUrl, target),
    fetchReportsNeedingAttention: () =>
      adminApi.fetchReportsNeedingAttention(apiUrl),
    fetchResolvedReportsPage: (params: { cursor?: number; limit?: number }) =>
      adminApi.fetchResolvedReportsPage(apiUrl, params),
    fetchResolutionLabels: (opts?: { timeoutMs?: number }) =>
      adminApi.fetchResolutionLabels(apiUrl, opts),
    fetchResolutionState: (opts?: { timeoutMs?: number }) =>
      adminApi.fetchResolutionState(apiUrl, opts),
    fetchResolutionLabelTargets: (opts?: { timeoutMs?: number }) =>
      adminApi.fetchResolutionLabelTargets(apiUrl, opts),

    // Labels
    publishLabel: (params: adminApi.LabelParams) =>
      adminApi.publishLabel(apiUrl, params, login),
    publishLabelAndBan: (params: adminApi.LabelParams & { shouldBan?: boolean }) =>
      adminApi.publishLabelAndBan(apiUrl, params, login),
    markAsReviewed: (
      targetType: 'event' | 'pubkey',
      targetValue: string,
      status?: adminApi.ResolutionStatus,
      comment?: string,
    ) => adminApi.markAsReviewed(apiUrl, targetType, targetValue, status, comment, login),

    // Media moderation
    moderateMedia: (sha256: string, action: adminApi.ModerationAction, reason?: string, from?: adminApi.ExpectedMediaState, pubkey?: string) =>
      adminApi.moderateMedia(apiUrl, sha256, action, reason, from, pubkey),
    readMediaStatus: (sha256: string) =>
      adminApi.readMediaStatus(apiUrl, sha256),
    unblockMedia: (sha256: string, reason?: string) =>
      adminApi.unblockMedia(apiUrl, sha256, reason),

    // Decision log
    logDecision: (params: Parameters<typeof adminApi.logDecision>[1]) =>
      adminApi.logDecision(apiUrl, params, login),
    confirmAutoHide: (params: Parameters<typeof adminApi.confirmAutoHide>[1]) =>
      adminApi.confirmAutoHide(apiUrl, params, login),
    getDecisions: (targetId: string) =>
      adminApi.getDecisions(apiUrl, targetId),
    getAllDecisions: (opts?: { timeoutMs?: number }) =>
      adminApi.getAllDecisions(apiUrl, opts),
    deleteDecisions: (targetId: string, targetType?: 'event' | 'pubkey') =>
      adminApi.deleteDecisions(apiUrl, targetId, targetType),

    // Classifier data (scene classification + topic profile)
    getClassifierData: (sha256: string) =>
      adminApi.getClassifierData(apiUrl, sha256),

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
    verifyAgeRestricted: (sha256: string) =>
      adminApi.verifyAgeRestricted(apiUrl, sha256),
    verifyModerationAction: (eventId: string, mediaHashes: string[]) =>
      adminApi.verifyModerationAction(apiUrl, eventId, mediaHashes, relayUrl),

    // Age review
    getAgeReviewCases: (params?: { state?: string; age_band?: string }) =>
      adminApi.getAgeReviewCases(apiUrl, params),
    getAgeReviewFunnel: (ageBand?: string) =>
      adminApi.getAgeReviewFunnel(apiUrl, ageBand),
    getAgeReviewCaseCounts: (params?: { age_band?: string }) =>
      adminApi.getAgeReviewCaseCounts(apiUrl, params),
    getAgeReviewCase: (caseId: string) =>
      adminApi.getAgeReviewCase(apiUrl, caseId),
    getActiveAgeReviewCase: (pubkey: string) =>
      adminApi.getActiveAgeReviewCase(apiUrl, pubkey),
    getAccountStatus: (pubkey: string) =>
      adminApi.getAccountStatus(apiUrl, pubkey),
    updateAgeReviewCase: (caseId: string, updates: Record<string, unknown>) =>
      adminApi.updateAgeReviewCase(apiUrl, caseId, updates, login),

    // Bulk moderation
    bulkModerate: (pubkey: string, action: adminApi.BulkAction, reason?: string, options?: adminApi.BulkModerateOptions) =>
      adminApi.bulkModerate(apiUrl, pubkey, action, reason, options, login),
    getBulkJobStatus: (jobId: string) => adminApi.getBulkJobStatus(apiUrl, jobId),
    getBulkJobNotes: (jobId: string, after?: string) => adminApi.getBulkJobNotes(apiUrl, jobId, after),
    getAgeReviewBulkNotesJob: (caseId: string) => adminApi.getAgeReviewBulkNotesJob(apiUrl, caseId),
    getBulkKindCounts: (pubkey: string) => adminApi.getBulkKindCounts(apiUrl, pubkey),

    // Delete operations
    deleteMedia: (sha256: string, reason?: string) =>
      adminApi.deleteMedia(apiUrl, sha256, reason),

    // Age review config
    getAgeReviewConfig: () =>
      adminApi.getAgeReviewConfig(apiUrl),
    updateAgeReviewConfig: (config: Partial<adminApi.AgeReviewConfig>) =>
      adminApi.updateAgeReviewConfig(apiUrl, config),
    createMinorAccount: (username: string, displayName?: string, zendeskTicketId?: number, provisioningOperationId?: string) =>
      adminApi.createMinorAccount(apiUrl, username, displayName, zendeskTicketId, provisioningOperationId),

    // Zendesk tickets linked to a report target
    getLinkedTickets: (target: { eventId?: string; pubkey?: string }) =>
      adminApi.getLinkedTickets(apiUrl, target),
    closeTicket: (ticketId: number) =>
      adminApi.closeTicket(apiUrl, ticketId, login),
  };
}

/**
 * Hook that returns the current apiUrl directly.
 * Useful when you need to pass apiUrl to non-hook contexts.
 */
export function useApiUrl(): string {
  const { config } = useAppContext();
  return config.apiUrl;
}
