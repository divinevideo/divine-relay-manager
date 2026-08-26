// ABOUTME: Tests the age-review queue's per-state drill-down chips: they narrow
// ABOUTME: Active/Closed/All to one state and reset when the tab changes.

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

// Radix Select scrolls the active option into view on open; jsdom has no layout.
beforeEach(() => { window.HTMLElement.prototype.scrollIntoView = vi.fn(); });

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
    // The chip row renders unconditionally, so finding the group is NOT a
    // barrier for the counts query behind the numbers. Await the first count;
    // asserting it synchronously here raced the query and went red on CI.
    expect(await within(chips).findByRole('button', { name: /In Review\s*4/ })).toBeInTheDocument();
    expect(within(chips).getByRole('button', { name: /^All/ })).toBeInTheDocument();
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
    // Same barrier as above: the group is present before the counts land.
    expect(await within(closedChips).findByRole('button', { name: /Cleared\s*135/ })).toBeInTheDocument();
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

  it('toggles a chip off when clicked again, back to the whole view', async () => {
    // Asserts pressed-state, not the API call: toggling back to 'active' is
    // served from the still-fresh cache, so no new fetch is observable — but the
    // drill-down clearing is the behavior under test, and it drives serverParams.
    const user = userEvent.setup();
    renderPage();
    const chips = await screen.findByRole('group', { name: /Filter by case status/ });
    const inReview = within(chips).getByRole('button', { name: /In Review/ });
    const allChip = within(chips).getByRole('button', { name: /^All/ });

    await user.click(inReview);
    await waitFor(() => expect(lastListState()).toBe('under_moderator_review'));
    expect(inReview).toHaveAttribute('aria-pressed', 'true');
    expect(allChip).toHaveAttribute('aria-pressed', 'false');

    await user.click(inReview);
    await waitFor(() => expect(inReview).toHaveAttribute('aria-pressed', 'false'));
    expect(allChip).toHaveAttribute('aria-pressed', 'true');
  });

  it('scopes the chip counts to the selected age band, not just the list', async () => {
    renderPage();
    // 'all' band → no age_band param on the counts query.
    await waitFor(() => expect(getAgeReviewCaseCounts).toHaveBeenCalledWith(undefined));

    fireEvent.click(screen.getByRole('combobox'));
    fireEvent.click(await screen.findByRole('option', { name: 'Under 13' }));

    // The band must reach the counts query, or the chips would show whole-table
    // numbers beside a band-filtered list.
    await waitFor(() => expect(getAgeReviewCaseCounts).toHaveBeenCalledWith({ age_band: 'under_13' }));
    await waitFor(() =>
      expect(getAgeReviewCases.mock.calls.some(
        (c) => (c[0] as { age_band?: string } | undefined)?.age_band === 'under_13',
      )).toBe(true));
  });

  it('names the drilled-in state in the empty message', async () => {
    const user = userEvent.setup();
    renderPage(); // getAgeReviewCases resolves an empty list by default
    expect(await screen.findByText('No active cases')).toBeInTheDocument();

    const chips = await screen.findByRole('group', { name: /Filter by case status/ });
    await user.click(within(chips).getByRole('button', { name: /In Review/ }));
    expect(await screen.findByText(/No .*In Review.* cases/)).toBeInTheDocument();
  });
});
