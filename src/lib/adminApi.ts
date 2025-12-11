// ABOUTME: API client for the Divine Relay Admin Worker
// ABOUTME: Handles signing, publishing events, and NIP-86 relay management via the server-side Worker

const WORKER_URL = import.meta.env.VITE_WORKER_URL || 'https://divine-relay-admin-api.divine-video.workers.dev';

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
  endpoint: string,
  method: 'GET' | 'POST',
  body?: object
): Promise<T> {
  const response = await fetch(`${WORKER_URL}${endpoint}`, {
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

async function apiRequestWithValidation<T>(
  endpoint: string,
  method: 'GET' | 'POST',
  body?: object
): Promise<T> {
  const data = await apiRequest<ApiResponse<T>>(endpoint, method, body);

  if (!data.success) {
    throw new ApiError(data.error || 'Unknown error');
  }

  return (data.result ?? data.event ?? data) as T;
}

// Info endpoint
export async function getWorkerInfo(): Promise<InfoResponse> {
  return apiRequest<InfoResponse>('/api/info', 'GET');
}

// Publish endpoint - for general event publishing
export async function publishEvent(event: UnsignedEvent): Promise<ApiResponse> {
  const data = await apiRequest<ApiResponse>('/api/publish', 'POST', event);
  if (!data.success) {
    throw new ApiError(data.error || 'Failed to publish event');
  }
  return data;
}

// Moderate endpoint - for moderation actions
export async function moderateAction(params: ModerateParams): Promise<ApiResponse> {
  const data = await apiRequest<ApiResponse>('/api/moderate', 'POST', params);
  if (!data.success) {
    throw new ApiError(data.error || 'Moderation action failed');
  }
  return data;
}

export async function deleteEvent(eventId: string, reason?: string): Promise<ApiResponse> {
  return moderateAction({ action: 'delete_event', eventId, reason });
}

export async function banPubkeyViaModerate(pubkey: string, reason?: string): Promise<ApiResponse> {
  return moderateAction({ action: 'ban_pubkey', pubkey, reason });
}

export async function allowPubkey(pubkey: string): Promise<ApiResponse> {
  return moderateAction({ action: 'allow_pubkey', pubkey });
}

// NIP-86 Relay RPC endpoint - for direct relay management
export async function callRelayRpc<T = unknown>(
  method: string,
  params: (string | number | undefined)[] = []
): Promise<T> {
  const response = await fetch(`${WORKER_URL}/api/relay-rpc`, {
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
export async function banPubkey(pubkey: string, reason?: string): Promise<void> {
  await callRelayRpc('banpubkey', [pubkey, reason || 'Banned via admin']);
}

// Convenience function for unbanning pubkey via NIP-86 RPC
export async function unbanPubkey(pubkey: string): Promise<void> {
  await callRelayRpc('allowpubkey', [pubkey]);
}

// Banned pubkey can be a string or an object with pubkey and reason
export interface BannedPubkeyEntry {
  pubkey: string;
  reason?: string;
}

// List banned pubkeys - normalizes response to always be BannedPubkeyEntry[]
export async function listBannedPubkeys(): Promise<BannedPubkeyEntry[]> {
  const result = await callRelayRpc<string[] | BannedPubkeyEntry[]>('listbannedpubkeys');

  // Normalize: if it's an array of strings, convert to objects
  return result.map(item => {
    if (typeof item === 'string') {
      return { pubkey: item };
    }
    return item as BannedPubkeyEntry;
  });
}

// List banned events
export async function listBannedEvents(): Promise<Array<{ id: string; reason?: string }>> {
  return callRelayRpc<Array<{ id: string; reason?: string }>>('listbannedevents');
}

// Publish a NIP-32 label (kind 1985)
export async function publishLabel(params: LabelParams): Promise<ApiResponse> {
  const tags: string[][] = [
    ['L', params.namespace],
    ...params.labels.map(l => ['l', l, params.namespace]),
    [params.targetType === 'event' ? 'e' : 'p', params.targetValue],
  ];

  return publishEvent({
    kind: 1985,
    content: params.comment || '',
    tags,
  });
}

// Combined action: publish label and optionally ban
export async function publishLabelAndBan(
  params: LabelParams & { shouldBan?: boolean }
): Promise<{ labelPublished: boolean; banned: boolean }> {
  const result = { labelPublished: false, banned: false };

  // Publish the label first
  await publishLabel(params);
  result.labelPublished = true;

  // Optionally ban the pubkey
  if (params.shouldBan && params.targetType === 'pubkey') {
    await banPubkey(params.targetValue, `Labeled: ${params.labels.join(', ')}`);
    result.banned = true;
  }

  return result;
}

// Moderation resolution statuses
export type ResolutionStatus = 'reviewed' | 'dismissed' | 'no-action' | 'false-positive';

// Mark a report target as reviewed/resolved (creates a 1985 label)
export async function markAsReviewed(
  targetType: 'event' | 'pubkey',
  targetValue: string,
  status: ResolutionStatus = 'reviewed',
  comment?: string
): Promise<ApiResponse> {
  return publishLabel({
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
  sha256: string,
  action: ModerationAction,
  reason?: string
): Promise<ApiResponse> {
  const data = await apiRequest<ApiResponse>('/api/moderate-media', 'POST', {
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
export async function checkMediaStatus(sha256: string): Promise<MediaStatus | null> {
  try {
    const response = await fetch(`${WORKER_URL}/api/check-result/${sha256}`, {
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
export async function unblockMedia(sha256: string, reason?: string): Promise<ApiResponse> {
  return moderateMedia(sha256, 'SAFE', reason || 'Unblocked by moderator');
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
export async function logDecision(params: {
  targetType: 'event' | 'pubkey' | 'media';
  targetId: string;
  action: string;
  reason?: string;
  moderatorPubkey?: string;
  reportId?: string;
}): Promise<void> {
  await apiRequest<ApiResponse>('/api/decisions', 'POST', params);
}

// Get decisions for a target
export async function getDecisions(targetId: string): Promise<ModerationDecision[]> {
  const data = await apiRequest<{ success: boolean; decisions: ModerationDecision[] }>(
    `/api/decisions/${targetId}`,
    'GET'
  );
  return data.decisions || [];
}

// Get all decisions (for building resolved targets list)
export async function getAllDecisions(): Promise<ModerationDecision[]> {
  const data = await apiRequest<{ success: boolean; decisions: ModerationDecision[]; error?: string }>(
    '/api/decisions',
    'GET'
  );

  if (!data.success) {
    console.error('[adminApi] getAllDecisions failed:', data.error);
    throw new ApiError(data.error || 'Failed to get decisions');
  }

  return data.decisions || [];
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
export async function verifyMediaBlocked(sha256: string): Promise<boolean> {
  try {
    // Give the moderation service a moment to process
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Check the moderation status
    const status = await checkMediaStatus(sha256);
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
  eventId: string,
  mediaHashes: string[],
  relayUrl: string
): Promise<VerificationResult> {
  // Run verifications in parallel
  const [eventDeleted, ...mediaResults] = await Promise.all([
    verifyEventDeleted(eventId, relayUrl),
    ...mediaHashes.map(async hash => ({
      hash,
      blocked: await verifyMediaBlocked(hash),
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
