import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { AgeReviewDetail } from './AgeReviewDetail';
import { ApiError } from '@/lib/adminApi';

// AgeReviewDetail reads relay content-presence via useUserStats (which needs a
// NostrProvider). This unit test isolates the case-action logic, so stub it with
// a resolved, empty read (not in-flight) so the indicator's content-presence
// note doesn't bleed into unrelated assertions.
// AgeReviewContent reads the reported event via useReportedEvent (which needs a
// NostrProvider). This unit test isolates the case-action logic, so stub it.
vi.mock('@/hooks/useReportedEvent', () => ({
  useReportedEvent: () => ({ data: undefined, isFetching: false, isError: false, refetch: () => Promise.resolve() }),
}));
vi.mock('@/hooks/useUserStats', () => ({
  useUserStats: () => ({
    data: { postCount: 0, reportCount: 0, labelCount: 0, recentPosts: [], existingLabels: [], previousReports: [], relayIncomplete: false },
    isError: false,
  }),
}));
import type { AgeReviewCase, AgeBand, AgeReviewState } from '../../shared/age-review';

const updateAgeReviewCase = vi.fn().mockResolvedValue({ success: true });
const getAgeReviewConfig = vi.fn().mockResolvedValue({ auto_delete_on_deny: false });
const getAccountStatus = vi
  .fn()
  .mockResolvedValue({ success: true, status: 'active', verified_minor: false, protected_minor: false });
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
    account_name: null,
    account_nip05: null,
    account_vine_username: null,
    identity_captured_at: null,
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
    getAccountStatus.mockResolvedValue({ success: true, status: 'active', verified_minor: false, protected_minor: false });
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

  // Self-custody targets have no Divine login, so the sign-in leg has nothing to
  // act on. That is not a failed enforcement and must not read as one -- but it
  // must still be visible, or the moderator walks away believing a sign-in was
  // blocked when none exists (issue #191).
  it('reports a not-applicable sign-in leg as information, not a failure', async () => {
    updateAgeReviewCase.mockResolvedValueOnce({
      success: true,
      case: makeCase({ state: 'restricted_pending_user_response' }),
      enforcementComplete: true,
      enforcement: { relay: 'ok', bulk: 'ok', keycast: 'not_applicable' },
    });
    renderDetail(makeCase({ suspected_age_band: 'age_13_15' }));

    fireEvent.click(screen.getByRole('button', { name: 'Restrict Account' }));

    await waitFor(() => expect(toast).toHaveBeenCalled());
    const arg = toast.mock.calls[0][0];
    expect(arg.title).not.toBe('Enforcement incomplete');
    expect(arg.variant).not.toBe('destructive');
    expect(arg.description).toMatch(/sign-in/i);
    expect(arg.description).toMatch(/no Divine login/i);
    // No "retry or escalate" instruction: there is nothing to retry.
    expect(arg.description).not.toMatch(/escalate/i);
  });

  // The confirmation must not assert that the OTHER legs applied. A deny with
  // auto_delete_on_deny off leaves `bulk` at not_attempted: nothing was applied
  // for content, and claiming otherwise is the same overstatement in the
  // opposite direction from the alarm this change removes.
  it('does not claim content enforcement applied when that leg was never attempted', async () => {
    updateAgeReviewCase.mockResolvedValueOnce({
      success: true,
      case: makeCase({ state: 'denied_closed' }),
      enforcementComplete: true,
      enforcement: { relay: 'ok', bulk: 'not_attempted', keycast: 'not_applicable' },
    });
    renderDetail(makeCase({ suspected_age_band: 'age_13_15', state: 'restricted_pending_user_response' }));

    fireEvent.click(screen.getByRole('button', { name: 'Deny & Close' }));

    await waitFor(() => expect(toast).toHaveBeenCalled());
    const description = toast.mock.calls[0][0].description as string;
    expect(description).toMatch(/no Divine login/i);
    // Asserts the property, not a phrasing that has already been removed: the
    // confirmation must never claim any leg APPLIED, because this transition
    // may not have attempted them. An absence assertion against wording that no
    // version of the copy contains cannot fail, and guards nothing.
    expect(description).not.toMatch(/\bapplied\b/i);
  });

  // A genuinely failed leg alongside a not-applicable one is still a failure,
  // and the failure is what the moderator must see.
  it('still raises the failure toast when another leg failed', async () => {
    updateAgeReviewCase.mockResolvedValueOnce({
      success: false,
      case: makeCase({ state: 'restricted_pending_user_response' }),
      enforcementComplete: false,
      enforcement: { relay: 'failed', bulk: 'ok', keycast: 'not_applicable' },
    });
    renderDetail(makeCase({ suspected_age_band: 'age_13_15' }));

    fireEvent.click(screen.getByRole('button', { name: 'Restrict Account' }));

    await waitFor(() => {
      expect(toast).toHaveBeenCalledWith(expect.objectContaining({
        title: 'Enforcement incomplete',
        variant: 'destructive',
      }));
    });
    expect(toast.mock.calls[0][0].description).not.toMatch(/account sign-in/);
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
      account_name: null,
      account_nip05: null,
      account_vine_username: null,
      identity_captured_at: null,
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
      await screen.findByText('Approved protected minor (13-15)')
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
      await screen.findByText('Approved protected minor (13-15)')
    ).toBeInTheDocument();
    expect(screen.queryByText(/approved \d/i)).not.toBeInTheDocument();
  });

  it('does not show the protected-minor badge when verified_minor is false', async () => {
    getAccountStatus.mockResolvedValue({ success: true, status: 'active', verified_minor: false, protected_minor: false });

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

  it('lists the adult content lock and the DM restriction under "apply to this account"', async () => {
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
    // DM restriction (divinevideo/support-trust-safety#176): released in mobile 1.0.16, so
    // it is an applied protection. The row names the pinned accounts by
    // canonical NIP-05 handle (display names are impersonable), both directions.
    expect(within(appliedSection).getByText(/DM restriction/i)).toBeInTheDocument();
    expect(within(appliedSection).getByText(/_@divinehq\.divine\.video/)).toBeInTheDocument();
    expect(within(appliedSection).getByText(/moderation@divine\.video/)).toBeInTheDocument();
    expect(within(appliedSection).getByText(/blocked on send and hidden on receive/i)).toBeInTheDocument();
  });

  it('has no rolling-out section now that every protection is released', async () => {
    getAccountStatus.mockResolvedValue({ success: true, status: 'active', verified_minor: true });

    renderDetail(makeCase());

    await screen.findByText(/protections that apply to this account/i);
    expect(screen.queryByText(/rolling out/i)).not.toBeInTheDocument();
  });

  it('frames the protections as policy-derived, not per-device confirmed', async () => {
    getAccountStatus.mockResolvedValue({ success: true, status: 'active', verified_minor: true });

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
    getAccountStatus.mockResolvedValue({ success: true, status: 'active', verified_minor: false, protected_minor: false });

    const { queryClient } = renderDetail(makeCase());

    // Wait for query settlement, not just the fetch call — asserting against a
    // still-loading tree would pass even if the gating were broken.
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    expect(
      screen.queryByText(/protections that apply to this account/i)
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/DM restriction/i)).not.toBeInTheDocument();
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
    expect(screen.queryByText(/DM restriction/i)).not.toBeInTheDocument();
  });

  it('renders the account-type indicator (self-custody) for a not_found account', async () => {
    getAccountStatus.mockResolvedValue({ success: false, not_found: true });

    renderDetail(makeCase({ suspected_age_band: 'age_13_15' }));

    expect(await screen.findByText('Self-custody (not in keycast)')).toBeInTheDocument();
  });

  it('does not show "protected-minor status unavailable" for a self-custody (not_found) account the registry has answered for (review)', async () => {
    getAccountStatus.mockResolvedValue({ success: false, not_found: true, protected_minor: false });

    const { queryClient } = renderDetail(makeCase({ suspected_age_band: 'age_13_15' }));

    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    // not_found plus a registry answer is definitive: the "unavailable" label is
    // reserved for a source that could not answer.
    expect(screen.queryByText(/protected-minor status unavailable/i)).not.toBeInTheDocument();
  });

  it('shows status-unavailable when the account-status query rejects', async () => {
    getAccountStatus.mockRejectedValue(new Error('network'));

    renderDetail(makeCase());

    expect(
      await screen.findByText(/protected-minor status unavailable/i)
    ).toBeInTheDocument();
  });

  describe('protected-minor registry (#192)', () => {
    it('shows the approved badge with an own-key note for a registry-protected self-custody account', async () => {
      getAccountStatus.mockResolvedValue({ success: false, not_found: true, protected_minor: true });

      renderDetail(makeCase());

      expect(await screen.findByText('Approved protected minor (13-15)')).toBeInTheDocument();
      expect(screen.getByText('holds own key: only report auto-clear applies')).toBeInTheDocument();
      // The app-protections list is keycast's and does not apply to this account.
      expect(screen.queryByText(/protections that apply to this account/i)).not.toBeInTheDocument();
    });

    it('shows the badge and not "status unavailable" when keycast is down but the registry is protected', async () => {
      getAccountStatus.mockResolvedValue({ success: false, error: '500', protected_minor: true });

      renderDetail(makeCase());

      expect(await screen.findByText('Approved protected minor (13-15)')).toBeInTheDocument();
      expect(screen.getByText('app protections unknown: keycast unavailable')).toBeInTheDocument();
      expect(screen.queryByText(/protected-minor status unavailable/i)).not.toBeInTheDocument();
    });

    it('shows "status unavailable" for a self-custody account whose registry read failed', async () => {
      getAccountStatus.mockResolvedValue({ success: false, not_found: true, protected_minor: null });

      renderDetail(makeCase());

      expect(await screen.findByText(/protected-minor status unavailable/i)).toBeInTheDocument();
    });

    it('tells the moderator "not a minor" keeps protections on when the account is protected', async () => {
      getAccountStatus.mockResolvedValue({ success: true, status: 'active', verified_minor: true, protected_minor: true });

      renderDetail(makeCase());

      expect(await screen.findByText('Already an approved protected minor. "Not a minor" closes this case and keeps protections on; Deny bans the account and lifts its protections.')).toBeInTheDocument();
    });

    it('shows that note for a minor only the registry knows, one who holds their own key', async () => {
      getAccountStatus.mockResolvedValue({ success: false, not_found: true, protected_minor: true });

      renderDetail(makeCase());

      expect(await screen.findByText('Already an approved protected minor. "Not a minor" closes this case and keeps protections on; Deny bans the account and lifts its protections.')).toBeInTheDocument();
    });

    it('refetches account status after a decision so the badge follows the registry', async () => {
      getAccountStatus.mockResolvedValue({ success: true, status: 'active', verified_minor: false, protected_minor: false });
      const { queryClient } = renderDetail(makeCase());
      await waitFor(() => expect(queryClient.isFetching()).toBe(0));
      const callsBefore = getAccountStatus.mock.calls.length;

      fireEvent.click(await screen.findByRole('button', { name: 'Clear: not a minor' }));

      await waitFor(() => expect(getAccountStatus.mock.calls.length).toBeGreaterThan(callsBefore));
    });

    it('refetches account status after a version conflict, which may follow a committed write', async () => {
      updateAgeReviewCase.mockRejectedValueOnce(
        new ApiError('Case was modified by another request', 409, 'Conflict', 'version_conflict', 5),
      );
      const { queryClient } = renderDetail(makeCase());
      await waitFor(() => expect(queryClient.isFetching()).toBe(0));
      const callsBefore = getAccountStatus.mock.calls.length;

      fireEvent.click(await screen.findByRole('button', { name: 'Clear: not a minor' }));

      await waitFor(() => expect(getAccountStatus.mock.calls.length).toBeGreaterThan(callsBefore));
    });

    it('does not show "status unavailable" while account status is still loading', async () => {
      getAccountStatus.mockReturnValue(new Promise(() => {}));

      renderDetail(makeCase());

      await screen.findByRole('button', { name: 'Clear: not a minor' });
      expect(screen.queryByText(/protected-minor status unavailable/i)).not.toBeInTheDocument();
    });

    it('omits that note when the account is not protected', async () => {
      getAccountStatus.mockResolvedValue({ success: true, status: 'active', verified_minor: false, protected_minor: false });

      const { queryClient } = renderDetail(makeCase());

      await screen.findByRole('button', { name: 'Clear: not a minor' });
      await waitFor(() => expect(queryClient.isFetching()).toBe(0));
      expect(screen.queryByText(/Already an approved protected minor/)).not.toBeInTheDocument();
    });

    it('approve confirm says only auto-clear applies for an account that holds its own key', async () => {
      getAccountStatus.mockResolvedValue({ success: false, not_found: true, protected_minor: false });

      const { queryClient } = renderDetail(makeCase());
      await waitFor(() => expect(queryClient.isFetching()).toBe(0));
      fireEvent.click(await screen.findByRole('button', { name: /Approve as protected minor/ }));

      expect(await screen.findByText(/This account holds its own key, so Divine can't apply the adult content lock/)).toBeInTheDocument();
    });

    it('approve confirm promises app protections for a Divine login account', async () => {
      getAccountStatus.mockResolvedValue({ success: true, status: 'active', verified_minor: false, protected_minor: false });

      const { queryClient } = renderDetail(makeCase());
      await waitFor(() => expect(queryClient.isFetching()).toBe(0));
      fireEvent.click(await screen.findByRole('button', { name: /Approve as protected minor/ }));

      expect(await screen.findByText(/Minor DM limits and the adult content lock apply, key export is blocked/)).toBeInTheDocument();
    });
  });

  describe('clearing a case', () => {
    it('offers approval as a protected minor only on a 13-15 case', async () => {
      renderDetail(makeCase({ suspected_age_band: 'age_13_15' }));
      expect(await screen.findByRole('button', { name: /Approve as protected minor/ })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Clear: not a minor' })).toBeInTheDocument();
    });

    it('hides approval outside the 13-15 band', async () => {
      renderDetail(makeCase({ suspected_age_band: 'age_16_plus_claimed' }));
      await screen.findByRole('button', { name: 'Clear: not a minor' });
      expect(screen.queryByRole('button', { name: /Approve as protected minor/ })).not.toBeInTheDocument();
    });

    it('sends approved_minor only after the moderator confirms', async () => {
      renderDetail(makeCase({ suspected_age_band: 'age_13_15' }));
      fireEvent.click(await screen.findByRole('button', { name: /Approve as protected minor/ }));
      expect(updateAgeReviewCase).not.toHaveBeenCalled();
      fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
      await waitFor(() => expect(updateAgeReviewCase).toHaveBeenCalledWith(
        'case-1', expect.objectContaining({ state: 'cleared', resolution: 'approved_minor' }),
      ));
    });

    it('cancelling the confirm sends nothing', async () => {
      renderDetail(makeCase({ suspected_age_band: 'age_13_15' }));
      fireEvent.click(await screen.findByRole('button', { name: /Approve as protected minor/ }));
      fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
      expect(updateAgeReviewCase).not.toHaveBeenCalled();
    });

    it('Clear: not a minor sends not_minor immediately', async () => {
      renderDetail(makeCase({ suspected_age_band: 'age_13_15' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Clear: not a minor' }));
      await waitFor(() => expect(updateAgeReviewCase).toHaveBeenCalledWith(
        'case-1', expect.objectContaining({ state: 'cleared', resolution: 'not_minor' }),
      ));
    });

    it('shows how a closed case was resolved', async () => {
      renderDetail(makeCase({ state: 'cleared', clear_resolution: 'approved_minor' }));
      expect(await screen.findByText('Approved minor')).toBeInTheDocument();
    });

    async function confirmApproval() {
      renderDetail(makeCase({ suspected_age_band: 'age_13_15' }));
      fireEvent.click(await screen.findByRole('button', { name: /Approve as protected minor/ }));
      fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
      await waitFor(() => expect(updateAgeReviewCase).toHaveBeenCalled());
    }
    const approvalOk = {
      success: true, enforcementComplete: true,
      enforcement: { relay: 'ok', bulk: 'ok', keycast: 'ok', subjectActivate: 'ok', keycastMinorSet: 'ok' },
    };
    const notRecorded = 'The case is closed, but the account was NOT recorded as a protected minor, so it is restored without minor protections. Escalate now; it cannot be re-approved from this case.';
    const anyNotRecorded = expect.objectContaining({ description: expect.stringContaining('NOT recorded as a protected minor') });

    it('qualifies app protections in the confirm when keycast cannot say what kind of account this is', async () => {
      getAccountStatus.mockResolvedValue({ success: false, error: '500', protected_minor: false });
      const { queryClient } = renderDetail(makeCase({ suspected_age_band: 'age_13_15' }));
      await waitFor(() => expect(queryClient.isFetching()).toBe(0));
      fireEvent.click(await screen.findByRole('button', { name: /Approve as protected minor/ }));
      expect(await screen.findByText(
        'This account is restored and marked as an approved 13-15 minor, and future under-16 reports clear automatically. For Divine login accounts, minor DM limits and the adult content lock also apply and key export is blocked.',
      )).toBeInTheDocument();
    });

    // A stale replay must not approve on top of another moderator's change.
    it('closes the confirm on a version_conflict so it cannot be replayed', async () => {
      updateAgeReviewCase.mockRejectedValueOnce(
        new ApiError('Case was modified by another request', 409, 'Conflict', 'version_conflict', 5),
      );
      await confirmApproval();
      await waitFor(() => expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument());
    });

    it('keeps the confirm open on any other error so the moderator can retry', async () => {
      updateAgeReviewCase.mockRejectedValueOnce(new ApiError('server error', 500, 'Server Error'));
      await confirmApproval();
      await waitFor(() => expect(screen.getByText(/Failed to update/)).toBeInTheDocument());
      expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
    });

    it('does not report success when the worker did not record a protected subject', async () => {
      // A worker that predates approvals (Pages deployed first) answers without subjectActivate.
      updateAgeReviewCase.mockResolvedValueOnce({
        success: true, enforcementComplete: true, enforcement: { relay: 'ok', bulk: 'ok', keycast: 'ok' },
      });
      await confirmApproval();
      await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({
        description: notRecorded, variant: 'destructive',
      })));
    });

    it('reports a failed subject activation as not recorded', async () => {
      updateAgeReviewCase.mockResolvedValueOnce({
        ...approvalOk, success: false, enforcementComplete: false,
        enforcement: { ...approvalOk.enforcement, subjectActivate: 'failed' },
      });
      await confirmApproval();
      await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ description: notRecorded })));
    });

    // The not-recorded toast is the only one shown, so it must carry the other failures too.
    it('names other failed legs in the not-recorded toast', async () => {
      updateAgeReviewCase.mockResolvedValueOnce({
        ...approvalOk, success: false, enforcementComplete: false,
        enforcement: { ...approvalOk.enforcement, relay: 'failed', bulk: 'failed', subjectActivate: 'failed', keycastMinorSet: 'not_attempted' },
      });
      await confirmApproval();
      await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({
        description: `${notRecorded} Also did not apply: relay (existing posts and feed), media and content.`,
        variant: 'destructive',
      })));
      expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({ title: 'Enforcement incomplete' }));
    });

    it('raises no not-recorded warning when the subject was activated', async () => {
      updateAgeReviewCase.mockResolvedValueOnce(approvalOk);
      await confirmApproval();
      await waitFor(() => expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument());
      expect(toast).not.toHaveBeenCalledWith(anyNotRecorded);
    });

    it('applies the not-recorded check only to approvals', async () => {
      updateAgeReviewCase.mockResolvedValueOnce({ success: true, enforcementComplete: true, enforcement: { relay: 'ok' } });
      renderDetail(makeCase({ suspected_age_band: 'age_13_15' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Clear: not a minor' }));
      await waitFor(() => expect(updateAgeReviewCase).toHaveBeenCalled());
      expect(toast).not.toHaveBeenCalledWith(anyNotRecorded);
    });

    it('names a failed verified_minor set in the incomplete-enforcement toast', async () => {
      updateAgeReviewCase.mockResolvedValueOnce({
        success: false, enforcementComplete: false,
        enforcement: { relay: 'ok', bulk: 'ok', keycast: 'ok', subjectActivate: 'ok', keycastMinorSet: 'failed' },
      });
      renderDetail(makeCase({ suspected_age_band: 'age_13_15' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Clear: not a minor' }));
      await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({
        description: expect.stringContaining('protected-minor account flag'),
      })));
    });
  });
});
