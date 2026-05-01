// ABOUTME: Tests for product and trust dashboard stats aggregation
// ABOUTME: Verifies read-only Funnelcake and relay data produce the admin pulse payload

import { describe, it, expect, vi, afterEach } from 'vitest';
import worker from './index';
import {
  aggregateLeaderboardEngagement,
  buildUnavailableAuthTelemetry,
  summarizeTrustQueue,
  summarizeVideoActivity,
  type DashboardStatsResponse,
  type LeaderboardVideo,
  type RelayEvent,
} from './dashboard-stats';

type MockRelayFilter = {
  kinds?: number[];
  since?: number;
  limit?: number;
  '#L'?: string[];
};

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static filters: MockRelayFilter[] = [];
  static responses: Array<{ match: (filter: MockRelayFilter) => boolean; events: RelayEvent[] }> = [];

  readyState = MockWebSocket.CONNECTING;
  private listeners: Map<string, Array<(event: unknown) => void>> = new Map();

  constructor(_url: string) {
    setTimeout(() => {
      this.readyState = MockWebSocket.OPEN;
      this.emit('open', {});
    }, 0);
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type)!.push(listener);
  }

  send(data: string): void {
    const parsed = JSON.parse(data) as ['REQ', string, MockRelayFilter];
    const [, subId, filter] = parsed;
    MockWebSocket.filters.push(filter);
    const response = MockWebSocket.responses.find(entry => entry.match(filter));

    setTimeout(() => {
      for (const event of response?.events || []) {
        this.emit('message', { data: JSON.stringify(['EVENT', subId, event]) });
      }
      this.emit('message', { data: JSON.stringify(['EOSE', subId]) });
    }, 0);
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.emit('close', {});
  }

  private emit(type: string, event: unknown): void {
    for (const handler of this.listeners.get(type) || []) handler(event);
  }
}

function relayEvent(overrides: Partial<RelayEvent>): RelayEvent {
  return {
    id: overrides.id || `event-${Math.random()}`,
    pubkey: overrides.pubkey || 'publisher',
    kind: overrides.kind || 21,
    created_at: overrides.created_at || 1_700_000_000,
    content: overrides.content || '',
    tags: overrides.tags || [],
    sig: overrides.sig || 'sig',
  };
}

function createEnv() {
  return {
    NOSTR_NSEC: 'nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5',
    RELAY_URL: 'wss://relay.test.com',
    ALLOWED_ORIGINS: 'http://localhost:5173',
  };
}

describe('dashboard stats aggregation', () => {
  const now = 1_700_000_000;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('summarizes recent video posts and active publishers', () => {
    const summary = summarizeVideoActivity([
      relayEvent({ id: 'recent-1', kind: 21, pubkey: 'alice', created_at: now - 60 }),
      relayEvent({ id: 'recent-2', kind: 34235, pubkey: 'bob', created_at: now - 3_500 }),
      relayEvent({ id: 'day-1', kind: 22, pubkey: 'alice', created_at: now - 7_200 }),
      relayEvent({ id: 'old', kind: 21, pubkey: 'chuck', created_at: now - 90_000 }),
      relayEvent({ id: 'note', kind: 1, pubkey: 'dana', created_at: now - 30 }),
    ], now);

    expect(summary).toEqual({
      postsLastHour: 2,
      postsLastDay: 3,
      activePublishersLastDay: 2,
    });
  });

  it('summarizes pending and resolved trust workload by target', () => {
    const summary = summarizeTrustQueue([
      relayEvent({ id: 'report-1', kind: 1984, tags: [['e', 'video-a']] }),
      relayEvent({ id: 'report-2', kind: 1984, tags: [['e', 'video-b']] }),
      relayEvent({ id: 'report-3', kind: 1984, tags: [['e', 'video-a']] }),
    ], [
      relayEvent({ id: 'resolution-1', kind: 1985, tags: [['L', 'moderation/resolution'], ['e', 'video-a']] }),
    ]);

    expect(summary).toEqual({
      pendingReports: 1,
      reportTargets: 2,
      resolvedTargets: 1,
    });
  });

  it('aggregates one-day leaderboard engagement totals', () => {
    const videos: LeaderboardVideo[] = [
      { id: 'video-a', author: 'alice', views: 10, unique_viewers: 4, loops: 7 },
      { id: 'video-b', author: 'bob', views: 3, unique_viewers: 2, loops: 5 },
    ];

    expect(aggregateLeaderboardEngagement(videos)).toEqual({
      viewsLastDay: 13,
      uniqueViewersLastDay: 6,
      loopsLastDay: 12,
      source: 'leaderboard_top_day',
    });
  });

  it('marks registration and login telemetry unavailable until an existing source is present', () => {
    expect(buildUnavailableAuthTelemetry()).toEqual({
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
    });
  });

  it('serves /api/dashboard-stats with product and trust signals', async () => {
    const videos: LeaderboardVideo[] = [
      { id: 'video-a', author: 'alice', views: 10, unique_viewers: 4, loops: 7 },
      { id: 'video-b', author: 'bob', views: 3, unique_viewers: 2, loops: 5 },
    ];
    const creators = [
      { pubkey: 'alice', views: 12, unique_viewers: 5, loops: 9, videos_with_views: 2 },
    ];
    const mockFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith('/api/stats')) {
        return Response.json({ total_events: 120, total_videos: 30, vine_videos: 9 });
      }
      if (url.includes('/api/leaderboard/videos')) {
        return Response.json({ period: 'day', entries: videos });
      }
      if (url.includes('/api/leaderboard/creators')) {
        return Response.json({ period: 'day', entries: creators });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', mockFetch);

    MockWebSocket.filters = [];
    MockWebSocket.responses = [
      {
        match: filter => filter.kinds?.some(kind => [21, 22, 34235, 34236].includes(kind)) ?? false,
        events: [
          relayEvent({ id: 'recent-1', kind: 21, pubkey: 'alice', created_at: now - 20 }),
          relayEvent({ id: 'recent-2', kind: 34236, pubkey: 'bob', created_at: now - 40 }),
          relayEvent({ id: 'day-1', kind: 22, pubkey: 'alice', created_at: now - 7_000 }),
        ],
      },
      {
        match: filter => filter.kinds?.includes(1984) ?? false,
        events: [
          relayEvent({ id: 'report-1', kind: 1984, tags: [['e', 'video-a']] }),
          relayEvent({ id: 'report-2', kind: 1984, tags: [['e', 'video-c']] }),
        ],
      },
      {
        match: filter => filter.kinds?.includes(1985) ?? false,
        events: [
          relayEvent({ id: 'resolution-1', kind: 1985, tags: [['L', 'moderation/resolution'], ['e', 'video-a']] }),
        ],
      },
    ];
    vi.stubGlobal('WebSocket', MockWebSocket);

    vi.spyOn(Date, 'now').mockReturnValue(now * 1_000);

    const response = await worker.fetch(
      new Request('http://localhost/api/dashboard-stats', {
        headers: { 'Cf-Access-Jwt-Assertion': 'test' },
      }),
      createEnv() as never,
      { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext,
    );

    expect(response.status).toBe(200);
    const body = await response.json() as DashboardStatsResponse;

    expect(body.success).toBe(true);
    expect(body.stats.platform.value).toEqual({ total_events: 120, total_videos: 30, vine_videos: 9 });
    expect(body.stats.videoActivity.value).toEqual({
      postsLastHour: 2,
      postsLastDay: 3,
      activePublishersLastDay: 2,
    });
    expect(body.stats.engagement.value.loopsLastDay).toBe(12);
    expect(body.stats.trust.value.pendingReports).toBe(1);
    expect(body.stats.auth.registrations.status).toBe('unavailable');
    expect(body.stats.topVideos.value).toEqual(videos);
    expect(body.stats.topCreators.value).toEqual(creators);
  });
});
