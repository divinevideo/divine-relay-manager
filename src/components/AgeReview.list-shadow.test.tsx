// ABOUTME: Regression tests for the list-cache shadow (#179 review round 2):
// ABOUTME: a retained active-list row must never out-vote the mutation result

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { AgeReviewCase } from '../../shared/age-review';
import { AgeReview } from './AgeReview';

const getAgeReviewCases = vi.fn();
const getActiveAgeReviewCase = vi.fn();
const getAgeReviewCase = vi.fn();
const updateAgeReviewCase = vi.fn();
const getAgeReviewConfig = vi.fn();
const getAccountStatus = vi.fn();

vi.mock('@/hooks/useAdminApi', () => ({
  useApiUrl: () => 'https://api.test.divine.video',
  useAdminApi: () => ({
    getAgeReviewCases,
    getActiveAgeReviewCase,
    getAgeReviewCase,
    updateAgeReviewCase,
    getAgeReviewConfig,
    getAccountStatus,
  }),
}));

vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('@/hooks/useToast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ user: { pubkey: 'f'.repeat(64) } }),
}));
vi.mock('@/hooks/useAuthor', () => ({
  useAuthor: () => ({ data: undefined, isLoading: false }),
}));
vi.mock('@/components/AgeReviewFunnel', () => ({ AgeReviewFunnel: () => null }));
vi.mock('@/components/CreateMinorAccountDialog', () => ({ CreateMinorAccountDialog: () => null }));
vi.mock('@/components/UserIdentifier', () => ({
  UserIdentifier: ({ pubkey }: { pubkey: string }) => <span>{pubkey.slice(0, 8)}</span>,
}));
vi.mock('@/components/UserActions', () => ({ UserActions: () => null }));
vi.mock('@/components/DeleteConfirmDialog', () => ({ DeleteConfirmDialog: () => null }));

const PUBKEY = 'a'.repeat(64);

function makeCase(overrides: Partial<AgeReviewCase> = {}): AgeReviewCase {
  return {
    id: 'case-1',
    pubkey: PUBKEY,
    reporter_pubkey: 'b'.repeat(64),
    report_id: 'report-1',
    suspected_age_band: 'age_13_15',
    state: 'under_moderator_review',
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

const activeCase = () => makeCase();
const terminalCase = () => makeCase({ state: 'cleared', version: 1 });

function renderPage(client: QueryClient, entry = `/age-review?pubkey=${PUBKEY}`) {
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <AgeReview />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  getAgeReviewConfig.mockResolvedValue({ auto_delete_on_deny: false });
  getAccountStatus.mockResolvedValue({ success: true, verified_minor: false });
  getAgeReviewCase.mockResolvedValue({ success: true, case: activeCase() });
  getActiveAgeReviewCase.mockResolvedValue({ success: true, case: activeCase() });
  updateAgeReviewCase.mockResolvedValue({
    success: true,
    case: terminalCase(),
    enforcementComplete: true,
    enforcement: { relay: 'ok', bulk: 'ok', keycast: 'ok', keycastMinorClear: 'not_attempted' },
  });
});

describe('active-list rows must not shadow the mutation result (#179 review round 2)', () => {
  it('terminal action with a NONEMPTY active list and a refetch that never lands', async () => {
    // The single deduped initial fetch serves the active case IN the list;
    // every later fetch (the post-mutation refetch) hangs — the reconciled
    // cache must carry the truth
    let fetches = 0;
    getAgeReviewCases.mockImplementation(() => {
      fetches += 1;
      if (fetches <= 1) return Promise.resolve({ success: true, cases: [activeCase()] });
      return new Promise(() => {}); // delayed refetch: never resolves
    });

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderPage(client);

    fireEvent.click(await screen.findByRole('button', { name: 'Clear' }));
    await waitFor(() => expect(updateAgeReviewCase).toHaveBeenCalledTimes(1));

    expect(await screen.findByText('Cleared')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Clear' })).not.toBeInTheDocument();
    });
  });

  it('terminal action with a NONEMPTY active list and a refetch that fails', async () => {
    let fetches = 0;
    getAgeReviewCases.mockImplementation(() => {
      fetches += 1;
      if (fetches <= 1) return Promise.resolve({ success: true, cases: [activeCase()] });
      return Promise.reject(new Error('refetch failed'));
    });

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderPage(client);

    fireEvent.click(await screen.findByRole('button', { name: 'Clear' }));
    await waitFor(() => expect(updateAgeReviewCase).toHaveBeenCalledTimes(1));

    expect(await screen.findByText('Cleared')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Clear' })).not.toBeInTheDocument();
    });
  });

  it('remounting the same ?pubkey= hand-off after the terminal action shows no active controls', async () => {
    let fetches = 0;
    getAgeReviewCases.mockImplementation(() => {
      fetches += 1;
      if (fetches <= 1) return Promise.resolve({ success: true, cases: [activeCase()] });
      return new Promise(() => {}); // keep the stale list cached, refetch pending
    });

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const first = renderPage(client);

    fireEvent.click(await screen.findByRole('button', { name: 'Clear' }));
    await waitFor(() => expect(updateAgeReviewCase).toHaveBeenCalledTimes(1));
    await screen.findByText('Cleared');
    first.unmount();

    // Same QueryClient (same tab), fresh mount of the hand-off route
    renderPage(client);

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Clear' })).not.toBeInTheDocument();
    });
    expect(screen.queryByText('Under Moderator Review')).not.toBeInTheDocument();
  });
});
