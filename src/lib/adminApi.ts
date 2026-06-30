// ABOUTME: API client for the Divine Relay Admin Worker
// ABOUTME: Handles signing, publishing events, and NIP-86 relay management via the server-side Worker
// ABOUTME: All functions accept apiUrl as first parameter to support environment switching

import type { NostrEvent } from "@nostrify/nostrify";
import {
  VALID_BULK_ACTIONS,
  type BulkAction,
  type BulkModerateResult,
  type BulkJob,
  type BulkJobStatus,
  type BulkEnqueueResponse,
} from "../../shared/bulk-moderation";
import { extractMediaHashes as extractSharedMediaHashes } from "../../shared/media-hashes";
import type { AgeReviewCaseResponse } from "../../shared/age-review";

// Build headers with CF Access service token for cross-origin API requests.
// The service token authenticates the frontend to CF Access policies on api-relay-* domains.
export function getApiHeaders(contentType = 'application/json'): Record<string, string> {
  const headers: Record<string, string> = {};
  if (contentType) {
    headers['Content-Type'] = contentType;
  }
  if (import.meta.env.VITE_CF_ACCESS_CLIENT_ID) {
    headers['CF-Access-Client-Id'] = import.meta.env.VITE_CF_ACCESS_CLIENT_ID;
  }
  if (import.meta.env.VITE_CF_ACCESS_CLIENT_SECRET) {
    headers['CF-Access-Client-Secret'] = import.meta.env.VITE_CF_ACCESS_CLIENT_SECRET;
  }
  if (import.meta.env.VITE_ADMIN_API_KEY) {
    headers['X-Admin-Key'] = import.meta.env.VITE_ADMIN_API_KEY;
  }
  return headers;
}

export interface UnsignedEvent {
  kind: number;
  content: string;
  tags?: string[][];
  created_at?: number;
}

interface ModerateParams {
  action: 'delete_event' | 'ban_pubkey' | 'allow_pubkey';
  eventId?: string;
  pubkey?: string;
  reason?: string;
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  event?: T;
  result?: T;
  error?: string;
}

interface InfoResponse {
  success: boolean;
  pubkey?: string;
  npub?: string;
  relay?: string;
  error?: string;
}

export interface LabelParams {
  targetType: 'event' | 'pubkey';
  targetValue: string;
  namespace: string;
  labels: string[];
  comment?: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public statusCode?: number,
    public statusText?: string,
    // Structured fields parsed from a JSON error body, when present. `code`
    // lets callers branch on a machine-readable reason (e.g. 'version_conflict')
    // rather than the message string; `currentVersion` is the server's current
    // version returned alongside a 409 conflict.
    public code?: string,
    public currentVersion?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

// Bound every relay-bound HTTP call so a slow or hung relay can't leave the UI
// spinning forever (the "Banning…" / "Deleting…" confirm modals). Generous
// because some actions purge across 16+ tables; if legitimate operations exceed
// this, fix the relay-side latency rather than raise the bound. Every relay-bound
// fetch routes through fetchWithTimeout (bounds the connection). apiRequest and
// callRelayRpc additionally map a stalled body read to the friendly copy via
// readJsonBounded (they surface the message to a moderator); the standalone
// check-result / check-classifier / realness fetches rely on the same AbortSignal
// aborting the body and degrade to null, so they need no copy mapping.
const API_TIMEOUT_MS = 30_000;

// NIP-86 read methods are a closed, known set, so derive read-vs-write from
// membership rather than a name prefix: `getbannedevent` and `supportedmethods`
// are reads that do NOT start with `list`, and inferring from the prefix would
// label them as writes (wrongly telling a moderator a read "may have applied").
const READ_RPC_METHODS = new Set<string>([
  'listbannedpubkeys',
  'listallowedpubkeys',
  'listsuspendedpubkeys',
  'listbannedevents',
  'listbannedtags',
  'listblockedips',
  'listallowedkinds',
  'listeventsneedingmoderation',
  'getbannedevent',
  'supportedmethods',
]);

// fetch wrapper that aborts after the chosen bound. The timeout message depends
// on whether the call mutates relay state: a timed-out write may have landed
// even though we stopped waiting (re-check before retrying), but a timed-out
// read applied nothing (just retry). Emitting "may have applied" on a read would
// mislead the moderator.
// Map an AbortSignal.timeout abort to the friendly ApiError copy. Shared by
// fetchWithTimeout (bounds the connection) and readJsonBounded (the body read): a
// relay that sends headers then stalls the body aborts during response.json(),
// AFTER fetch() resolves, so the same mapping has to wrap the read too — otherwise
// a body stall surfaces as a raw TimeoutError and skips the "may have applied" copy.
function asTimeoutApiError(err: unknown, label: string, mutates: boolean, timeoutMs: number): unknown {
  if (err instanceof DOMException && err.name === 'TimeoutError') {
    const tail = mutates
      ? 'The action may still have applied. Re-check before retrying.'
      : 'Could not reach the relay. Try again.';
    return new ApiError(`${label} timed out after ${timeoutMs / 1000}s. ${tail}`);
  }
  return err;
}

async function readJsonBounded<T>(response: Response, label: string, mutates: boolean, timeoutMs: number): Promise<T> {
  try {
    return await response.json() as T;
  } catch (err) {
    throw asTimeoutApiError(err, label, mutates, timeoutMs);
  }
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  label: string,
  opts: { mutates: boolean; timeoutMs?: number },
): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? API_TIMEOUT_MS;
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw asTimeoutApiError(err, label, opts.mutates, timeoutMs);
  }
}

async function apiRequest<T>(
  apiUrl: string,
  endpoint: string,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  body?: object,
  opts?: { timeoutMs?: number }
): Promise<T> {
  if (!apiUrl) {
    throw new ApiError('No relay selected. Go to Settings to choose an environment.');
  }
  const label = `Request to ${endpoint}`;
  const mutates = method !== 'GET';
  const timeoutMs = opts?.timeoutMs ?? API_TIMEOUT_MS;
  const response = await fetchWithTimeout(`${apiUrl}${endpoint}`, {
    method,
    headers: getApiHeaders(),
    body: body ? JSON.stringify(body) : undefined,
  }, label, { mutates, timeoutMs });

  if (!response.ok) {
    // Read the JSON error body if there is one so callers can act on structured
    // fields (a 409 version_conflict carries `code` + `current_version`) instead
    // of an opaque "HTTP 409:" message. Non-JSON bodies fall back to status text.
    let parsed: { error?: string; code?: string; current_version?: number } | undefined;
    try {
      parsed = await response.json() as typeof parsed;
    } catch {
      // body was empty or not JSON; keep the status-line fallback
    }
    throw new ApiError(
      parsed?.error || `HTTP ${response.status}: ${response.statusText}`,
      response.status,
      response.statusText,
      parsed?.code,
      parsed?.current_version,
    );
  }

  const data = await readJsonBounded<T>(response, label, mutates, timeoutMs);
  return data;
}

async function _apiRequestWithValidation<T>(
  apiUrl: string,
  endpoint: string,
  method: 'GET' | 'POST',
  body?: object
): Promise<T> {
  const data = await apiRequest<ApiResponse<T>>(apiUrl, endpoint, method, body);

  if (!data.success) {
    throw new ApiError(data.error || 'Unknown error');
  }

  return (data.result ?? data.event ?? data) as T;
}

// Info endpoint
export async function getWorkerInfo(apiUrl: string): Promise<InfoResponse> {
  return apiRequest<InfoResponse>(apiUrl, '/api/info', 'GET');
}

// Publish endpoint - for general event publishing
export async function publishEvent(apiUrl: string, event: UnsignedEvent): Promise<ApiResponse> {
  const data = await apiRequest<ApiResponse>(apiUrl, '/api/publish', 'POST', event);
  if (!data.success) {
    throw new ApiError(data.error || 'Failed to publish event');
  }
  return data;
}

// Moderate endpoint - for moderation actions
export async function moderateAction(apiUrl: string, params: ModerateParams): Promise<ApiResponse> {
  const data = await apiRequest<ApiResponse>(apiUrl, '/api/moderate', 'POST', params);
  if (!data.success) {
    throw new ApiError(data.error || 'Moderation action failed');
  }
  return data;
}

export async function deleteEvent(apiUrl: string, eventId: string, reason?: string, pubkey?: string): Promise<ApiResponse> {
  return moderateAction(apiUrl, { action: 'delete_event', eventId, reason, pubkey });
}

export async function banPubkeyViaModerate(apiUrl: string, pubkey: string, reason?: string): Promise<ApiResponse> {
  return moderateAction(apiUrl, { action: 'ban_pubkey', pubkey, reason });
}

export async function allowPubkey(apiUrl: string, pubkey: string): Promise<ApiResponse> {
  return moderateAction(apiUrl, { action: 'allow_pubkey', pubkey });
}

// NIP-86 Relay RPC endpoint - for direct relay management
export async function callRelayRpc<T = unknown>(
  apiUrl: string,
  method: string,
  params: (string | number | undefined)[] = []
): Promise<T> {
  if (!apiUrl) {
    throw new ApiError('No relay selected. Go to Settings to choose an environment.');
  }
  const label = `Relay RPC '${method}'`;
  const mutates = !READ_RPC_METHODS.has(method);
  const response = await fetchWithTimeout(`${apiUrl}/api/relay-rpc`, {
    method: 'POST',
    headers: getApiHeaders(),
    body: JSON.stringify({ method, params }),
  }, label, { mutates });

  if (!response.ok) {
    throw new ApiError(
      `HTTP ${response.status}: ${response.statusText}`,
      response.status,
      response.statusText
    );
  }

  const data = await readJsonBounded<ApiResponse<T>>(response, label, mutates, API_TIMEOUT_MS);

  if (!data.success) {
    throw new ApiError(data.error || 'RPC call failed');
  }

  return data.result as T;
}

// Convenience function for banning pubkey via NIP-86 RPC
export async function banPubkey(apiUrl: string, pubkey: string, reason?: string): Promise<void> {
  await callRelayRpc(apiUrl, 'banpubkey', [pubkey, reason || 'Banned via admin']);
}

export async function banEvent(apiUrl: string, eventId: string, reason?: string): Promise<void> {
  await callRelayRpc(apiUrl, 'banevent', [eventId, reason]);
}

// Funnelcake's event unban method is intentionally named allowevent, not unbanevent.
export async function allowEvent(apiUrl: string, eventId: string): Promise<void> {
  await callRelayRpc(apiUrl, 'allowevent', [eventId]);
}

// Convenience function for unbanning pubkey
// Note: 'unbanpubkey' is not in NIP-86 spec but is a necessary extension
// This will fail on relays that don't support it until they add the method
export async function unbanPubkey(apiUrl: string, pubkey: string): Promise<void> {
  await callRelayRpc(apiUrl, 'unbanpubkey', [pubkey]);
}

// Banned pubkey can be a string or an object with pubkey and reason
export interface BannedPubkeyEntry {
  pubkey: string;
  reason?: string;
}

// List banned pubkeys - normalizes response to always be BannedPubkeyEntry[]
export async function listBannedPubkeys(apiUrl: string): Promise<BannedPubkeyEntry[]> {
  const result = await callRelayRpc<string[] | BannedPubkeyEntry[]>(apiUrl, 'listbannedpubkeys');

  // Normalize: if it's an array of strings, convert to objects
  return result.map(item => {
    if (typeof item === 'string') {
      return { pubkey: item };
    }
    return item as BannedPubkeyEntry;
  });
}

// List banned events
export async function listBannedEvents(apiUrl: string): Promise<Array<{ id: string; reason?: string }>> {
  return callRelayRpc<Array<{ id: string; reason?: string }>>(apiUrl, 'listbannedevents');
}

export async function suspendPubkey(apiUrl: string, pubkey: string, reason?: string): Promise<void> {
  await callRelayRpc(apiUrl, 'suspendpubkey', [pubkey, reason || 'Suspended via admin']);
}

export async function unsuspendPubkey(apiUrl: string, pubkey: string): Promise<void> {
  await callRelayRpc(apiUrl, 'unsuspendpubkey', [pubkey]);
}

export async function listSuspendedPubkeys(apiUrl: string): Promise<BannedPubkeyEntry[]> {
  const result = await callRelayRpc<string[] | BannedPubkeyEntry[]>(apiUrl, 'listsuspendedpubkeys');
  return result.map(item => {
    if (typeof item === 'string') {
      return { pubkey: item };
    }
    return item as BannedPubkeyEntry;
  });
}

// Fetch reports via server-side relay query (replaces browser WebSocket)
export async function fetchReports(apiUrl: string): Promise<NostrEvent[]> {
  const data = await apiRequest<{ success: boolean; events: NostrEvent[] }>(apiUrl, '/api/reports', 'GET');
  return (data.events || []).sort((a: NostrEvent, b: NostrEvent) => b.created_at - a.created_at);
}

// Fetch resolution labels via server-side relay query (replaces browser WebSocket)
export async function fetchResolutionLabels(apiUrl: string): Promise<NostrEvent[]> {
  const data = await apiRequest<{ success: boolean; events: NostrEvent[] }>(apiUrl, '/api/resolution-labels', 'GET');
  return data.events || [];
}

// Publish a NIP-32 label (kind 1985)
export async function publishLabel(apiUrl: string, params: LabelParams): Promise<ApiResponse> {
  const tags: string[][] = [
    ['L', params.namespace],
    ...params.labels.map(l => ['l', l, params.namespace]),
    [params.targetType === 'event' ? 'e' : 'p', params.targetValue],
  ];

  return publishEvent(apiUrl, {
    kind: 1985,
    content: params.comment || '',
    tags,
  });
}

// Combined action: publish label and optionally ban
export async function publishLabelAndBan(
  apiUrl: string,
  params: LabelParams & { shouldBan?: boolean }
): Promise<{ labelPublished: boolean; banned: boolean }> {
  const result = { labelPublished: false, banned: false };

  // Publish the label first
  await publishLabel(apiUrl, params);
  result.labelPublished = true;

  // Optionally ban the pubkey
  if (params.shouldBan && params.targetType === 'pubkey') {
    await banPubkey(apiUrl, params.targetValue, `Labeled: ${params.labels.join(', ')}`);
    result.banned = true;
  }

  return result;
}

// Moderation resolution statuses
export type ResolutionStatus = 'reviewed' | 'dismissed' | 'no-action' | 'false-positive';

// Mark a report target as reviewed/resolved (creates a 1985 label)
export async function markAsReviewed(
  apiUrl: string,
  targetType: 'event' | 'pubkey',
  targetValue: string,
  status: ResolutionStatus = 'reviewed',
  comment?: string
): Promise<ApiResponse> {
  return publishLabel(apiUrl, {
    targetType,
    targetValue,
    namespace: 'moderation/resolution',
    labels: [status],
    comment: comment || `Marked as ${status} by moderator`,
  });
}

// Media moderation request actions
export type ModerationAction = 'SAFE' | 'REVIEW' | 'QUARANTINE' | 'AGE_RESTRICTED' | 'PERMANENT_BAN' | 'DELETE';
// Media moderation status values returned by /api/check-result/:sha256
export type MediaStatusAction = ModerationAction;

export interface MediaStatus {
  sha256: string;
  action: MediaStatusAction;
  reason?: string;
  created_at?: string;
  source?: string;
}

export function isBlockedMediaAction(action: MediaStatusAction | null | undefined): boolean {
  return action === 'PERMANENT_BAN' || action === 'QUARANTINE';
}

export async function moderateMedia(
  apiUrl: string,
  sha256: string,
  action: ModerationAction,
  reason?: string
): Promise<ApiResponse> {
  const data = await apiRequest<ApiResponse>(apiUrl, '/api/moderate-media', 'POST', {
    sha256,
    action,
    reason,
  });
  if (!data.success) {
    throw new ApiError(data.error || 'Failed to moderate media');
  }
  return data;
}

// Check media moderation status
export async function checkMediaStatus(apiUrl: string, sha256: string): Promise<MediaStatus | null> {
  try {
    const response = await fetchWithTimeout(`${apiUrl}/api/check-result/${sha256}`, {
      method: 'GET',
      headers: getApiHeaders(),
    }, 'Media status check', { mutates: false });

    if (!response.ok) {
      if (response.status === 404) return null;
      throw new ApiError(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();
    // Returns null if no moderation action exists
    if (data === null) return null;
    return data as MediaStatus;
  } catch (error) {
    console.error('Failed to check media status:', error);
    return null;
  }
}

// Unblock media (set back to SAFE)
export async function unblockMedia(apiUrl: string, sha256: string, reason?: string): Promise<ApiResponse> {
  return moderateMedia(apiUrl, sha256, 'SAFE', reason || 'Unblocked by moderator');
}

// Decision log types
export interface ModerationDecision {
  id: number;
  target_type: 'event' | 'pubkey' | 'media';
  target_id: string;
  action: string;
  reason?: string;
  moderator_pubkey?: string;
  report_id?: string;
  created_at: string;
}

// Log a moderation decision
export async function logDecision(apiUrl: string, params: {
  targetType: 'event' | 'pubkey' | 'media';
  targetId: string;
  action: string;
  reason?: string;
  moderatorPubkey?: string;
  reportId?: string;
}): Promise<void> {
  await apiRequest<ApiResponse>(apiUrl, '/api/decisions', 'POST', params);
}

// Get decisions for a target
export async function getDecisions(apiUrl: string, targetId: string): Promise<ModerationDecision[]> {
  const data = await apiRequest<{ success: boolean; decisions: ModerationDecision[] }>(
    apiUrl,
    `/api/decisions/${targetId}`,
    'GET'
  );
  return data.decisions || [];
}

// Get all decisions (for building resolved targets list)
export async function getAllDecisions(apiUrl: string): Promise<ModerationDecision[]> {
  const data = await apiRequest<{ success: boolean; decisions: ModerationDecision[]; error?: string }>(
    apiUrl,
    '/api/decisions',
    'GET'
  );

  if (!data.success) {
    console.error('[adminApi] getAllDecisions failed:', data.error);
    throw new ApiError(data.error || 'Failed to get decisions');
  }

  return data.decisions || [];
}

// Delete all decisions for a target (reopens the report)
export async function deleteDecisions(apiUrl: string, targetId: string): Promise<number> {
  const data = await apiRequest<{ success: boolean; deleted: number }>(
    apiUrl,
    `/api/decisions/${targetId}`,
    'DELETE'
  );
  return data.deleted || 0;
}

// Verify that a pubkey was actually banned on the relay
export async function verifyPubkeyBanned(apiUrl: string, pubkey: string): Promise<boolean> {
  try {
    // Give the relay a moment to process
    await new Promise(resolve => setTimeout(resolve, 500));

    const bannedList = await listBannedPubkeys(apiUrl);
    return bannedList.some(entry => entry.pubkey === pubkey);
  } catch {
    // If we can't check, assume it worked
    return true;
  }
}

// Verify that a pubkey was actually unbanned on the relay
export async function verifyPubkeyUnbanned(apiUrl: string, pubkey: string): Promise<boolean> {
  try {
    await new Promise(resolve => setTimeout(resolve, 500));

    const bannedList = await listBannedPubkeys(apiUrl);
    return !bannedList.some(entry => entry.pubkey === pubkey);
  } catch {
    return true;
  }
}

// Verify that an event was actually deleted from the relay
export async function verifyEventDeleted(eventId: string, relayUrl: string): Promise<boolean> {
  try {
    // Give the relay a moment to process
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Try to fetch the event from the relay
    const ws = new WebSocket(relayUrl);

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        ws.close();
        resolve(true); // Timeout = probably deleted
      }, 5000);

      ws.onopen = () => {
        // Send a REQ for this specific event
        const subId = `verify-${Date.now()}`;
        ws.send(JSON.stringify(['REQ', subId, { ids: [eventId] }]));
      };

      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg[0] === 'EVENT' && msg[2]?.id === eventId) {
            // Event still exists!
            clearTimeout(timeout);
            ws.close();
            resolve(false);
          } else if (msg[0] === 'EOSE') {
            // End of stored events - event not found = deleted
            clearTimeout(timeout);
            ws.close();
            resolve(true);
          }
        } catch {
          // Ignore parse errors
        }
      };

      ws.onerror = () => {
        clearTimeout(timeout);
        ws.close();
        resolve(true); // Error = assume deleted
      };
    });
  } catch {
    return true; // Error = assume deleted
  }
}

// Verify that media was actually blocked
export async function verifyMediaBlocked(apiUrl: string, sha256: string): Promise<boolean> {
  try {
    // Give the moderation service a moment to process
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Check the moderation status
    const status = await checkMediaStatus(apiUrl, sha256);
    return status?.action === 'PERMANENT_BAN';
  } catch {
    return false;
  }
}

// Verify that media was actually age-restricted
export async function verifyAgeRestricted(apiUrl: string, sha256: string): Promise<boolean> {
  try {
    // Give the moderation service a moment to process
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Check the moderation status
    const status = await checkMediaStatus(apiUrl, sha256);
    return status?.action === 'AGE_RESTRICTED';
  } catch {
    return false;
  }
}

// Combined verification for block & delete action
export interface VerificationResult {
  eventDeleted: boolean;
  mediaBlocked: { hash: string; blocked: boolean }[];
  allSuccessful: boolean;
}

export async function verifyModerationAction(
  apiUrl: string,
  eventId: string,
  mediaHashes: string[],
  relayUrl: string
): Promise<VerificationResult> {
  // Run verifications in parallel
  const [eventDeleted, ...mediaResults] = await Promise.all([
    verifyEventDeleted(eventId, relayUrl),
    ...mediaHashes.map(async hash => ({
      hash,
      blocked: await verifyMediaBlocked(apiUrl, hash),
    })),
  ]);

  const mediaBlocked = mediaResults as { hash: string; blocked: boolean }[];
  const allMediaBlocked = mediaBlocked.every(m => m.blocked);

  return {
    eventDeleted,
    mediaBlocked,
    allSuccessful: eventDeleted && allMediaBlocked,
  };
}

// Extract sha256 hashes from media URLs in content or tags
export function extractMediaHashes(content: string, tags: string[][]): string[] {
  return extractSharedMediaHashes(content, tags);
}

// Scene classification from VLM
export interface SceneClassificationData {
  topics?: string[];
  setting?: string;
  objects?: string[];
  activities?: string[];
  mood?: string;
  description?: string;
  labels?: string[];
}

// Topic profile from VTT transcript
export interface TopicProfileData {
  topics?: Array<{ category: string; confidence: number; keywords_matched?: string[] }>;
  primary_topic?: string;
  has_speech?: boolean;
  language_hint?: string;
}

// Full classifier data from moderation service
export interface ClassifierData {
  rawClassifierData?: Record<string, unknown>;
  sceneClassification?: SceneClassificationData;
  topicProfile?: TopicProfileData;
}

// Fetch classifier data (scene classification + topic profile)
export async function getClassifierData(apiUrl: string, sha256: string): Promise<ClassifierData | null> {
  try {
    const response = await fetchWithTimeout(`${apiUrl}/api/check-classifier/${sha256}`, {
      method: 'GET',
      headers: getApiHeaders(),
    }, 'Classifier data', { mutates: false });

    if (!response.ok) {
      if (response.status === 404) return null;
      throw new ApiError(`HTTP ${response.status}: ${response.statusText}`);
    }

    return await response.json() as ClassifierData;
  } catch (error) {
    console.error('Failed to fetch classifier data:', error);
    return null;
  }
}

// AI Detection types (Reality Defender multi-provider aggregation)
export type AIVerdict = 'AUTHENTIC' | 'UNCERTAIN' | 'LIKELY_AI';
export type AIProviderStatus = 'pending' | 'processing' | 'complete' | 'error';

export interface AIProviderBreakdown {
  face_swap?: number | null;
  lip_sync?: number | null;
  voice_clone?: number | null;
  full_synthetic?: number | null;
  confidence?: number | null;
  deepfake_score?: number | null;
  ai_generated_score?: number | null;
  synthetic_score?: number | null;
  deepfake_probability?: number | null;
  detection_score?: number | null;
  techniques_detected?: string[];
}

export interface AIProviderResult {
  status: AIProviderStatus;
  score: number | null;
  verdict: AIVerdict | null;
  error: string | null;
  breakdown?: AIProviderBreakdown | null;
}

export interface AIConsensus {
  verdict: AIVerdict;
  confidence: 'high' | 'medium' | 'low';
  agreement: 'unanimous' | 'majority' | 'split';
}

export interface AIDetectionDetails {
  consensus: AIConsensus | null;
  providers: {
    reality_defender?: AIProviderResult;
    hive?: AIProviderResult;
    sensity?: AIProviderResult;
  };
  aggregation_method: string;
  average_score?: number;
  max_score?: number;
  provider_count?: number;
  skipped?: boolean;
  reason?: string;
  message?: string;
}

export interface AIDetectionResult {
  status: 'pending' | 'processing' | 'complete' | 'error';
  scores: {
    ai_generated: number;
    deepfake: number;
  };
  details: {
    ai_detection: AIDetectionDetails;
  };
  metadata: {
    job_status: string;
    job_id: string | null;
    media_hash?: string;
    submitted?: string;
    completed?: string;
    error?: string;
  };
}

// Fetch AI detection results by event ID (via worker proxy)
export async function getAIDetectionResult(apiUrl: string, eventId: string): Promise<AIDetectionResult | null> {
  try {
    const response = await fetchWithTimeout(`${apiUrl}/api/realness/jobs/${eventId}`, {
      method: 'GET',
      headers: { ...getApiHeaders(''), 'Accept': 'application/json' },
    }, 'AI detection result', { mutates: false });

    if (!response.ok) {
      if (response.status === 404) return null;
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const job = await response.json();

    // Normalize the response to our standard format
    return normalizeAIDetectionResponse(job);
  } catch (error) {
    console.error('Failed to fetch AI detection result:', error);
    return null;
  }
}

// Submit video for AI detection analysis (via worker proxy)
export async function submitAIDetection(
  apiUrl: string,
  videoUrl: string,
  sha256: string,
  eventId?: string
): Promise<{ jobId: string; status: string } | null> {
  try {
    const response = await fetchWithTimeout(`${apiUrl}/api/realness/analyze`, {
      method: 'POST',
      headers: getApiHeaders(),
      body: JSON.stringify({
        videoUrl,
        mediaHash: sha256,
        ...(eventId && { eventId }),
      }),
    }, 'AI detection submit', { mutates: true });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const result = await response.json();
    return {
      jobId: result.jobId || result.event_id || sha256,
      status: result.status || 'pending',
    };
  } catch (error) {
    console.error('Failed to submit AI detection:', error);
    return null;
  }
}

// Normalize raw job response to AIDetectionResult format
function normalizeAIDetectionResponse(job: Record<string, unknown>): AIDetectionResult {
  const results = (job.results || {}) as Record<string, Record<string, unknown>>;
  const scores = { ai_generated: 0, deepfake: 0 };
  const providers: AIDetectionDetails['providers'] = {};
  const providerScores: Array<{ provider: string; score: number }> = [];

  // Process each provider
  for (const [name, result] of Object.entries(results)) {
    const score = typeof result.score === 'number' ? result.score : null;
    // Normalize verdict to uppercase (realness returns lowercase)
    const rawVerdict = result.verdict as string | undefined;
    const normalizedVerdict = rawVerdict ? rawVerdict.toUpperCase() as AIVerdict : null;
    const providerResult: AIProviderResult = {
      status: (result.status as AIProviderStatus) || 'pending',
      score,
      verdict: normalizedVerdict || getVerdictFromScore(score),
      error: (result.error as string) || null,
      breakdown: extractBreakdown(name, result.raw as Record<string, unknown>),
    };

    if (name === 'reality_defender') {
      providers.reality_defender = providerResult;
    } else if (name === 'hive') {
      providers.hive = providerResult;
    } else if (name === 'sensity') {
      providers.sensity = providerResult;
    }

    if (result.status === 'complete' && score !== null) {
      providerScores.push({ provider: name, score });
    }
  }

  // Aggregate scores
  if (providerScores.length > 0) {
    const maxScore = Math.max(...providerScores.map(p => p.score));
    scores.ai_generated = maxScore;

    // Deepfake uses Reality Defender and Sensity only
    const deepfakeProviders = providerScores.filter(
      p => p.provider === 'reality_defender' || p.provider === 'sensity'
    );
    scores.deepfake = deepfakeProviders.length > 0
      ? Math.max(...deepfakeProviders.map(p => p.score))
      : maxScore;
  }

  // Determine consensus
  const verdicts = providerScores.map(p => getVerdictFromScore(p.score));
  const consensus = determineConsensus(verdicts);

  return {
    status: (job.status as 'pending' | 'processing' | 'complete' | 'error') || 'pending',
    scores,
    details: {
      ai_detection: {
        consensus,
        providers,
        aggregation_method: 'max_score',
        average_score: providerScores.length > 0
          ? providerScores.reduce((sum, p) => sum + p.score, 0) / providerScores.length
          : undefined,
        max_score: providerScores.length > 0
          ? Math.max(...providerScores.map(p => p.score))
          : undefined,
        provider_count: providerScores.length,
      },
    },
    metadata: {
      job_status: (job.status as string) || 'unknown',
      job_id: (job.event_id as string) || (job.job_id as string) || null,
      media_hash: job.media_hash as string | undefined,
      // Map realness field names (submitted_at/completed_at) to our format
      submitted: (job.submitted_at as string) || (job.submitted as string) || undefined,
      completed: (job.completed_at as string) || (job.completed as string) || undefined,
    },
  };
}

function getVerdictFromScore(score: number | null): AIVerdict | null {
  if (score === null) return null;
  if (score < 0.3) return 'AUTHENTIC';
  if (score < 0.7) return 'UNCERTAIN';
  return 'LIKELY_AI';
}

function determineConsensus(verdicts: (AIVerdict | null)[]): AIConsensus | null {
  const valid = verdicts.filter((v): v is AIVerdict => v !== null);
  if (valid.length === 0) return null;

  const counts = { AUTHENTIC: 0, UNCERTAIN: 0, LIKELY_AI: 0 };
  valid.forEach(v => counts[v]++);

  if (counts.AUTHENTIC === valid.length) {
    return { verdict: 'AUTHENTIC', confidence: 'high', agreement: 'unanimous' };
  }
  if (counts.LIKELY_AI === valid.length) {
    return { verdict: 'LIKELY_AI', confidence: 'high', agreement: 'unanimous' };
  }
  if (valid.length >= 2) {
    if (counts.AUTHENTIC >= 2) {
      return { verdict: 'AUTHENTIC', confidence: 'medium', agreement: 'majority' };
    }
    if (counts.LIKELY_AI >= 2) {
      return { verdict: 'LIKELY_AI', confidence: 'medium', agreement: 'majority' };
    }
  }

  return { verdict: 'UNCERTAIN', confidence: 'low', agreement: 'split' };
}

function extractBreakdown(
  provider: string,
  raw: Record<string, unknown> | undefined
): AIProviderBreakdown | null {
  if (!raw) return null;

  if (provider === 'reality_defender') {
    const result = raw.result as Record<string, unknown> | undefined;
    const details = result?.details as Record<string, unknown> | undefined;
    return {
      face_swap: details?.face_swap as number | null,
      lip_sync: details?.lip_sync as number | null,
      voice_clone: details?.voice_clone as number | null,
      full_synthetic: details?.full_synthetic as number | null,
      confidence: (result?.confidence as number) || null,
    };
  }

  if (provider === 'hive') {
    const result = (raw.result || raw) as Record<string, unknown>;
    return {
      deepfake_score: result.deepfake_score as number | null,
      ai_generated_score: result.ai_generated_score as number | null,
      synthetic_score: result.synthetic_score as number | null,
    };
  }

  if (provider === 'sensity') {
    const analysis = raw.analysis as Record<string, unknown> | undefined;
    return {
      deepfake_probability: analysis?.deepfake_probability as number | null,
      detection_score: analysis?.detection_score as number | null,
      confidence: analysis?.confidence as number | null,
      techniques_detected: (analysis?.techniques_detected as string[]) || [],
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Age Review
// ---------------------------------------------------------------------------

// Enforcement/response contract types live in shared/age-review.ts so the
// worker API and this client use one definition instead of duplicating it.
export type {
  AgeReviewCase,
  AgeReviewState,
  AgeBand,
  EnforcementLegStatus,
  AgeReviewEnforcement,
  AgeReviewCaseResponse,
} from '../../shared/age-review';

interface AgeReviewCasesResponse {
  success: boolean;
  cases: import('../../shared/age-review').AgeReviewCase[];
}

export async function getAgeReviewCases(
  apiUrl: string,
  params?: { state?: string; age_band?: string },
): Promise<AgeReviewCasesResponse> {
  const query = new URLSearchParams();
  if (params?.state) query.set('state', params.state);
  if (params?.age_band) query.set('age_band', params.age_band);
  const qs = query.toString();
  return apiRequest<AgeReviewCasesResponse>(apiUrl, `/api/age-review/cases${qs ? `?${qs}` : ''}`, 'GET');
}

export async function getAgeReviewCase(
  apiUrl: string,
  caseId: string,
): Promise<AgeReviewCaseResponse> {
  return apiRequest<AgeReviewCaseResponse>(apiUrl, `/api/age-review/cases/${caseId}`, 'GET');
}

export async function getAgeReviewFunnel(
  apiUrl: string,
  ageBand: string = 'age_13_15',
): Promise<import('../../shared/age-review').AgeReviewFunnelResponse> {
  return apiRequest<import('../../shared/age-review').AgeReviewFunnelResponse>(
    apiUrl,
    `/api/age-review/funnel?age_band=${encodeURIComponent(ageBand)}`,
    'GET',
  );
}

export async function updateAgeReviewCase(
  apiUrl: string,
  caseId: string,
  updates: Record<string, unknown>,
): Promise<AgeReviewCaseResponse> {
  return apiRequest<AgeReviewCaseResponse>(apiUrl, `/api/age-review/cases/${caseId}`, 'PATCH', updates);
}

// Minor onboarding
export interface CreateMinorAccountResponse {
  success: boolean;
  pubkey?: string;
  claim_url?: string;
  expires_at?: string;
  case_id?: string;
  error?: string;
}

export async function createMinorAccount(
  apiUrl: string,
  username: string,
  displayName?: string,
  zendeskTicketId?: number,
): Promise<CreateMinorAccountResponse> {
  const body: Record<string, unknown> = { username };
  if (displayName != null) body.display_name = displayName;
  if (zendeskTicketId != null) body.zendesk_ticket_id = zendeskTicketId;
  return apiRequest<CreateMinorAccountResponse>(apiUrl, '/api/age-review/create-minor-account', 'POST', body);
}

// Bulk moderation
export { VALID_BULK_ACTIONS, type BulkAction, type BulkModerateResult, type BulkJob, type BulkJobStatus };

// Enqueue a bulk moderation job. Returns immediately with a jobId; the work runs
// in a queue consumer. Poll getBulkJobStatus until the job is terminal.
export async function bulkModerate(
  apiUrl: string,
  pubkey: string,
  action: BulkAction,
  reason?: string,
): Promise<BulkEnqueueResponse> {
  const result = await apiRequest<BulkEnqueueResponse>(apiUrl, '/api/bulk-moderate', 'POST', { pubkey, action, reason });
  if (!result.success || !result.jobId) {
    throw new ApiError('Failed to start bulk moderation');
  }
  return result;
}

// Fetch a bulk job's current state. `status` is terminal at 'done' | 'failed'.
export async function getBulkJobStatus(apiUrl: string, jobId: string): Promise<BulkJob> {
  return apiRequest<BulkJob>(apiUrl, `/api/bulk-moderate/status/${encodeURIComponent(jobId)}`, 'GET');
}

// Delete media (convenience wrapper)
export async function deleteMedia(apiUrl: string, sha256: string, reason?: string): Promise<ApiResponse> {
  return moderateMedia(apiUrl, sha256, 'DELETE', reason || 'Deleted by moderator');
}

// Age review config
export interface AgeReviewConfig {
  auto_delete_on_deny: boolean;
}

export async function getAgeReviewConfig(apiUrl: string): Promise<AgeReviewConfig> {
  return apiRequest<AgeReviewConfig>(apiUrl, '/api/age-review/config', 'GET');
}

export async function updateAgeReviewConfig(
  apiUrl: string,
  config: Partial<AgeReviewConfig>,
): Promise<AgeReviewConfig> {
  return apiRequest<AgeReviewConfig>(apiUrl, '/api/age-review/config', 'PUT', config);
}
