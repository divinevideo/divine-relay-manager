// ABOUTME: Tests UserStatsRow, the compact events/reports/labels row shown in
// ABOUTME: EventDetail, which must show "?" for any count from an incomplete
// ABOUTME: relay read rather than a confident number (#210).
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { UserStatsRow } from './UserStatsRow';
import type { UserStats } from '@/hooks/useUserStats';
import { STAT_UNKNOWN_TITLE } from '@/lib/statDisplay';

function makeStats(overrides: Partial<UserStats> = {}): UserStats {
  return {
    postCount: 0,
    reportCount: 0,
    labelCount: 0,
    recentPosts: [],
    existingLabels: [],
    previousReports: [],
    authoredContentIncomplete: false,
    labelsIncomplete: false,
    reportsIncomplete: false,
    relayIncomplete: false,
    ...overrides,
  };
}

describe('UserStatsRow', () => {
  it('renders verified counts as numbers when every read completed', () => {
    render(<UserStatsRow stats={makeStats({ postCount: 7, reportCount: 2, labelCount: 1 })} />);

    expect(screen.getByText('7 events')).toBeInTheDocument();
    expect(screen.getByText('2 reports')).toBeInTheDocument();
    expect(screen.getByText('1 labels')).toBeInTheDocument();
    expect(screen.queryByText(/\?/)).not.toBeInTheDocument();
  });

  it('shows "?" with a tooltip for events when the authored-content read did not complete', () => {
    render(<UserStatsRow stats={makeStats({ authoredContentIncomplete: true })} />);

    const events = screen.getByText('? events');
    expect(events).toHaveAttribute('title', STAT_UNKNOWN_TITLE);
    expect(screen.queryByText('0 events')).not.toBeInTheDocument();
    expect(screen.getByText('0 reports')).toBeInTheDocument();
  });

  it('shows "?" for reports when the reports read did not complete', () => {
    render(<UserStatsRow stats={makeStats({ reportsIncomplete: true })} />);
    expect(screen.getByText('? reports')).toBeInTheDocument();
  });

  it('shows "?" for labels when the labels read did not complete', () => {
    render(<UserStatsRow stats={makeStats({ labelsIncomplete: true })} />);
    expect(screen.getByText('? labels')).toBeInTheDocument();
  });
});
