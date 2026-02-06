// ABOUTME: API client for the Divine Relay Admin Worker
// ABOUTME: Handles signing, publishing events, and NIP-86 relay management via the server-side Worker
// ABOUTME: All functions accept apiUrl as first parameter to support environment switching

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

class ApiError extends Error {
  constructor(
    message: string,
    public statusCode?: number,
    public statusText?: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function apiRequest<T>(
  apiUrl: string,
  endpoint: string,
  method: 'GET' | 'POST' | 'DELETE',
  body?: object
): Promise<T> {
  if (!apiUrl) {
    throw new ApiError('No relay selected. Go to Settings to choose an environment.');
  }
  const response = await fetch(`${apiUrl}${endpoint}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    throw new ApiError(
      `HTTP ${response.status}: ${response.statusText}`,
      response.status,
      response.statusText
    );
  }

  const data = await response.json() as T;
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

export async function deleteEvent(apiUrl: string, eventId: string, reason?: string): Promise<ApiResponse> {
  return moderateAction(apiUrl, { action: 'delete_event', eventId, reason });
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
  const response = await fetch(`${apiUrl}/api/relay-rpc`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ method, params }),
  });

  if (!response.ok) {
    throw new ApiError(
      `HTTP ${response.status}: ${response.statusText}`,
      response.status,
      response.statusText
    );
  }

  const data = await response.json() as ApiResponse<T>;

  if (!data.success) {
    throw new ApiError(data.error || 'RPC call failed');
  }

  return data.result as T;
}

// Convenience function for banning pubkey via NIP-86 RPC
export async function banPubkey(apiUrl: string, pubkey: string, reason?: string): Promise<void> {
  await callRelayRpc(apiUrl, 'banpubkey', [pubkey, reason || 'Banned via admin']);
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

// Media moderation actions
export type ModerationAction = 'SAFE' | 'REVIEW' | 'AGE_RESTRICTED' | 'PERMANENT_BAN';

export interface MediaStatus {
  sha256: string;
  action: ModerationAction;
  reason?: string;
  created_at?: string;
  source?: string;
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
    const response = await fetch(`${apiUrl}/api/check-result/${sha256}`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });

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
  const hashes: Set<string> = new Set();

  // Common Blossom/media URL patterns with sha256
  // e.g., https://cdn.example.com/abc123def456.mp4
  // e.g., https://blossom.example.com/sha256/abc123def456
  const sha256Pattern = /\b([a-f0-9]{64})\b/gi;

  // Check content for hashes
  let match;
  while ((match = sha256Pattern.exec(content)) !== null) {
    hashes.add(match[1].toLowerCase());
  }

  // Check imeta tags and url tags
  for (const tag of tags) {
    if (tag[0] === 'imeta' || tag[0] === 'url' || tag[0] === 'x') {
      const tagContent = tag.join(' ');
      sha256Pattern.lastIndex = 0;
      while ((match = sha256Pattern.exec(tagContent)) !== null) {
        hashes.add(match[1].toLowerCase());
      }
    }
    // Direct x tag with hash
    if (tag[0] === 'x' && tag[1] && /^[a-f0-9]{64}$/i.test(tag[1])) {
      hashes.add(tag[1].toLowerCase());
    }
  }

  return Array.from(hashes);
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
    const response = await fetch(`${apiUrl}/api/realness/jobs/${eventId}`, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
    });

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
    const response = await fetch(`${apiUrl}/api/realness/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        videoUrl,
        mediaHash: sha256,
        ...(eventId && { eventId }),
      }),
    });

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
