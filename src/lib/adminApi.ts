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

// List banned pubkeys
export async function listBannedPubkeys(): Promise<string[]> {
  return callRelayRpc<string[]>('listbannedpubkeys');
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
