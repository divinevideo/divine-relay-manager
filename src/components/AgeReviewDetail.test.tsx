import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { AgeReviewDetail } from './AgeReviewDetail';
import type { AgeReviewCase, AgeBand, AgeReviewState } from '../../shared/age-review';

const updateAgeReviewCase = vi.fn().mockResolvedValue({ success: true });
const getAgeReviewConfig = vi.fn().mockResolvedValue({ auto_delete_on_deny: false });
const writeText = vi.fn().mockResolvedValue(undefined);

vi.mock('@/hooks/useAdminApi', () => ({
  useAdminApi: () => ({
    updateAgeReviewCase,
    getAgeReviewConfig,
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
    created_via: null,
    claim_link_url: null,
    claim_link_expires_at: null,
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
    getAgeReviewConfig.mockClear();
    getAgeReviewConfig.mockResolvedValue({ auto_delete_on_deny: false });
    writeText.mockClear();
    Object.assign(navigator, {
      clipboard: {
        writeText,
      },
    });
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

  it('shows Deny & Close without confirmation when auto-delete is off', () => {
    renderDetail(makeCase());
    expect(screen.getByRole('button', { name: /Deny.*Close/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Deny.*Delete/ })).not.toBeInTheDocument();
  });

  it('shows Deny & Delete with confirmation when auto-delete is on', async () => {
    getAgeReviewConfig.mockResolvedValue({ auto_delete_on_deny: true });
    renderDetail(makeCase());
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Deny.*Delete/ })).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /Deny.*Close/ })).not.toBeInTheDocument();
  });

  it('copies the raw hex pubkey from the moderator control', async () => {
    const caseData = makeCase();
    renderDetail(caseData);

    fireEvent.click(screen.getByRole('button', { name: /Hex pubkey:/ }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(caseData.pubkey);
    });
  });

  it('renders the claim link and expiry for a minor_onboarding case', () => {
    renderDetail(makeCase({
      state: 'cleared',
      created_via: 'minor_onboarding',
      resolution_note: 'Approved via parental consent (minor onboarding)',
      claim_link_url: 'https://login.test/claim/xyz',
      claim_link_expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    }));

    expect(screen.getByText('Claim Link')).toBeInTheDocument();
    expect(screen.getByText(/Expires:/)).toBeInTheDocument();
    expect(screen.queryByText('Expired')).not.toBeInTheDocument();
  });

  it('shows an Expired badge when the claim link expiry is in the past', () => {
    renderDetail(makeCase({
      state: 'cleared',
      created_via: 'minor_onboarding',
      resolution_note: 'Approved via parental consent (minor onboarding)',
      claim_link_url: 'https://login.test/claim/xyz',
      claim_link_expires_at: new Date(Date.now() - 1000).toISOString(),
    }));

    expect(screen.getByText('Expired')).toBeInTheDocument();
  });

  it('shows N/A expiry and no Expired badge when claim link has no expiry', () => {
    renderDetail(makeCase({
      state: 'cleared',
      created_via: 'minor_onboarding',
      resolution_note: 'Approved via parental consent (minor onboarding)',
      claim_link_url: 'https://login.test/claim/xyz',
      claim_link_expires_at: null,
    }));

    expect(screen.getByText('Claim Link')).toBeInTheDocument();
    expect(screen.getByText(/Expires: N\/A/)).toBeInTheDocument();
    expect(screen.queryByText('Expired')).not.toBeInTheDocument();
  });
});
