// ABOUTME: Adversarial repro — re-entering the ?pubkey= hand-off after a
// ABOUTME: terminal action, while ['age-review-active-case', pubkey] is still cached.

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

describe('re-entering the hand-off after a terminal action (adversarial)', () => {
  it('does not resurrect stale ACTIVE controls from the cached active-case lookup', async () => {
    const activeCase = makeCase();
    const terminalCase = makeCase({ state: 'cleared', version: 1 });

    // First hand-off entry resolves via the direct lookup (fresh case, empty lists)
    getActiveAgeReviewCase.mockResolvedValue({ success: true, case: activeCase });
    getAgeReviewCase.mockResolvedValue({ success: true, case: activeCase });
    updateAgeReviewCase.mockResolvedValue({
      success: true,
      case: terminalCase,
      enforcementComplete: true,
      enforcement: { relay: 'ok', bulk: 'ok', keycast: 'ok', keycastMinorClear: 'not_attempted' },
    });

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    // --- Visit 1: hand-off -> Clear (terminal) ---
    const first = render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[`/age-review?pubkey=${PUBKEY}`]}>
          <AgeReview />
        </MemoryRouter>
      </QueryClientProvider>
    );
    const clearButton = await first.findByRole('button', { name: 'Clear' });
    fireEvent.click(clearButton);
    await waitFor(() => expect(updateAgeReviewCase).toHaveBeenCalledTimes(1));
    expect(await first.findByText('Cleared')).toBeInTheDocument();

    // Moderator navigates away (back to the report) — page unmounts, cache lives on
    first.unmount();

    // From here on, the SERVER knows the truth: no active case, per-case row terminal
    getActiveAgeReviewCase.mockResolvedValue({ success: true, case: null });
    getAgeReviewCase.mockResolvedValue({ success: true, case: terminalCase });

    // --- Visit 2: same hand-off link clicked again within the 30s staleTime ---
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[`/age-review?pubkey=${PUBKEY}`]}>
          <AgeReview />
        </MemoryRouter>
      </QueryClientProvider>
    );

    // The truth is terminal: the moderator must see Cleared (or the honest
    // no-active-case empty state) — never actionable ACTIVE controls.
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Clear' })).not.toBeInTheDocument();
    }, { timeout: 3000 });
    expect(
      screen.queryByText('Cleared') ??
      screen.queryByText(/No active age-review case/)
    ).toBeTruthy();
  });
});
