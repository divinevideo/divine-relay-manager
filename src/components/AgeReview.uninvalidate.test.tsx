// ABOUTME: Adversarial repro — the reconciler's setQueryData runs AFTER the list
// ABOUTME: invalidation, un-invalidating and fresh-stamping UNOBSERVED list caches.

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

vi.mock('@/hooks/useUserStats', () => ({
  useUserStats: () => ({ data: undefined }),
}));

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
  UserIdentifier: ({ pubkey }: { pubkey: string }) => <span>{`user-${pubkey.slice(0, 2)}`}</span>,
}));
vi.mock('@/components/UserActions', () => ({ UserActions: () => null }));
vi.mock('@/components/DeleteConfirmDialog', () => ({ DeleteConfirmDialog: () => null }));

const PUBKEY_A = 'a'.repeat(64);
const PUBKEY_B = 'b'.repeat(64);

function makeCase(overrides: Partial<AgeReviewCase> = {}): AgeReviewCase {
  return {
    id: 'case-a',
    pubkey: PUBKEY_A,
    reporter_pubkey: 'c'.repeat(64),
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
  getAgeReviewConfig.mockResolvedValue({ auto_delete_on_deny: false });
  getAccountStatus.mockResolvedValue({ success: true, verified_minor: false });
  getActiveAgeReviewCase.mockResolvedValue({ success: true, case: null });
});

describe('reconcile-after-invalidate un-invalidates unobserved list caches (adversarial)', () => {
  it('a mutation must not suppress the refetch of a stale unobserved filter cache', async () => {
    const caseA = makeCase();
    const terminalA = makeCase({ state: 'cleared', version: 1 });
    // Case B: DENIED 2 minutes ago per the cached closed list, since REOPENED
    // server-side (cross-actor) — the closed list's refetch is what corrects it
    const staleClosedB = makeCase({ id: 'case-b', pubkey: PUBKEY_B, state: 'denied_closed', version: 3 });

    getAgeReviewCases.mockImplementation((params?: { state?: string }) => {
      const cleared = updateAgeReviewCase.mock.calls.length > 0; // server truth after the PATCH
      if (params?.state === 'closed') {
        // server truth: B is no longer closed; after the PATCH, A (just cleared) is
        return Promise.resolve({ success: true, cases: cleared ? [terminalA] : [] });
      }
      return Promise.resolve({ success: true, cases: cleared ? [] : [caseA] });
    });
    getAgeReviewCase.mockResolvedValue({ success: true, case: caseA });
    updateAgeReviewCase.mockResolvedValue({
      success: true,
      case: terminalA,
      enforcementComplete: true,
      enforcement: { relay: 'ok', bulk: 'ok', keycast: 'ok', keycastMinorClear: 'not_attempted' },
    });

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // The moderator viewed the Closed tab 2 minutes ago; entry is cached,
    // currently unobserved, and 2 minutes stale
    client.setQueryData(
      ['age-review-cases', { state: 'closed' }],
      { success: true, cases: [staleClosedB] },
      { updatedAt: Date.now() - 120_000 },
    );

    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/age-review?case=case-a']}>
          <AgeReview />
        </MemoryRouter>
      </QueryClientProvider>
    );

    // Clear case A (any successful mutation runs invalidate + reconcile)
    fireEvent.click(await screen.findByRole('button', { name: 'Clear' }));
    await waitFor(() => expect(updateAgeReviewCase).toHaveBeenCalledTimes(1));
    await screen.findByText('Cleared');

    // Within 30s the moderator switches to the Closed tab. The invalidation
    // promised a refetch; the closed list must show server truth (B gone,
    // A present), not the 2-minute-old row.
    const closedCallsBefore = getAgeReviewCases.mock.calls.filter(c => c[0]?.state === 'closed').length;
    const closedTab = screen.getByRole('tab', { name: 'Closed' });
    fireEvent.mouseDown(closedTab);
    fireEvent.click(closedTab);
    await waitFor(() => expect(closedTab.getAttribute('aria-selected')).toBe('true'));

    await waitFor(() => {
      const closedCallsAfter = getAgeReviewCases.mock.calls.filter(c => c[0]?.state === 'closed').length;
      expect(closedCallsAfter).toBeGreaterThan(closedCallsBefore); // refetch actually fired
    });
    await waitFor(() => {
      expect(screen.queryByText('user-bb')).not.toBeInTheDocument(); // stale reopened case gone
    });
  });
});
