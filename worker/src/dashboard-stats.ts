// ABOUTME: Product and trust dashboard stats aggregation for the admin worker
// ABOUTME: Composes existing read-only Funnelcake and relay sources without schema changes

import { deriveFunnelcakeApiUrl } from './funnelcake-proxy';

export const VIDEO_KINDS = [21, 22, 34235, 34236] as const;

export type MetricStatus = 'live' | 'partial' | 'unavailable' | 'error';

export interface DashboardMetric<T> {
  value: T;
  status: MetricStatus;
  message?: string;
}

export interface RelayEvent {
  id: string;
  pubkey: string;
  kind: number;
  created_at: number;
  content: string;
  tags: string[][];
  sig?: string;
}

export interface PlatformStats {
  total_events: number;
  total_videos: number;
  vine_videos: number;
}

export interface LeaderboardVideo {
  id?: string;
  event_id?: string;
  author?: string;
  pubkey?: string;
  views: number;
  unique_viewers: number;
  loops: number;
  [key: string]: unknown;
}

export interface LeaderboardCreator {
  pubkey: string;
  views: number;
  unique_viewers: number;
  loops: number;
  videos_with_views: number;
  [key: string]: unknown;
}

export interface LeaderboardResponse<T> {
  period: string;
  entries: T[];
}

export interface VideoActivitySummary {
  postsLastHour: number;
  postsLastDay: number;
  activePublishersLastDay: number;
}

export interface EngagementSummary {
  viewsLastDay: number;
  uniqueViewersLastDay: number;
  loopsLastDay: number;
  source: 'leaderboard_top_day';
}

export interface TrustSummary {
  pendingReports: number;
  reportTargets: number;
  resolvedTargets: number;
}

export interface AuthTelemetry {
  registrations: DashboardMetric<number | null>;
  logins: DashboardMetric<number | null>;
}

export interface DashboardStats {
  generatedAt: string;
  platform: DashboardMetric<PlatformStats | null>;
  videoActivity: DashboardMetric<VideoActivitySummary>;
  engagement: DashboardMetric<EngagementSummary>;
  trust: DashboardMetric<TrustSummary>;
  topVideos: DashboardMetric<LeaderboardVideo[]>;
  topCreators: DashboardMetric<LeaderboardCreator[]>;
  auth: AuthTelemetry;
}

export interface DashboardStatsResponse {
  success: boolean;
  stats: DashboardStats;
  error?: string;
}

export interface DashboardStatsEnv {
  RELAY_URL: string;
  FUNNELCAKE_API_URL?: string;
}

interface FunnelcakeSources {
  platform: PlatformStats;
  topVideos: LeaderboardVideo[];
  topCreators: LeaderboardCreator[];
}

interface RelayQueryResult {
  success: boolean;
  events: RelayEvent[];
  error?: string;
}

function numberValue(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function sourceUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, '')}${path}`;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
  });

  if (!response.ok) {
    throw new Error(`GET ${url} failed with ${response.status}`);
  }

  return response.json() as Promise<T>;
}

function entriesFromResponse<T>(response: LeaderboardResponse<T>): T[] {
  return Array.isArray(response.entries) ? response.entries : [];
}

export async function fetchFunnelcakeDashboardSources(baseUrl: string): Promise<FunnelcakeSources> {
  const [platform, videoLeaderboard, creatorLeaderboard] = await Promise.all([
    fetchJson<PlatformStats>(sourceUrl(baseUrl, '/api/stats')),
    fetchJson<LeaderboardResponse<LeaderboardVideo>>(sourceUrl(baseUrl, '/api/leaderboard/videos?period=day&limit=10')),
    fetchJson<LeaderboardResponse<LeaderboardCreator>>(sourceUrl(baseUrl, '/api/leaderboard/creators?period=day&limit=10')),
  ]);

  return {
    platform,
    topVideos: entriesFromResponse(videoLeaderboard),
    topCreators: entriesFromResponse(creatorLeaderboard),
  };
}

export function summarizeVideoActivity(events: RelayEvent[], nowSeconds: number): VideoActivitySummary {
  const oneHourAgo = nowSeconds - 60 * 60;
  const oneDayAgo = nowSeconds - 24 * 60 * 60;
  const publishersLastDay = new Set<string>();
  let postsLastHour = 0;
  let postsLastDay = 0;

  for (const event of events) {
    if (!VIDEO_KINDS.includes(event.kind as (typeof VIDEO_KINDS)[number])) continue;
    if (event.created_at < oneDayAgo || event.created_at > nowSeconds) continue;

    postsLastDay += 1;
    publishersLastDay.add(event.pubkey);

    if (event.created_at >= oneHourAgo) {
      postsLastHour += 1;
    }
  }

  return {
    postsLastHour,
    postsLastDay,
    activePublishersLastDay: publishersLastDay.size,
  };
}

export function aggregateLeaderboardEngagement(videos: LeaderboardVideo[]): EngagementSummary {
  return videos.reduce<EngagementSummary>((summary, video) => ({
    viewsLastDay: summary.viewsLastDay + numberValue(video.views),
    uniqueViewersLastDay: summary.uniqueViewersLastDay + numberValue(video.unique_viewers),
    loopsLastDay: summary.loopsLastDay + numberValue(video.loops),
    source: 'leaderboard_top_day',
  }), {
    viewsLastDay: 0,
    uniqueViewersLastDay: 0,
    loopsLastDay: 0,
    source: 'leaderboard_top_day',
  });
}

function targetIds(events: RelayEvent[]): Set<string> {
  const ids = new Set<string>();
  for (const event of events) {
    for (const tag of event.tags || []) {
      if ((tag[0] === 'e' || tag[0] === 'p') && tag[1]) {
        ids.add(tag[1]);
      }
    }
  }
  return ids;
}

export function summarizeTrustQueue(reportEvents: RelayEvent[], resolutionEvents: RelayEvent[]): TrustSummary {
  const reportedTargets = targetIds(reportEvents);
  const resolvedTargets = targetIds(resolutionEvents);
  let resolvedReportedTargets = 0;

  for (const targetId of reportedTargets) {
    if (resolvedTargets.has(targetId)) {
      resolvedReportedTargets += 1;
    }
  }

  return {
    pendingReports: Math.max(0, reportedTargets.size - resolvedReportedTargets),
    reportTargets: reportedTargets.size,
    resolvedTargets: resolvedReportedTargets,
  };
}

export function buildUnavailableAuthTelemetry(): AuthTelemetry {
  return {
    registrations: {
      value: null,
      status: 'unavailable',
      message: 'Registration telemetry is not exposed by current read-only sources.',
    },
    logins: {
      value: null,
      status: 'unavailable',
      message: 'Login telemetry is not exposed by current read-only sources.',
    },
  };
}

async function queryRelay(filter: object, relayUrl: string): Promise<RelayQueryResult> {
  return new Promise((resolve) => {
    try {
      const ws = new WebSocket(relayUrl);
      const events: RelayEvent[] = [];
      const subId = `dashboard-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      let resolved = false;

      const finish = (result: RelayQueryResult): void => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeout);
        try {
          ws.close();
        } catch {
          // Ignore close errors from test doubles or already-closed sockets.
        }
        resolve(result);
      };

      const timeout = setTimeout(() => {
        finish({ success: true, events });
      }, 5_000);

      ws.addEventListener('open', () => {
        ws.send(JSON.stringify(['REQ', subId, filter]));
      });

      ws.addEventListener('message', (message) => {
        try {
          if (typeof message.data !== 'string') return;
          const data = JSON.parse(message.data) as unknown[];
          if (data[0] === 'EVENT' && data[1] === subId) {
            events.push(data[2] as RelayEvent);
          } else if (data[0] === 'EOSE' && data[1] === subId) {
            finish({ success: true, events });
          }
        } catch {
          // Ignore malformed relay frames and keep collecting valid events.
        }
      });

      ws.addEventListener('error', () => {
        finish({ success: false, events: [], error: 'WebSocket error' });
      });

      ws.addEventListener('close', () => {
        finish({ success: true, events });
      });
    } catch (error) {
      resolve({
        success: false,
        events: [],
        error: error instanceof Error ? error.message : 'Unknown relay query error',
      });
    }
  });
}

function zeroVideoActivity(): VideoActivitySummary {
  return {
    postsLastHour: 0,
    postsLastDay: 0,
    activePublishersLastDay: 0,
  };
}

function zeroTrust(): TrustSummary {
  return {
    pendingReports: 0,
    reportTargets: 0,
    resolvedTargets: 0,
  };
}

export async function collectDashboardStats(env: DashboardStatsEnv): Promise<DashboardStats> {
  const nowSeconds = Math.floor(Date.now() / 1_000);
  const funnelcakeBaseUrl = deriveFunnelcakeApiUrl(env.RELAY_URL, env.FUNNELCAKE_API_URL);

  const [funnelcakeResult, videoEventsResult, reportsResult, resolutionsResult] = await Promise.allSettled([
    fetchFunnelcakeDashboardSources(funnelcakeBaseUrl),
    queryRelay({ kinds: [...VIDEO_KINDS], since: nowSeconds - 24 * 60 * 60, limit: 1_000 }, env.RELAY_URL),
    queryRelay({ kinds: [1984], limit: 200 }, env.RELAY_URL),
    queryRelay({ kinds: [1985], '#L': ['moderation/resolution'], limit: 500 }, env.RELAY_URL),
  ] as const);

  const funnelcakeSources = funnelcakeResult.status === 'fulfilled' ? funnelcakeResult.value : null;
  const videoEvents = videoEventsResult.status === 'fulfilled' && videoEventsResult.value.success
    ? videoEventsResult.value.events
    : null;
  const reportEvents = reportsResult.status === 'fulfilled' && reportsResult.value.success
    ? reportsResult.value.events
    : null;
  const resolutionEvents = resolutionsResult.status === 'fulfilled' && resolutionsResult.value.success
    ? resolutionsResult.value.events
    : null;

  const videoActivityError = videoEventsResult.status === 'fulfilled'
    ? videoEventsResult.value.error
    : errorMessage(videoEventsResult.reason);
  const reportsError = reportsResult.status === 'fulfilled'
    ? reportsResult.value.error
    : errorMessage(reportsResult.reason);
  const resolutionsError = resolutionsResult.status === 'fulfilled'
    ? resolutionsResult.value.error
    : errorMessage(resolutionsResult.reason);

  const funnelcakeError = funnelcakeResult.status === 'rejected'
    ? errorMessage(funnelcakeResult.reason)
    : 'Funnelcake dashboard sources unavailable.';
  const topVideos = funnelcakeSources?.topVideos ?? [];

  return {
    generatedAt: new Date(nowSeconds * 1_000).toISOString(),
    platform: funnelcakeSources
      ? { value: funnelcakeSources.platform, status: 'live' }
      : {
        value: null,
        status: 'error',
        message: funnelcakeError,
      },
    videoActivity: videoEvents
      ? { value: summarizeVideoActivity(videoEvents, nowSeconds), status: 'live' }
      : {
        value: zeroVideoActivity(),
        status: 'error',
        message: videoActivityError || 'Relay video activity query failed.',
      },
    engagement: funnelcakeSources
      ? { value: aggregateLeaderboardEngagement(topVideos), status: 'partial' }
      : {
        value: aggregateLeaderboardEngagement([]),
        status: 'error',
        message: funnelcakeError,
      },
    trust: reportEvents && resolutionEvents
      ? { value: summarizeTrustQueue(reportEvents, resolutionEvents), status: 'live' }
      : {
        value: zeroTrust(),
        status: 'error',
        message: reportsError || resolutionsError || 'Trust relay queries failed.',
      },
    topVideos: funnelcakeSources
      ? { value: topVideos, status: 'live' }
      : {
        value: [],
        status: 'error',
        message: funnelcakeError,
      },
    topCreators: funnelcakeSources
      ? { value: funnelcakeSources.topCreators, status: 'live' }
      : {
        value: [],
        status: 'error',
        message: funnelcakeError,
      },
    auth: buildUnavailableAuthTelemetry(),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || 'Unknown error');
}

export async function handleDashboardStats(
  env: DashboardStatsEnv,
  corsHeaders: Record<string, string>,
): Promise<Response> {
  const stats = await collectDashboardStats(env);
  const body: DashboardStatsResponse = { success: true, stats };

  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'private, max-age=30',
      ...corsHeaders,
    },
  });
}
