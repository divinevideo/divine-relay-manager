// ABOUTME: Adversarial probe — moderator switches selected case while a mutation
// ABOUTME: is in flight: do the onSuccess cache writes land under the WRONG case's keys?

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

describe('mid-flight case switch (adversarial)', () => {
  it('onSuccess cache writes land under the mutated case, not the newly selected one', async () => {
    const caseA = makeCase();
    const caseB = makeCase({ id: 'case-b', pubkey: PUBKEY_B });
    const terminalA = makeCase({ state: 'cleared', version: 1 });

    getAgeReviewCases.mockResolvedValue({ success: true, cases: [caseA, caseB] });
    getAgeReviewCase.mockImplementation((id: string) =>
      Promise.resolve({ success: true, case: id === 'case-a' ? caseA : caseB }));

    // Slow PATCH: resolves 300ms after the moderator has already switched to case B
    let resolvePatch: (v: unknown) => void;
    updateAgeReviewCase.mockImplementation(() => new Promise(r => { resolvePatch = r; }));

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/age-review?case=case-a']}>
          <AgeReview />
        </MemoryRouter>
      </QueryClientProvider>
    );

    // Case A's detail is open with active controls
    const clearButton = await screen.findByRole('button', { name: 'Clear' });
    fireEvent.click(clearButton);
    await waitFor(() => expect(updateAgeReviewCase).toHaveBeenCalledTimes(1));
    expect(updateAgeReviewCase.mock.calls[0][0]).toBe('case-a');

    // Mid-flight: moderator clicks case B in the list
    fireEvent.click(screen.getByText('user-bb'));
    await screen.findAllByText('user-bb'); // B selected/rendered

    // PATCH for A resolves now
    resolvePatch!({
      success: true,
      case: terminalA,
      enforcementComplete: true,
      enforcement: { relay: 'ok', bulk: 'ok', keycast: 'ok', keycastMinorClear: 'not_attempted' },
    });

    await waitFor(() => {
      // The write-through must land under the MUTATED case's keys...
      expect(client.getQueryData(['age-review-case', 'case-a'])).toEqual({ success: true, case: terminalA });
    });
    expect(client.getQueryData(['age-review-active-case', PUBKEY_A])).toEqual({ success: true, case: null });
    // ...and must NOT poison the newly selected case's keys
    const caseBEntry = client.getQueryData<{ case: AgeReviewCase }>(['age-review-case', 'case-b']);
    expect(caseBEntry === undefined || caseBEntry?.case?.id === 'case-b').toBe(true);
    const lookupB = client.getQueryData<{ case: AgeReviewCase | null }>(['age-review-active-case', PUBKEY_B]);
    expect(lookupB === undefined || lookupB?.case?.id === 'case-b').toBe(true);
  });
});
