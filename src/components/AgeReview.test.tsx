// ABOUTME: Tests the AgeReview page's report hand-off states (#152/#179):
// ABOUTME: ?pubkey= resolution must never show the generic prompt mid-hand-off

import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { AgeReviewCase } from '../../shared/age-review';
import { AgeReview } from './AgeReview';

const getAgeReviewCases = vi.fn();
const getActiveAgeReviewCase = vi.fn();
const getAgeReviewCase = vi.fn();

vi.mock('@/hooks/useAdminApi', () => ({
  useApiUrl: () => 'https://api.test.divine.video',
  useAdminApi: () => ({
    getAgeReviewCases,
    getActiveAgeReviewCase,
    getAgeReviewCase,
  }),
}));

vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => false }));

// Heavy children irrelevant to hand-off sequencing
vi.mock('@/components/AgeReviewDetail', () => ({
  AgeReviewDetail: ({ caseData }: { caseData: AgeReviewCase }) => (
    <div data-testid="case-detail">case:{caseData.id}</div>
  ),
}));
vi.mock('@/components/AgeReviewFunnel', () => ({ AgeReviewFunnel: () => null }));
vi.mock('@/components/CreateMinorAccountDialog', () => ({ CreateMinorAccountDialog: () => null }));
vi.mock('@/components/UserIdentifier', () => ({
  UserIdentifier: ({ pubkey }: { pubkey: string }) => <span>{pubkey.slice(0, 8)}</span>,
}));

const PUBKEY = 'a'.repeat(64);

function makeCase(overrides: Partial<AgeReviewCase> = {}): AgeReviewCase {
  return {
    id: 'case-1',
    pubkey: PUBKEY,
    reporter_pubkey: 'b'.repeat(64),
    report_id: 'report-1',
    suspected_age_band: 'age_13_15',
    state: 'open_reported',
    allowed_resolution: 'parent_video_or_email',
    parent_contact_email: null,
    deadline_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    clock_paused: 0,
    clock_paused_at: null,
    remaining_days_when_paused: null,
    moderator_pubkey: null,
    resolution_note: null,
    last_alerted_at: null,
    zendesk_ticket_id: null,
    created_via: 'report',
    claim_link_url: null,
    claim_link_expires_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    version: 0,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function renderPage(initialEntry: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <AgeReview />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  getAgeReviewCases.mockReset();
  getActiveAgeReviewCase.mockReset();
  getAgeReviewCase.mockReset();
  // Case lists resolve empty by default (fresh case not yet in the 30s cache)
  getAgeReviewCases.mockResolvedValue({ success: true, cases: [] });
  getAgeReviewCase.mockResolvedValue({ success: true, case: null });
});

describe('AgeReview report hand-off (?pubkey=)', () => {
  it('shows the resolving state while the lookup is in flight, never the generic prompt', async () => {
    const lookup = deferred<{ success: boolean; case: AgeReviewCase }>();
    getActiveAgeReviewCase.mockReturnValue(lookup.promise);

    renderPage(`/age-review?pubkey=${PUBKEY}`);

    expect(await screen.findByText(/Opening this account's age-review case/)).toBeInTheDocument();
    expect(screen.queryByText('Select a case to view details')).not.toBeInTheDocument();

    lookup.resolve({ success: true, case: makeCase() });

    // The lookup already returned the full case: the detail must render from
    // it directly, with no second fetch and no generic-prompt interlude
    expect(await screen.findByTestId('case-detail')).toHaveTextContent('case:case-1');
    expect(screen.queryByText('Select a case to view details')).not.toBeInTheDocument();
    expect(getAgeReviewCase).not.toHaveBeenCalled();
  });

  it('shows the explicit no-active-case message when the lookup settles empty', async () => {
    getActiveAgeReviewCase.mockResolvedValue({ success: true, case: null });

    renderPage(`/age-review?pubkey=${PUBKEY}`);

    expect(await screen.findByText(/No active age-review case for this account/)).toBeInTheDocument();
    expect(screen.queryByText('Select a case to view details')).not.toBeInTheDocument();
  });

  it('shows an honest error state when the lookup fails, not the no-case message', async () => {
    getActiveAgeReviewCase.mockRejectedValue(new Error('server exploded'));

    renderPage(`/age-review?pubkey=${PUBKEY}`);

    expect(await screen.findByText(/Couldn't look up this account's case/)).toBeInTheDocument();
    expect(screen.queryByText(/No active age-review case/)).not.toBeInTheDocument();
  });

  it('shows the generic prompt only when no hand-off is in play', async () => {
    renderPage('/age-review');

    expect(await screen.findByText('Select a case to view details')).toBeInTheDocument();
    expect(getActiveAgeReviewCase).not.toHaveBeenCalled();
  });
});
