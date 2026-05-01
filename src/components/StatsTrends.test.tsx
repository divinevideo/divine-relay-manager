// ABOUTME: Tests for the detailed product and trust stats dashboard page
// ABOUTME: Verifies metric groups, leaderboard rows, and unavailable auth telemetry status

import { render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TestApp from '@/test/TestApp';
import { StatsTrends } from './StatsTrends';

const mocks = vi.hoisted(() => ({
  fetchDashboardStats: vi.fn(),
}));

vi.mock('@/hooks/useAdminApi', () => ({
  useAdminApi: () => ({
    fetchDashboardStats: mocks.fetchDashboardStats,
  }),
}));

const dashboardResponse = {
  success: true,
  stats: {
    generatedAt: '2026-05-02T00:00:00.000Z',
    platform: { value: { total_events: 120, total_videos: 30, vine_videos: 9 }, status: 'live' },
    videoActivity: {
      value: { postsLastHour: 2, postsLastDay: 12, activePublishersLastDay: 4 },
      status: 'live',
    },
    engagement: {
      value: {
        viewsLastDay: 80,
        uniqueViewersLastDay: 24,
        loopsLastDay: 42,
        source: 'leaderboard_top_day',
      },
      status: 'partial',
    },
    trust: { value: { pendingReports: 3, reportTargets: 6, resolvedTargets: 3 }, status: 'live' },
    topVideos: {
      value: [
        { id: 'video-a', author: 'alice', views: 40, unique_viewers: 10, loops: 21 },
        { id: 'video-b', author: 'bob', views: 20, unique_viewers: 8, loops: 12 },
      ],
      status: 'live',
    },
    topCreators: {
      value: [
        { pubkey: 'alice', views: 60, unique_viewers: 16, loops: 33, videos_with_views: 2 },
      ],
      status: 'live',
    },
    auth: {
      registrations: { value: null, status: 'unavailable' },
      logins: { value: null, status: 'unavailable' },
    },
  },
};

describe('StatsTrends', () => {
  beforeEach(() => {
    mocks.fetchDashboardStats.mockResolvedValue(dashboardResponse);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders detailed status and trends for product and trust', async () => {
    render(
      <TestApp>
        <StatsTrends />
      </TestApp>
    );

    expect(await screen.findByRole('heading', { name: 'Stats & Trends' })).toBeInTheDocument();
    expect(within(screen.getByLabelText('Active users')).getByText('4')).toBeInTheDocument();
    expect(within(screen.getByLabelText('Videos last day')).getByText('12')).toBeInTheDocument();
    expect(within(screen.getByLabelText('Views last day')).getByText('80')).toBeInTheDocument();
    expect(within(screen.getByLabelText('Pending reports')).getByText('3')).toBeInTheDocument();

    expect(screen.getByText('video-a')).toBeInTheDocument();
    expect(screen.getByText('alice')).toBeInTheDocument();
    expect(within(screen.getByLabelText('Registrations')).getByText('Unavailable')).toBeInTheDocument();
    expect(within(screen.getByLabelText('Logins')).getByText('Unavailable')).toBeInTheDocument();
  });
});
