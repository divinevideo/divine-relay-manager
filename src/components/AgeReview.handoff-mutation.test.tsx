// ABOUTME: Integration test for the hand-off seeded cache across mutations —
// ABOUTME: a terminal action must never leave stale active controls (#179 review)

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

// Heavy siblings not under test — the REAL AgeReviewDetail renders here
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

beforeEach(() => {
  vi.clearAllMocks();
  getAgeReviewCases.mockResolvedValue({ success: true, cases: [] });
  getAgeReviewConfig.mockResolvedValue({ auto_delete_on_deny: false });
  getAccountStatus.mockResolvedValue({ success: true, verified_minor: false });
});

describe('hand-off seeded cache across terminal mutations (#179 review)', () => {
  it('a terminal action within the seed staleTime shows the terminal state, not stale active controls', async () => {
    const activeCase = makeCase();
    const terminalCase = makeCase({ state: 'cleared', version: 1 });

    // Hand-off resolves via the direct lookup (fresh case, not in any list)
    getActiveAgeReviewCase.mockResolvedValue({ success: true, case: activeCase });
    // If anything falls back to a by-id fetch, it serves the STALE active row
    // (worst case) — the fix must not depend on this fetch happening
    getAgeReviewCase.mockResolvedValue({ success: true, case: activeCase });
    updateAgeReviewCase.mockResolvedValue({
      success: true,
      case: terminalCase,
      enforcementComplete: true,
      enforcement: { relay: 'ok', bulk: 'ok', keycast: 'ok', keycastMinorClear: 'not_attempted' },
    });

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[`/age-review?pubkey=${PUBKEY}`]}>
          <AgeReview />
        </MemoryRouter>
      </QueryClientProvider>
    );

    // Hand-off opened the real detail with active controls
    const clearButton = await screen.findByRole('button', { name: 'Clear' });
    fireEvent.click(clearButton);

    await waitFor(() => expect(updateAgeReviewCase).toHaveBeenCalledTimes(1));

    // The mutation returned the terminal row: the detail must show it — no
    // stale active controls, no second action possible
    expect(await screen.findByText('Cleared')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Clear' })).not.toBeInTheDocument();
    });
  });
});
