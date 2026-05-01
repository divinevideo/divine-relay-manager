// ABOUTME: Tests route registration for the detailed stats dashboard
// ABOUTME: Verifies /stats opens the product and trust trends page inside the app shell

import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';

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
    topVideos: { value: [], status: 'live' },
    topCreators: { value: [], status: 'live' },
    auth: {
      registrations: { value: null, status: 'unavailable' },
      logins: { value: null, status: 'unavailable' },
    },
  },
};

describe('AppRouter stats route', () => {
  beforeEach(() => {
    window.history.pushState({}, '', '/stats');
    mocks.fetchDashboardStats.mockResolvedValue(dashboardResponse);
  });

  afterEach(() => {
    vi.clearAllMocks();
    window.history.pushState({}, '', '/');
  });

  it('renders Stats & Trends at /stats', async () => {
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Stats & Trends' })).toBeInTheDocument();
  });
});
