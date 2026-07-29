import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';

import { AgeReviewDetail } from './AgeReviewDetail';
import type { AgeReviewCase } from '../../shared/age-review';

// The pure derivations (contentVisibility, useReportedEvent) are covered by their
// own tests. What was NOT covered is that AgeReviewDetail actually FEEDS them:
// every plumbing prop could be hardcoded to a falsy default and the whole suite
// still passed. These tests assert the wiring through the rendered output, so a
// dropped prop shows up as a wrong claim on screen rather than as silence.

const userStats = vi.fn();
const accountStatus = vi.fn();
const reportedEvent = vi.fn();

vi.mock('@/hooks/useUserStats', () => ({ useUserStats: () => userStats() }));
vi.mock('@/hooks/useAccountStatus', () => ({ useAccountStatus: () => accountStatus() }));
vi.mock('@/hooks/useReportedEvent', () => ({ useReportedEvent: () => reportedEvent() }));
vi.mock('@/components/MediaPreview', () => ({ MediaPreview: () => <div data-testid="media-preview" /> }));
vi.mock('@/hooks/useAuthor', () => ({ useAuthor: () => ({ data: undefined, isLoading: false }) }));
vi.mock('@/hooks/useToast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/hooks/useAdminApi', () => ({
  useApiUrl: () => 'https://api.test',
  useAdminApi: () => ({
    updateAgeReviewCase: vi.fn().mockResolvedValue({ success: true }),
    getAgeReviewConfig: vi.fn().mockResolvedValue({ auto_delete_on_deny: false }),
    getAccountStatus: vi.fn().mockResolvedValue({ success: true, status: 'active' }),
  }),
}));

const PUBKEY = 'a'.repeat(64);

function makeCase(): AgeReviewCase {
  return {
    id: 'case-1',
    pubkey: PUBKEY,
    reporter_pubkey: 'b'.repeat(64),
    report_id: 'report-1',
    suspected_age_band: 'age_13_15',
    state: 'under_moderator_review',
    allowed_resolution: 'parent_video_or_email',
    parent_contact_email: null,
    deadline_at: new Date(Date.now() + 7 * 864e5).toISOString(),
    clock_paused: 0,
    clock_paused_at: null,
    remaining_days_when_paused: null,
    moderator_pubkey: null,
    resolution_note: null,
    last_alerted_at: null,
    zendesk_ticket_id: null,
    created_via: null,
  } as AgeReviewCase;
}

const emptyStats = (over: Record<string, unknown> = {}) => ({
  data: {
    postCount: 0, reportCount: 0, labelCount: 0,
    recentPosts: [], existingLabels: [], previousReports: [],
    relayIncomplete: false, ...over,
  },
  isError: false, isFetching: false, refetch: vi.fn(),
});

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  vi.clearAllMocks();
  userStats.mockReturnValue(emptyStats());
  accountStatus.mockReturnValue({ data: { success: true, status: 'active' }, isError: false, isLoading: false, refetch: vi.fn() });
  reportedEvent.mockReturnValue({ data: undefined, isFetching: false, isError: false, refetch: vi.fn() });
});

const show = () => render(<AgeReviewDetail caseData={makeCase()} />, { wrapper });

describe('AgeReviewDetail feeds the content derivations', () => {
  it('passes relayIncomplete through, so a truncated read is not shown as absence', async () => {
    userStats.mockReturnValue(emptyStats({ relayIncomplete: true }));
    show();
    await waitFor(() => expect(screen.getByText(/couldn't load/i)).toBeInTheDocument());
    expect(screen.queryByText(/no content found/i)).not.toBeInTheDocument();
  });

  it('passes account-status failure through, so suspension is not ruled out unchecked', async () => {
    // Stale successful data retained alongside isError: only the failed flag can
    // reveal that this answer is no longer trustworthy.
    accountStatus.mockReturnValue({ data: { success: true, status: 'active' }, isError: true, isLoading: false, refetch: vi.fn() });
    show();
    await waitFor(() => expect(screen.getByText(/suspension cannot be ruled out/i)).toBeInTheDocument());
  });

  it('does not claim absence before account status has arrived', async () => {
    accountStatus.mockReturnValue({ data: undefined, isError: false, isLoading: true, refetch: vi.fn() });
    show();
    await waitFor(() => expect(screen.getByText(/suspension cannot be ruled out/i)).toBeInTheDocument());
  });

  it('keeps content enforcement available when the relay read was truncated', async () => {
    // A zero count from an unfinished read must not mark the content levers n/a:
    // that tells a moderator an action is unavailable when it may well apply.
    userStats.mockReturnValue(emptyStats({ relayIncomplete: true }));
    const { container } = show();
    await waitFor(() => expect(screen.getByText(/couldn't load/i)).toBeInTheDocument());
    expect(container.textContent).not.toMatch(/n\/a/i);
  });

  it('marks content enforcement n/a only on a complete read that found nothing', async () => {
    // The contrast case: same zero count, but the read actually finished.
    userStats.mockReturnValue(emptyStats({ relayIncomplete: false }));
    const { container } = show();
    await waitFor(() => expect(screen.getByText(/no content found/i)).toBeInTheDocument());
    expect(container.textContent).toMatch(/n\/a/i);
  });

  it('passes the reported-event error through, so it is not shown as deleted', async () => {
    reportedEvent.mockReturnValue({ data: undefined, isFetching: false, isError: true, refetch: vi.fn() });
    show();
    await waitFor(() => expect(screen.getByText(/couldn't load the reported content/i)).toBeInTheDocument());
  });

  it('passes the in-flight reported-event read through as loading', async () => {
    reportedEvent.mockReturnValue({ data: undefined, isFetching: true, isError: false, refetch: vi.fn() });
    show();
    await waitFor(() => expect(screen.getByText(/loading reported content/i)).toBeInTheDocument());
  });

  it('surfaces a foreign-authored reported event rather than rendering it', async () => {
    reportedEvent.mockReturnValue({
      data: { status: 'target_foreign', targetEventId: 'c'.repeat(64), authorPubkey: 'e'.repeat(64) },
      isFetching: false, isError: false, refetch: vi.fn(),
    });
    show();
    await waitFor(() => expect(screen.getByText(/authored by a different account/i)).toBeInTheDocument());
    expect(screen.queryByTestId('media-preview')).not.toBeInTheDocument();
  });
});
