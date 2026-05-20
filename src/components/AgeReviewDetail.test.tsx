import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { AgeReviewDetail } from './AgeReviewDetail';
import type { AgeReviewCase, AgeBand, AgeReviewState } from '../../shared/age-review';

const updateAgeReviewCase = vi.fn().mockResolvedValue({ success: true });

vi.mock('@/hooks/useAdminApi', () => ({
  useAdminApi: () => ({
    updateAgeReviewCase,
  }),
}));

vi.mock('@/hooks/useAuthor', () => ({
  useAuthor: () => ({ data: undefined, isLoading: false }),
}));

function makeCase(overrides: Partial<AgeReviewCase> = {}): AgeReviewCase {
  return {
    id: 'case-1',
    pubkey: 'a'.repeat(64),
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
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function renderDetail(caseData: AgeReviewCase) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <AgeReviewDetail caseData={caseData} />
    </QueryClientProvider>
  );
}

describe('AgeReviewDetail', () => {
  beforeEach(() => {
    updateAgeReviewCase.mockClear();
  });

  it.each<[AgeBand, AgeReviewState]>([
    ['under_13', 'restricted_pending_support_email'],
    ['age_13_15', 'restricted_pending_user_response'],
    ['age_16_plus_claimed', 'restricted_pending_support_email'],
  ])('maps %s to %s when restricting an account', async (suspectedAgeBand, expectedState) => {
    renderDetail(makeCase({ suspected_age_band: suspectedAgeBand }));

    fireEvent.click(screen.getByRole('button', { name: 'Restrict Account' }));

    await waitFor(() => {
      expect(updateAgeReviewCase).toHaveBeenCalledWith('case-1', { state: expectedState });
    });
  });
});
