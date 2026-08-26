// ABOUTME: Tests the age-review queue's per-state drill-down chips: they narrow
// ABOUTME: Active/Closed/All to one state and reset when the tab changes.

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { AgeReviewCase } from '../../shared/age-review';
import { AgeReview } from './AgeReview';

const getAgeReviewCases = vi.fn();
const getActiveAgeReviewCase = vi.fn();
const getAgeReviewCase = vi.fn();
const getAgeReviewCaseCounts = vi.fn();

vi.mock('@/hooks/useAdminApi', () => ({
  useApiUrl: () => 'https://api.test.divine.video',
  useAdminApi: () => ({
    getAgeReviewCases,
    getActiveAgeReviewCase,
    getAgeReviewCase,
    getAgeReviewCaseCounts,
  }),
}));

vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('@/components/AgeReviewDetail', () => ({ AgeReviewDetail: () => null }));
vi.mock('@/components/AgeReviewFunnel', () => ({ AgeReviewFunnel: () => null }));
vi.mock('@/components/CreateMinorAccountDialog', () => ({ CreateMinorAccountDialog: () => null }));
vi.mock('@/components/UserIdentifier', () => ({
  UserIdentifier: ({ pubkey }: { pubkey: string }) => <span>{pubkey.slice(0, 8)}</span>,
}));

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/age-review']}>
        <AgeReview />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

/** The state on the most recent list fetch (undefined when no state filter). */
function lastListState(): string | undefined {
  const calls = getAgeReviewCases.mock.calls;
  return (calls[calls.length - 1]?.[0] as { state?: string } | undefined)?.state;
}

beforeEach(() => {
  getAgeReviewCases.mockReset();
  getActiveAgeReviewCase.mockReset();
  getAgeReviewCase.mockReset();
  getAgeReviewCaseCounts.mockReset();
  getAgeReviewCases.mockResolvedValue({ success: true, cases: [] as AgeReviewCase[] });
  getAgeReviewCase.mockResolvedValue({ success: true, case: null });
  getAgeReviewCaseCounts.mockResolvedValue({
    success: true,
    by_state: {
      open_reported: 5,
      under_moderator_review: 4,
      restricted_pending_user_response: 99,
      submitted_for_review: 2,
      cleared: 135,
      denied_closed: 74,
    },
  });
});

describe('AgeReview drill-down chips', () => {
  it('shows a chip per non-terminal state, with counts, on the default Active tab', async () => {
    renderPage();
    const chips = await screen.findByRole('group', { name: /Filter by case status/ });
    expect(within(chips).getByRole('button', { name: /^All/ })).toBeInTheDocument();
    expect(within(chips).getByRole('button', { name: /In Review\s*4/ })).toBeInTheDocument();
    expect(within(chips).getByRole('button', { name: /Pending User\s*99/ })).toBeInTheDocument();
    // needs_follow_up is absent from by_state → rendered as 0, not hidden.
    expect(within(chips).getByRole('button', { name: /Follow-up\s*0/ })).toBeInTheDocument();
    // Terminal states are Closed-only, never chips under Active.
    expect(within(chips).queryByRole('button', { name: /Cleared/ })).not.toBeInTheDocument();
    expect(within(chips).queryByRole('button', { name: /Denied/ })).not.toBeInTheDocument();
  });

  it('narrows the list to one exact state when a chip is picked', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(lastListState()).toBe('active'));

    const chips = await screen.findByRole('group', { name: /Filter by case status/ });
    await user.click(within(chips).getByRole('button', { name: /In Review/ }));

    // The exact state overrides the view — not 'active', not both.
    await waitFor(() => expect(lastListState()).toBe('under_moderator_review'));
  });

  it('swaps the chip set and clears the drill-down when the tab changes', async () => {
    const user = userEvent.setup();
    renderPage();
    const chips = await screen.findByRole('group', { name: /Filter by case status/ });
    await user.click(within(chips).getByRole('button', { name: /In Review/ }));
    await waitFor(() => expect(lastListState()).toBe('under_moderator_review'));

    // Closed shows only terminal chips, and the query drops the old In Review
    // state for the plain 'closed' view (the chip did not carry over).
    await user.click(screen.getByRole('tab', { name: 'Closed' }));
    await waitFor(() => expect(lastListState()).toBe('closed'));
    const closedChips = await screen.findByRole('group', { name: /Filter by case status/ });
    expect(within(closedChips).getByRole('button', { name: /Cleared\s*135/ })).toBeInTheDocument();
    expect(within(closedChips).getByRole('button', { name: /Denied\s*74/ })).toBeInTheDocument();
    expect(within(closedChips).queryByRole('button', { name: /In Review/ })).not.toBeInTheDocument();
  });

  it('sends no state param on the All tab until a chip narrows it', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('tab', { name: 'All' }));
    await waitFor(() => expect(lastListState()).toBeUndefined());

    const chips = await screen.findByRole('group', { name: /Filter by case status/ });
    await user.click(within(chips).getByRole('button', { name: /Cleared/ }));
    await waitFor(() => expect(lastListState()).toBe('cleared'));
  });
});
