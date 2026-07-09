import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { AgeReviewDetail } from './AgeReviewDetail';
import { ApiError } from '@/lib/adminApi';
import type { AgeReviewCase, AgeBand, AgeReviewState } from '../../shared/age-review';

const updateAgeReviewCase = vi.fn().mockResolvedValue({ success: true });
const getAgeReviewConfig = vi.fn().mockResolvedValue({ auto_delete_on_deny: false });
const getAccountStatus = vi
  .fn()
  .mockResolvedValue({ success: true, verified_minor: false });
const writeText = vi.fn().mockResolvedValue(undefined);
const toast = vi.fn();

vi.mock('@/hooks/useAdminApi', () => ({
  useApiUrl: () => 'https://api.test.divine.video',
  useAdminApi: () => ({
    updateAgeReviewCase,
    getAgeReviewConfig,
    getAccountStatus,
  }),
}));

vi.mock('@/hooks/useToast', () => ({
  useToast: () => ({ toast }),
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
    version: 0,
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

  const result = render(
    <QueryClientProvider client={queryClient}>
      <AgeReviewDetail caseData={caseData} />
    </QueryClientProvider>
  );
  // Expose the client so absence tests can await query settlement instead of
  // asserting against a possibly still-loading tree (vacuous pass).
  return { ...result, queryClient };
}

describe('AgeReviewDetail', () => {
  beforeEach(() => {
    updateAgeReviewCase.mockClear();
    updateAgeReviewCase.mockResolvedValue({ success: true });
    getAgeReviewConfig.mockClear();
    getAgeReviewConfig.mockResolvedValue({ auto_delete_on_deny: false });
    getAccountStatus.mockClear();
    getAccountStatus.mockResolvedValue({ success: true, verified_minor: false });
    toast.mockClear();
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
      expect(updateAgeReviewCase).toHaveBeenCalledWith('case-1', { state: expectedState, expected_version: 0 });
    });
  });

  it('toasts when relay or bulk enforcement fails even if Keycast succeeds', async () => {
    updateAgeReviewCase.mockResolvedValue({
      success: false,
      keycastUpdated: true,
      enforcementComplete: false,
      enforcement: {
        relay: 'failed',
        bulk: 'failed',
        keycast: 'ok',
      },
    });
    renderDetail(makeCase({ version: 3 }));

    fireEvent.click(screen.getByRole('button', { name: 'Restrict Account' }));

    await waitFor(() => {
      expect(updateAgeReviewCase).toHaveBeenCalledWith('case-1', {
        state: 'restricted_pending_user_response',
        expected_version: 3,
      });
      expect(toast).toHaveBeenCalledWith(expect.objectContaining({
        title: 'Enforcement incomplete',
        variant: 'destructive',
      }));
    });
  });

  it('toasts when an enforcement leg fails (HTTP 207 partial)', async () => {
    updateAgeReviewCase.mockResolvedValueOnce({
      success: false,
      case: makeCase({ state: 'restricted_pending_user_response' }),
      enforcementComplete: false,
      enforcement: { relay: 'failed', bulk: 'ok', keycast: 'ok' },
    });
    renderDetail(makeCase({ suspected_age_band: 'age_13_15' }));

    fireEvent.click(screen.getByRole('button', { name: 'Restrict Account' }));

    await waitFor(() => {
      expect(toast).toHaveBeenCalledWith(expect.objectContaining({
        title: 'Enforcement incomplete',
        variant: 'destructive',
      }));
    });
    expect(toast.mock.calls[0][0].description).toMatch(/relay/);
  });

  it('does not toast when no enforcement leg failed (ok and not_attempted)', async () => {
    updateAgeReviewCase.mockResolvedValueOnce({
      success: true,
      case: makeCase({ state: 'restricted_pending_user_response' }),
      enforcementComplete: true,
      // not_attempted must NOT be treated as a failure (the old keycastUpdated
      // check false-fired on restricted->restricted transitions).
      enforcement: { relay: 'ok', bulk: 'ok', keycast: 'not_attempted' },
    });
    renderDetail(makeCase({ suspected_age_band: 'age_13_15' }));

    fireEvent.click(screen.getByRole('button', { name: 'Restrict Account' }));

    await waitFor(() => expect(updateAgeReviewCase).toHaveBeenCalled());
    expect(toast).not.toHaveBeenCalled();
  });

  it('toasts a reload notice on a 409 version_conflict', async () => {
    updateAgeReviewCase.mockRejectedValueOnce(
      new ApiError('Case was modified by another request', 409, 'Conflict', 'version_conflict', 5),
    );
    renderDetail(makeCase({ suspected_age_band: 'age_13_15' }));

    fireEvent.click(screen.getByRole('button', { name: 'Restrict Account' }));

    await waitFor(() => {
      expect(toast).toHaveBeenCalledWith(expect.objectContaining({
        title: 'Case changed since you opened it',
        variant: 'destructive',
      }));
    });
    // the toast covers the conflict; the inline error must not also fire for it
    expect(screen.queryByText(/Failed to update/)).not.toBeInTheDocument();
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

  it('does not render the claim link for a non-minor-onboarding terminal case', () => {
    renderDetail(makeCase({
      state: 'cleared',
      created_via: 'report',
      resolution_note: 'Cleared after review',
      claim_link_url: 'https://login.test/claim/xyz',
    }));

    expect(screen.queryByText('Claim Link')).not.toBeInTheDocument();
  });

  it('does not render the claim link for a minor_onboarding case missing the link', () => {
    renderDetail(makeCase({
      state: 'cleared',
      created_via: 'minor_onboarding',
      resolution_note: 'Approved via parental consent (minor onboarding)',
      claim_link_url: null,
    }));

    expect(screen.queryByText('Claim Link')).not.toBeInTheDocument();
  });

  it('shows the approved-protected-minor badge when verified_minor is true', async () => {
    getAccountStatus.mockResolvedValue({
      success: true,
      verified_minor: true,
      verified_minor_at: '2026-06-30T12:00:00Z',
    });

    renderDetail(makeCase());

    expect(
      await screen.findByText(/approved protected minor/i)
    ).toBeInTheDocument();
    // The approved date renders (UTC), distinct from the badge label.
    expect(screen.getByText(/approved \d/i)).toHaveTextContent('2026');
  });

  it('renders the badge but omits the date when verified_minor_at is malformed', async () => {
    getAccountStatus.mockResolvedValue({
      success: true,
      verified_minor: true,
      verified_minor_at: 'not-a-date',
    });

    renderDetail(makeCase());

    expect(
      await screen.findByText(/approved protected minor/i)
    ).toBeInTheDocument();
    expect(screen.queryByText(/approved \d/i)).not.toBeInTheDocument();
  });

  it('does not show the protected-minor badge when verified_minor is false', async () => {
    getAccountStatus.mockResolvedValue({ success: true, verified_minor: false });

    const { queryClient } = renderDetail(makeCase());

    // Wait for query settlement, not just the fetch call — asserting against a
    // still-loading tree would pass even if the gating were broken.
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    expect(
      screen.queryByText(/approved protected minor/i)
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/status unavailable/i)
    ).not.toBeInTheDocument();
  });

  it('shows status-unavailable when the account status could not be loaded', async () => {
    getAccountStatus.mockResolvedValue({ success: false });

    renderDetail(makeCase());

    expect(
      await screen.findByText(/protected-minor status unavailable/i)
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/approved protected minor/i)
    ).not.toBeInTheDocument();
  });

  it('lists only shipped protections under "apply to this account" (adult lock, not the DM restriction)', async () => {
    getAccountStatus.mockResolvedValue({
      success: true,
      verified_minor: true,
      verified_minor_at: '2026-06-30T12:00:00Z',
    });

    renderDetail(makeCase());

    // Content lock (#175, shipped): forced-hidden adult content + disabled
    // 18+ toggle — inside the applied-protections section.
    const appliedHeading = await screen.findByText(/protections that apply to this account/i);
    const appliedSection = appliedHeading.closest('div') as HTMLElement;
    expect(within(appliedSection).getByText(/adult content is hidden/i)).toBeInTheDocument();
    expect(within(appliedSection).getByText(/18\+ visibility toggle is disabled/i)).toBeInTheDocument();
    // The DM restriction (#176) is not enforced by any released client yet,
    // so it must NOT sit under the applied-protections heading.
    expect(within(appliedSection).queryByText(/DM restriction/i)).not.toBeInTheDocument();
  });

  it('shows the DM restriction in a separate rolling-out section, not as an applied protection', async () => {
    getAccountStatus.mockResolvedValue({ success: true, verified_minor: true });

    renderDetail(makeCase());

    // Rolling-out section (#176): its heading carries the not-yet-enforced
    // framing, and the row names the pinned accounts by canonical NIP-05
    // handle (display names are impersonable), both directions.
    const rolloutHeading = await screen.findByText(/rolling out/i);
    expect(rolloutHeading).toHaveTextContent(/not yet enforced by released apps/i);
    const rolloutSection = rolloutHeading.closest('div') as HTMLElement;
    expect(within(rolloutSection).getByText(/DM restriction/i)).toBeInTheDocument();
    expect(within(rolloutSection).getByText(/_@divinehq\.divine\.video/)).toBeInTheDocument();
    expect(within(rolloutSection).getByText(/moderation@divine\.video/)).toBeInTheDocument();
    expect(within(rolloutSection).getByText(/blocked on send and hidden on receive/i)).toBeInTheDocument();
  });

  it('frames the protections as policy-derived, not per-device confirmed', async () => {
    getAccountStatus.mockResolvedValue({ success: true, verified_minor: true });

    renderDetail(makeCase());

    // The whole point of the honest framing: enforced by the apps per policy,
    // never asserted as observed on the user's device.
    expect(
      await screen.findByText(/enforced client-side by the Divine apps/i)
    ).toBeInTheDocument();
    expect(
      screen.getByText(/not confirmed per device/i)
    ).toBeInTheDocument();
  });

  it('does not show the protections block when verified_minor is false', async () => {
    getAccountStatus.mockResolvedValue({ success: true, verified_minor: false });

    const { queryClient } = renderDetail(makeCase());

    // Wait for query settlement, not just the fetch call — asserting against a
    // still-loading tree would pass even if the gating were broken.
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    expect(
      screen.queryByText(/protections that apply to this account/i)
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/rolling out/i)).not.toBeInTheDocument();
  });

  it('does not show the protections block when the account status is unavailable', async () => {
    // A keycast blip must not read as "protected": the badge branch already
    // shows "status unavailable"; the protections list must stay absent too.
    getAccountStatus.mockResolvedValue({ success: false });

    renderDetail(makeCase());

    expect(
      await screen.findByText(/protected-minor status unavailable/i)
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/protections that apply to this account/i)
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/rolling out/i)).not.toBeInTheDocument();
  });

  it('shows status-unavailable when the account-status query rejects', async () => {
    getAccountStatus.mockRejectedValue(new Error('network'));

    renderDetail(makeCase());

    expect(
      await screen.findByText(/protected-minor status unavailable/i)
    ).toBeInTheDocument();
  });
});
