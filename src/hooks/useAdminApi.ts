// ABOUTME: Hook that provides admin API functions bound to the current environment's apiUrl
// ABOUTME: Enables environment switching without changing component code

import { useMemo } from 'react';
import { useAppContext } from '@/hooks/useAppContext';
import * as adminApi from '@/lib/adminApi';

/**
 * Hook that provides admin API functions pre-bound to the current environment's apiUrl.
 * Components using this hook automatically use the correct worker based on the selected environment.
 *
 * The plain result has the reads only. Every write (ban, delete, label,
 * decision log, media actions, settings, and the rest) is reachable only
 * through `asModerator(token)`, so tsc rejects a write made without the
 * moderator's login: the worker records the moderator from it, and refuses a
 * write without it once REQUIRE_MODERATOR_LOGIN is on. callRelayRpc stays on
 * the plain result for relay reads (list*, get*); a relay write goes through
 * asModerator.
 *
 * @example
 * ```tsx
 * const api = useAdminApi();
 * const { getModeratorToken } = useCurrentUser();
 *
 * const banned = await api.listBannedPubkeys();
 * // At the click: take the login once and use it for the whole action.
 * await api.asModerator(getModeratorToken()).banPubkey(pubkey, reason);
 * ```
 */
export function useAdminApi(): PlainAdminApi {
  const { config } = useAppContext();
  const { apiUrl, relayUrl } = config;

  // Memoize bound functions to prevent unnecessary re-renders
  return useMemo(() => ({
    ...buildReadApi(apiUrl, relayUrl),
    // Sends no login header. Kept for reads; see the hook doc.
    callRelayRpc: buildAttributionApi(apiUrl).callRelayRpc,
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

type ReadApi = ReturnType<typeof buildReadApi>;
type AttributionApi = ReturnType<typeof buildAttributionApi>;

/** The admin API as `asModerator(token)` returns it: one moderator's action. */
export type ModeratorApi = ReadApi & AttributionApi;

/** What `useAdminApi()` returns: the reads, callRelayRpc, and asModerator. */
export type PlainAdminApi = ReadApi & Pick<AttributionApi, 'callRelayRpc'> & {
  asModerator: (loginToken: string | undefined) => ModeratorApi;
};

/**
 * The full admin API bound to one environment and, optionally, one moderator
 * login. Exported for tests; components get it through `asModerator`.
 */
export function buildAdminApi(apiUrl: string, relayUrl: string, loginToken?: string): ModeratorApi {
  return { ...buildReadApi(apiUrl, relayUrl), ...buildAttributionApi(apiUrl, loginToken) };
}

/**
 * Every call that writes: those that record a moderator, and every other write,
 * since REQUIRE_MODERATOR_LOGIN refuses a write without a login. They pass
 * `{ loginToken }` on here, in one place, so a caller cannot forget it, and
 * `login` is in scope nowhere else,
 * so a new call that needs it has to be added here, which also keeps it off the
 * plain api. useAdminApi.attribution.test.ts holds a row per call; a new one
 * belongs there too.
 */
function buildAttributionApi(apiUrl: string, loginToken?: string) {
  const login: adminApi.LoginOpts = { loginToken };
  return {
    decideSexualQuarantine: (eventId: string, body: Parameters<typeof adminApi.decideSexualQuarantine>[2]) =>
      adminApi.decideSexualQuarantine(apiUrl, eventId, body, login),

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
    suspendPubkey: (pubkey: string, reason?: string) =>
      adminApi.suspendPubkey(apiUrl, pubkey, reason, login),
    unsuspendPubkey: (pubkey: string) =>
      adminApi.unsuspendPubkey(apiUrl, pubkey, login),

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

    // Decision log
    logDecision: (params: Parameters<typeof adminApi.logDecision>[1]) =>
      adminApi.logDecision(apiUrl, params, login),
    confirmAutoHide: (params: Parameters<typeof adminApi.confirmAutoHide>[1]) =>
      adminApi.confirmAutoHide(apiUrl, params, login),

    // Age review
    updateAgeReviewCase: (caseId: string, updates: Record<string, unknown>) =>
      adminApi.updateAgeReviewCase(apiUrl, caseId, updates, login),
    updateAgeReviewConfig: (config: Partial<adminApi.AgeReviewConfig>) =>
      adminApi.updateAgeReviewConfig(apiUrl, config, login),
    createMinorAccount: (username: string, displayName?: string, zendeskTicketId?: number, provisioningOperationId?: string) =>
      adminApi.createMinorAccount(apiUrl, username, displayName, zendeskTicketId, provisioningOperationId, login),

    // Media moderation. /api/moderate-media records no moderator, but it is a
    // write, so it needs the login once REQUIRE_MODERATOR_LOGIN is on.
    moderateMedia: (sha256: string, action: adminApi.ModerationAction, reason?: string, from?: adminApi.ExpectedMediaState, pubkey?: string) =>
      adminApi.moderateMedia(apiUrl, sha256, action, reason, from, pubkey, login),
    deleteMedia: (sha256: string, reason?: string) =>
      adminApi.deleteMedia(apiUrl, sha256, reason, login),
    unblockMedia: (sha256: string, reason?: string) =>
      adminApi.unblockMedia(apiUrl, sha256, reason, login),

    // Decision log cleanup and AI detection: writes, so they carry the login too.
    deleteDecisions: (targetId: string, targetType?: 'event' | 'pubkey') =>
      adminApi.deleteDecisions(apiUrl, targetId, targetType, login),
    submitAIDetection: (videoUrl: string, sha256: string, eventId?: string) =>
      adminApi.submitAIDetection(apiUrl, videoUrl, sha256, eventId, login),

    // Bulk moderation
    bulkModerate: (pubkey: string, action: adminApi.BulkAction, reason?: string, options?: adminApi.BulkModerateOptions) =>
      adminApi.bulkModerate(apiUrl, pubkey, action, reason, options, login),

    // Zendesk tickets linked to a report target
    closeTicket: (ticketId: number) =>
      adminApi.closeTicket(apiUrl, ticketId, login),
  };
}

/** Reads only. Every write lives in buildAttributionApi, so it carries the login. */
function buildReadApi(apiUrl: string, relayUrl: string) {
  return {
    getSexualQuarantineCases: (cursor?: string) => adminApi.getSexualQuarantineCases(apiUrl, cursor),
    getSexualQuarantineCase: (eventId: string) => adminApi.getSexualQuarantineCase(apiUrl, eventId),
    getSexualQuarantineHistory: (eventId: string) => adminApi.getSexualQuarantineHistory(apiUrl, eventId),
    // Info
    getWorkerInfo: () => adminApi.getWorkerInfo(apiUrl),

    // opts threads a per-call timeout through. The reports queue's resolution
    // reads, and every read of the relay lists through useRelayBanLists, pass
    // RESOLUTION_READ_TIMEOUT_MS; other callers omit it and keep the default
    // (#221).
    listBannedPubkeys: (opts?: { timeoutMs?: number }) =>
      adminApi.listBannedPubkeys(apiUrl, opts),
    listBannedEvents: (opts?: { timeoutMs?: number }) =>
      adminApi.listBannedEvents(apiUrl, opts),
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

    // Media moderation
    readMediaStatus: (sha256: string) =>
      adminApi.readMediaStatus(apiUrl, sha256),

    // Decision log
    getDecisions: (targetId: string) =>
      adminApi.getDecisions(apiUrl, targetId),
    getAllDecisions: (opts?: { timeoutMs?: number }) =>
      adminApi.getAllDecisions(apiUrl, opts),

    // Classifier data (scene classification + topic profile)
    getClassifierData: (sha256: string) =>
      adminApi.getClassifierData(apiUrl, sha256),

    // AI Detection (proxied through worker to handle CF Access)
    getAIDetectionResult: (eventId: string) =>
      adminApi.getAIDetectionResult(apiUrl, eventId),

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

    // Bulk moderation
    getBulkJobStatus: (jobId: string) => adminApi.getBulkJobStatus(apiUrl, jobId),
    getBulkJobNotes: (jobId: string, after?: string) => adminApi.getBulkJobNotes(apiUrl, jobId, after),
    getAgeReviewBulkNotesJob: (caseId: string) => adminApi.getAgeReviewBulkNotesJob(apiUrl, caseId),
    getBulkKindCounts: (pubkey: string) => adminApi.getBulkKindCounts(apiUrl, pubkey),

    // Age review config
    getAgeReviewConfig: () =>
      adminApi.getAgeReviewConfig(apiUrl),

    // Zendesk tickets linked to a report target
    getLinkedTickets: (target: { eventId?: string; pubkey?: string }) =>
      adminApi.getLinkedTickets(apiUrl, target),
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
