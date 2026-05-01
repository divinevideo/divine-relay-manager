// ABOUTME: Tests for the compact dashboard product and trust stats strip
// ABOUTME: Verifies top-level pulse metrics and drill-down navigation

import { render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TestApp from '@/test/TestApp';
import { DashboardPulse } from './DashboardPulse';

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

describe('DashboardPulse', () => {
  beforeEach(() => {
    mocks.fetchDashboardStats.mockResolvedValue(dashboardResponse);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders product and trust pulse metrics with a stats drill-down link', async () => {
    render(
      <TestApp>
        <DashboardPulse />
      </TestApp>
    );

    expect(await screen.findByText('Product + Trust Pulse')).toBeInTheDocument();
    expect(within(screen.getByLabelText('Active users')).getByText('4')).toBeInTheDocument();
    expect(within(screen.getByLabelText('Video posts')).getByText('30')).toBeInTheDocument();
    expect(within(screen.getByLabelText('Videos last hour')).getByText('2')).toBeInTheDocument();
    expect(within(screen.getByLabelText('Loops last day')).getByText('42')).toBeInTheDocument();
    expect(within(screen.getByLabelText('Pending reports')).getByText('3')).toBeInTheDocument();

    expect(screen.getByRole('link', { name: /Stats & trends/i })).toHaveAttribute('href', '/stats');
  });
});
