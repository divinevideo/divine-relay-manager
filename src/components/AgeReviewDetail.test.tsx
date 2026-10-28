import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
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
// The case's kept bulk notes (#299): none unless a test says otherwise.
const getAgeReviewBulkNotesJob = vi.fn().mockResolvedValue({ jobId: null });
const getBulkJobNotes = vi.fn().mockResolvedValue({ notes: [], next: null });
const getActiveAgeReviewCase = vi.fn().mockResolvedValue({ success: true, case: null });
// A note's Restore (#299).
const moderateMedia = vi.fn().mockResolvedValue({ success: true });
const logDecision = vi.fn().mockResolvedValue(undefined);

vi.mock('@/hooks/useAdminApi', () => ({
  useApiUrl: () => 'https://api.test.divine.video',
  useAdminApi: () => ({
    updateAgeReviewCase,
    getAgeReviewConfig,
    getAccountStatus,
    getAgeReviewBulkNotesJob,
    getBulkJobNotes,
    getActiveAgeReviewCase,
    moderateMedia,
    logDecision,
  }),
}));
vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ user: undefined, users: [], getModeratorPubkey: async () => 'e'.repeat(64) }),
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
  it.each(['greenlight_application', 'report'])('identifies the family consent request on a %s case', (created_via) => {
    renderDetail(makeCase({ created_via, greenlight_requested_at: '2026-10-01T00:00:00Z' }));
    expect(screen.getByText('Family requested Greenlight')).toBeInTheDocument();
  });

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

  // A case can be stored under an uppercase pubkey (#313), and the hand-off,
  // the Ban warning and the results panel ask for it in lowercase. That
  // lowercase key can also answer another open case of the account, so after a
  // transition the case's own key is written and the lowercase entry is
  // dropped on every branch: the next read asks the worker. (For a case
  // stored in lowercase the own key is the lowercase key, so a close writes
  // null there.)
  describe('a case stored under an uppercase pubkey', () => {
    const UPPER = 'AB'.repeat(32);
    const LOWER = UPPER.toLowerCase();

    it('writes an open result under the own key and drops the lowercase entry', async () => {
      const before = makeCase({ pubkey: UPPER, suspected_age_band: 'age_13_15' });
      const after = makeCase({ pubkey: UPPER, suspected_age_band: 'age_13_15', state: 'restricted_pending_parental_consent', version: 1 });
      updateAgeReviewCase.mockResolvedValueOnce({ success: true, case: after, enforcementComplete: true });
      const { queryClient } = renderDetail(before);
      queryClient.setQueryData(['age-review-active-case', LOWER], { success: true, case: before });
      fireEvent.click(screen.getByRole('button', { name: 'Restrict Account' }));
      await waitFor(() => expect(queryClient.getQueryData(['age-review-active-case', UPPER])).toEqual({ success: true, case: after }));
      expect(queryClient.getQueryData(['age-review-active-case', LOWER])).toBeUndefined();
    });

    it('drops the lowercase active-case entry when a transition closes the case', async () => {
      const before = makeCase({ pubkey: UPPER });
      const after = makeCase({ pubkey: UPPER, state: 'denied_closed', version: 1 });
      updateAgeReviewCase.mockResolvedValueOnce({ success: true, case: after, enforcementComplete: true });
      const { queryClient } = renderDetail(before);
      queryClient.setQueryData(['age-review-active-case', LOWER], { success: true, case: before });
      fireEvent.click(screen.getByRole('button', { name: /Deny.*Close/ }));
      await waitFor(() => expect(queryClient.getQueryData(['age-review-active-case', UPPER])).toEqual({ success: true, case: null }));
      expect(queryClient.getQueryData(['age-review-active-case', LOWER])).toBeUndefined();
    });

    it('drops both active-case entries when a response carries no case', async () => {
      const before = makeCase({ pubkey: UPPER, suspected_age_band: 'age_13_15' });
      updateAgeReviewCase.mockResolvedValueOnce({ success: true, enforcementComplete: true });
      const { queryClient } = renderDetail(before);
      queryClient.setQueryData(['age-review-active-case', LOWER], { success: true, case: before });
      queryClient.setQueryData(['age-review-active-case', UPPER], { success: true, case: before });
      fireEvent.click(screen.getByRole('button', { name: 'Restrict Account' }));
      await waitFor(() => expect(updateAgeReviewCase).toHaveBeenCalled());
      await waitFor(() => expect(queryClient.getQueryData(['age-review-active-case', UPPER])).toBeUndefined());
      expect(queryClient.getQueryData(['age-review-active-case', LOWER])).toBeUndefined();
    });

    it('drops the lowercase active-case entry on a version_conflict too', async () => {
      const before = makeCase({ pubkey: UPPER, suspected_age_band: 'age_13_15' });
      updateAgeReviewCase.mockRejectedValueOnce(
        new ApiError('Case was modified by another request', 409, 'Conflict', 'version_conflict', 5),
      );
      const { queryClient } = renderDetail(before);
      queryClient.setQueryData(['age-review-active-case', LOWER], { success: true, case: before });
      queryClient.setQueryData(['age-review-active-case', UPPER], { success: true, case: before });
      fireEvent.click(screen.getByRole('button', { name: 'Restrict Account' }));
      await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Case changed since you opened it' })));
      expect(queryClient.getQueryData(['age-review-active-case', LOWER])).toBeUndefined();
      expect(queryClient.getQueryData(['age-review-active-case', UPPER])).toBeUndefined();
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
    // Key export: keycast refuses export and change-key for a verified minor.
    expect(within(appliedSection).getByText(/Key export blocked/i)).toBeInTheDocument();
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

    it('tells the moderator "clear without approval" keeps protections on when the account is protected', async () => {
      getAccountStatus.mockResolvedValue({ success: true, status: 'active', verified_minor: true, protected_minor: true });

      renderDetail(makeCase());

      expect(await screen.findByText('Already an approved protected minor. "Clear without approval" closes this case and keeps protections on; Deny bans the account and lifts its protections.')).toBeInTheDocument();
    });

    it('shows that note for a minor only the registry knows, one who holds their own key', async () => {
      getAccountStatus.mockResolvedValue({ success: false, not_found: true, protected_minor: true });

      renderDetail(makeCase());

      expect(await screen.findByText('Already an approved protected minor. "Clear without approval" closes this case and keeps protections on; Deny bans the account and lifts its protections.')).toBeInTheDocument();
    });

    it('refetches account status after a decision so the badge follows the registry', async () => {
      getAccountStatus.mockResolvedValue({ success: true, status: 'active', verified_minor: false, protected_minor: false });
      const { queryClient } = renderDetail(makeCase());
      await waitFor(() => expect(queryClient.isFetching()).toBe(0));
      const callsBefore = getAccountStatus.mock.calls.length;

      fireEvent.click(await screen.findByRole('button', { name: 'Clear without approval' }));

      await waitFor(() => expect(getAccountStatus.mock.calls.length).toBeGreaterThan(callsBefore));
    });

    // A clock or note edit cannot change registry or sign-in status; refetching on it
    // costs a keycast round trip per click.
    it('does not refetch account status after an edit that is not a decision', async () => {
      const { queryClient } = renderDetail(makeCase());
      await waitFor(() => expect(queryClient.isFetching()).toBe(0));
      const callsBefore = getAccountStatus.mock.calls.length;

      fireEvent.click(await screen.findByRole('button', { name: 'Pause Clock' }));

      await waitFor(() => expect(updateAgeReviewCase).toHaveBeenCalledWith(
        'case-1', expect.objectContaining({ clock_paused: true }),
      ));
      await waitFor(() => expect(queryClient.isMutating()).toBe(0));
      await waitFor(() => expect(queryClient.isFetching()).toBe(0));
      expect(getAccountStatus.mock.calls.length).toBe(callsBefore);
    });

    it('invalidates only the decided case\'s account status, not other accounts\' cached status', async () => {
      const { queryClient } = renderDetail(makeCase());
      await waitFor(() => expect(queryClient.isFetching()).toBe(0));
      const otherKey = ['account-status', 'https://api.test.divine.video', 'c'.repeat(64)];
      queryClient.setQueryData(otherKey, { success: true, status: 'active', verified_minor: false, protected_minor: false });

      fireEvent.click(await screen.findByRole('button', { name: 'Clear without approval' }));

      await waitFor(() => expect(updateAgeReviewCase).toHaveBeenCalled());
      await waitFor(() => expect(queryClient.isMutating()).toBe(0));
      expect(queryClient.getQueryState(otherKey)?.isInvalidated).toBe(false);
    });

    it('refetches account status after a version conflict, which may follow a committed write', async () => {
      updateAgeReviewCase.mockRejectedValueOnce(
        new ApiError('Case was modified by another request', 409, 'Conflict', 'version_conflict', 5),
      );
      const { queryClient } = renderDetail(makeCase());
      await waitFor(() => expect(queryClient.isFetching()).toBe(0));
      const callsBefore = getAccountStatus.mock.calls.length;

      fireEvent.click(await screen.findByRole('button', { name: 'Clear without approval' }));

      await waitFor(() => expect(getAccountStatus.mock.calls.length).toBeGreaterThan(callsBefore));
    });

    // The edit that lost was not a decision, but the write that won may have been.
    it('refetches account status when a clock edit loses a version conflict', async () => {
      updateAgeReviewCase.mockRejectedValueOnce(
        new ApiError('Case was modified by another request', 409, 'Conflict', 'version_conflict', 5),
      );
      const { queryClient } = renderDetail(makeCase());
      await waitFor(() => expect(queryClient.isFetching()).toBe(0));
      const callsBefore = getAccountStatus.mock.calls.length;

      fireEvent.click(await screen.findByRole('button', { name: 'Pause Clock' }));

      await waitFor(() => expect(getAccountStatus.mock.calls.length).toBeGreaterThan(callsBefore));
    });

    // The status query is keyed by the lowercased pubkey; a case that stored a
    // mixed-case `p` tag must still refresh its badge.
    it('refetches account status after a decision on a case whose pubkey is not lowercase', async () => {
      const { queryClient } = renderDetail(makeCase({ pubkey: 'A'.repeat(64) }));
      await waitFor(() => expect(queryClient.isFetching()).toBe(0));
      const callsBefore = getAccountStatus.mock.calls.length;

      fireEvent.click(await screen.findByRole('button', { name: 'Clear without approval' }));

      await waitFor(() => expect(getAccountStatus.mock.calls.length).toBeGreaterThan(callsBefore));
    });

    it('does not show "status unavailable" while account status is still loading', async () => {
      getAccountStatus.mockReturnValue(new Promise(() => {}));

      renderDetail(makeCase());

      await screen.findByRole('button', { name: 'Clear without approval' });
      expect(screen.queryByText(/protected-minor status unavailable/i)).not.toBeInTheDocument();
    });

    it('omits that note when the account is not protected', async () => {
      getAccountStatus.mockResolvedValue({ success: true, status: 'active', verified_minor: false, protected_minor: false });

      const { queryClient } = renderDetail(makeCase());

      await screen.findByRole('button', { name: 'Clear without approval' });
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
      expect(screen.getByRole('button', { name: 'Clear without approval' })).toBeInTheDocument();
    });

    // The worker only records an approval for a lowercase 64-char hex pubkey, and
    // the case stores the report's p tag verbatim, so a mixed-case tag can never
    // be approved. Offering the button would fail every time.
    it('hides approval, and says why, when the case pubkey is not lowercase hex', async () => {
      renderDetail(makeCase({ suspected_age_band: 'age_13_15', pubkey: 'A'.repeat(64) }));
      await screen.findByRole('button', { name: 'Clear without approval' });
      expect(screen.queryByRole('button', { name: /Approve as protected minor/ })).not.toBeInTheDocument();
      expect(screen.getByText(/cannot be approved as a protected minor/)).toBeInTheDocument();
    });

    it('hides approval outside the 13-15 band', async () => {
      renderDetail(makeCase({ suspected_age_band: 'age_16_plus_claimed' }));
      await screen.findByRole('button', { name: 'Clear without approval' });
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

    it('Clear without approval sends not_minor immediately', async () => {
      renderDetail(makeCase({ suspected_age_band: 'age_13_15' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Clear without approval' }));
      await waitFor(() => expect(updateAgeReviewCase).toHaveBeenCalledWith(
        'case-1', expect.objectContaining({ state: 'cleared', resolution: 'not_minor' }),
      ));
    });

    it('shows how a closed case was resolved', async () => {
      renderDetail(makeCase({ state: 'cleared', clear_resolution: 'approved_minor' }));
      expect(await screen.findByText('Approved minor')).toBeInTheDocument();
    });

    it('labels a not_minor resolution by the action, "Cleared without approval", true for any account', async () => {
      renderDetail(makeCase({ state: 'cleared', clear_resolution: 'not_minor', suspected_age_band: 'age_16_plus_claimed' }));
      expect(await screen.findByText('Cleared without approval')).toBeInTheDocument();
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

    // The inline error sits under the confirm's overlay, so the failure must also toast.
    it('toasts any other approval error, which the open confirm would hide', async () => {
      updateAgeReviewCase.mockRejectedValueOnce(new ApiError(
        'Approval may not have been recorded. Reload the case before retrying.', 500, 'Server Error',
      ));
      await confirmApproval();
      await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({
        title: 'Approval failed',
        description: 'Approval may not have been recorded. Reload the case before retrying.',
        variant: 'destructive',
      })));
    });

    it('says an unclaimed refusal is retried and applies once the account is claimed', async () => {
      updateAgeReviewCase.mockResolvedValueOnce({
        ...approvalOk, success: false, enforcementComplete: false,
        enforcement: { ...approvalOk.enforcement, keycastMinorSet: 'failed', keycastMinorSetUnclaimed: true },
      });
      await confirmApproval();
      await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({
        title: 'Approved, but keycast refused the minor flag',
        description: "Recorded as a protected minor, so future under-16 reports clear automatically. Keycast refused the minor flag because this account has no login credentials, so the app protections and key-export block do not apply yet. The flag is retried automatically and applies once the account is claimed.",
        variant: 'destructive',
      })));
      expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({ title: 'Enforcement incomplete' }));
    });

    it('does not follow an unclaimed refusal with an all-clear toast', async () => {
      updateAgeReviewCase.mockResolvedValueOnce({
        ...approvalOk, success: false, enforcementComplete: false,
        enforcement: { ...approvalOk.enforcement, keycast: 'not_applicable', keycastMinorSet: 'failed', keycastMinorSetUnclaimed: true },
      });
      await confirmApproval();
      await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Approved, but keycast refused the minor flag' })));
      expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({ title: 'Case updated' }));
    });

    // The app's toast store keeps one toast (TOAST_LIMIT = 1), so a second toast()
    // call evicts the first. The refusal must reach the moderator in the
    // same toast that names the other failed legs.
    it('reports other failed legs in the same toast as an unclaimed refusal', async () => {
      updateAgeReviewCase.mockResolvedValueOnce({
        ...approvalOk, success: false, enforcementComplete: false,
        enforcement: { ...approvalOk.enforcement, relay: 'failed', keycastMinorSet: 'failed', keycastMinorSetUnclaimed: true },
      });
      await confirmApproval();
      await waitFor(() => expect(toast).toHaveBeenCalled());
      expect(toast).toHaveBeenCalledTimes(1);
      expect(toast).toHaveBeenCalledWith(expect.objectContaining({
        title: 'Approved, but keycast refused the minor flag',
        description: expect.stringMatching(/Keycast refused the minor flag.*Also did not apply: relay \(existing posts and feed\)\. These steps are not retried automatically; escalate if they still need to apply\./),
        variant: 'destructive',
      }));
      expect(toast.mock.calls[0][0].description).not.toMatch(/automated retry will continue/i);
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
      fireEvent.click(await screen.findByRole('button', { name: 'Clear without approval' }));
      await waitFor(() => expect(updateAgeReviewCase).toHaveBeenCalled());
      expect(toast).not.toHaveBeenCalledWith(anyNotRecorded);
    });

    it('names a failed verified_minor set in the incomplete-enforcement toast', async () => {
      updateAgeReviewCase.mockResolvedValueOnce({
        success: false, enforcementComplete: false,
        enforcement: { relay: 'ok', bulk: 'ok', keycast: 'ok', subjectActivate: 'ok', keycastMinorSet: 'failed' },
      });
      renderDetail(makeCase({ suspected_age_band: 'age_13_15' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Clear without approval' }));
      await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({
        description: expect.stringContaining('protected-minor account flag'),
      })));
    });
  });
});

// Which failed enforcement steps converge on their own: only the
// protected-minor ones, which the deadline cron retries.
describe('AgeReviewDetail enforcement-incomplete toast', () => {
  beforeEach(() => {
    updateAgeReviewCase.mockReset();
    toast.mockClear();
  });

  it('does not promise a retry for steps nothing retries, nor call a restricted case closed', async () => {
    updateAgeReviewCase.mockResolvedValueOnce({
      success: false,
      case: makeCase({ state: 'restricted_pending_user_response' }),
      enforcementComplete: false,
      enforcement: { relay: 'ok', bulk: 'failed', keycast: 'ok', bulkFailures: ['enumeration:x:y'] },
    });
    renderDetail(makeCase());
    fireEvent.click(screen.getByRole('button', { name: 'Restrict Account' }));
    await waitFor(() => expect(toast).toHaveBeenCalled());
    const description = toast.mock.calls[0][0].description as string;
    expect(description).not.toMatch(/automated retry will continue/i);
    expect(description).not.toMatch(/now closed/i);
    expect(description).toMatch(/not retried automatically/i);
    expect(description).toMatch(/1 problem\(s\) are listed at the top of this case/);
  });

  it('says the protected-minor steps are retried when one of them is what failed', async () => {
    updateAgeReviewCase.mockResolvedValueOnce({
      success: false,
      case: makeCase({ state: 'denied_closed' }),
      enforcementComplete: false,
      enforcement: { relay: 'ok', bulk: 'ok', keycast: 'ok', keycastMinorClear: 'failed' },
    });
    renderDetail(makeCase({ state: 'restricted_pending_user_response' }));
    fireEvent.click(screen.getByRole('button', { name: 'Deny & Close' }));
    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(toast.mock.calls[0][0].description).toMatch(/protected-minor steps are retried automatically/i);
  });

  // The projection cron re-applies a failed minor-flag set (main's #301 leg).
  it("says the protected-minor steps are retried when the approval's minor flag failed", async () => {
    updateAgeReviewCase.mockResolvedValueOnce({
      success: false,
      case: makeCase({ state: 'cleared' }),
      enforcementComplete: false,
      enforcement: { relay: 'ok', bulk: 'ok', keycast: 'ok', subjectActivate: 'ok', keycastMinorSet: 'failed' },
    });
    renderDetail(makeCase({ suspected_age_band: 'age_13_15' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Clear without approval' }));
    await waitFor(() => expect(toast).toHaveBeenCalled());
    const description = toast.mock.calls[0][0].description as string;
    expect(description).toMatch(/protected-minor steps are retried automatically/i);
    expect(description).not.toMatch(/not retried automatically/i);
  });
});

// #299: the bulk leg's results (files a clear left hidden, other accounts'
// files, and its problems) come back on the transition's response and are kept
// under the case, so the screen shows them at once and again on reopen, until
// the moderator dismisses them.
describe('AgeReviewDetail bulk notes', () => {
  const HIDDEN_A = '1'.repeat(64);
  const HIDDEN_B = '2'.repeat(64);

  beforeEach(() => {
    updateAgeReviewCase.mockReset();
    toast.mockClear();
    getAgeReviewBulkNotesJob.mockReset().mockResolvedValue({ jobId: null });
    getBulkJobNotes.mockReset().mockResolvedValue({ notes: [], next: null });
  });

  // The case does not store a transition's notes; bulk_job_notes does, under
  // the case. Opening the case again (a reload) reads them back.
  it('shows the notes kept from an earlier transition when the case is opened again, until dismissed', async () => {
    getAgeReviewBulkNotesJob.mockResolvedValue({ jobId: 'age-review:case-1:3:cleared', state: 'cleared' });
    getBulkJobNotes
      .mockResolvedValueOnce({ notes: [{ kind: 'still-hidden', sha256: HIDDEN_A }], next: '1' })
      .mockResolvedValueOnce({ notes: [{ kind: 'still-hidden', sha256: HIDDEN_B }], next: null });
    renderDetail(makeCase({ state: 'cleared', version: 3 }));
    expect(await screen.findByText(HIDDEN_A)).toBeInTheDocument();
    expect(await screen.findByText(HIDDEN_B)).toBeInTheDocument();
    expect(getAgeReviewBulkNotesJob).toHaveBeenCalledWith('case-1');
    expect(getBulkJobNotes).toHaveBeenNthCalledWith(1, 'age-review:case-1:3:cleared', undefined);
    expect(getBulkJobNotes).toHaveBeenNthCalledWith(2, 'age-review:case-1:3:cleared', '1');
    expect(screen.getAllByRole('button', { name: /restore/i })).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(screen.queryByText(HIDDEN_A)).not.toBeInTheDocument();
  });

  it('shows a later transition\'s notes after earlier ones were dismissed, and reads the kept notes again', async () => {
    getAgeReviewBulkNotesJob.mockResolvedValue({ jobId: 'age-review:case-1:3:restricted_pending_user_response', state: 'restricted_pending_user_response' });
    getBulkJobNotes.mockResolvedValue({ notes: [{ kind: 'still-hidden', sha256: HIDDEN_A }], next: null });
    renderDetail(makeCase());
    expect(await screen.findByText(HIDDEN_A)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(screen.queryByText(HIDDEN_A)).not.toBeInTheDocument();

    clearedWith({ bulkNotes: [{ kind: 'still-hidden', sha256: HIDDEN_B }] });
    const readsBefore = getAgeReviewBulkNotesJob.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Clear without approval' }));
    expect(await screen.findByText(HIDDEN_B)).toBeInTheDocument();
    await waitFor(() => expect(getAgeReviewBulkNotesJob.mock.calls.length).toBeGreaterThan(readsBefore));
  });

  it('lists the failures kept beside the notes, and says which step they came from and when', async () => {
    getAgeReviewBulkNotesJob.mockResolvedValue({ jobId: 'age-review:case-1:3:cleared', state: 'cleared', keptAt: '2026-10-14T09:30:00.000Z' });
    getBulkJobNotes.mockResolvedValue({
      notes: [{ kind: 'still-hidden', sha256: HIDDEN_A }],
      failures: ['enumeration:x:the list could not be read'],
      next: null,
    });
    renderDetail(makeCase({ state: 'cleared', version: 4 }));
    const panel = await screen.findByRole('region', { name: /results to look at/i });
    expect(panel).toHaveTextContent(/When this case was cleared \(/);
    expect(within(panel).getByRole('heading', { name: /problems \(1\)/i })).toBeInTheDocument();
    expect(within(panel).getByText('The list could not be read.')).toBeInTheDocument();
    expect(within(panel).getByText(HIDDEN_A)).toBeInTheDocument();
  });

  it("labels an earlier step's kept notes with that step, not the case's latest", async () => {
    getAgeReviewBulkNotesJob.mockResolvedValue({ jobId: 'age-review:case-1:2:restricted_pending_user_response', state: 'restricted_pending_user_response', keptAt: '2026-10-13T09:30:00.000Z' });
    getBulkJobNotes.mockResolvedValue({ notes: [{ kind: 'not-owned', sha256: HIDDEN_A, owner: 'b'.repeat(64) }], next: null });
    renderDetail(makeCase({ state: 'cleared', version: 5 }));
    const panel = await screen.findByRole('region', { name: /results to look at/i });
    expect(panel).toHaveTextContent(/When this case was restricted/);
    expect(panel).not.toHaveTextContent(/cleared/i);
  });

  it('says on its own, and not as a finished action, that kept results could not be read', async () => {
    getAgeReviewBulkNotesJob.mockRejectedValue(new ApiError('HTTP 500: Internal Server Error', 500, 'Internal Server Error'));
    renderDetail(makeCase({ state: 'open_reported' }));
    expect(await screen.findByText(/could not check this case for results to look at/i)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: /results to look at/i })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/finished/i);
  });

  it('moves focus to the case summary when the panel is dismissed', async () => {
    getAgeReviewBulkNotesJob.mockResolvedValue({ jobId: 'age-review:case-1:3:cleared', state: 'cleared' });
    getBulkJobNotes.mockResolvedValue({ notes: [{ kind: 'still-hidden', sha256: HIDDEN_A }], next: null });
    renderDetail(makeCase({ state: 'cleared' }));
    fireEvent.click(await screen.findByRole('button', { name: /dismiss/i }));
    expect(document.activeElement).toBe(screen.getByRole('group', { name: /case summary/i }));
  });

  it("points to the panel after a clear that left results, and lists the transition's failures in it", async () => {
    clearedWith({
      bulkNotes: [{ kind: 'still-hidden', sha256: HIDDEN_A }, { kind: 'still-hidden', sha256: HIDDEN_B }],
      bulkFailures: ['enumeration:x:the list could not be read'],
    });
    renderDetail(makeCase());
    fireEvent.click(screen.getByRole('button', { name: 'Clear without approval' }));
    const panel = await screen.findByRole('region', { name: /results to look at/i });
    expect(within(panel).getByText('The list could not be read.')).toBeInTheDocument();
    expect(panel).toHaveTextContent(/When this case was cleared/);
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Case updated',
      description: '1 problem(s) and 2 file(s) to check are listed at the top of this case.',
    })));
  });

  it('does not say nothing was left outstanding after a self-custody clear that left results', async () => {
    clearedWith({ keycast: 'not_applicable', bulkNotes: [{ kind: 'still-hidden', sha256: HIDDEN_A }] });
    renderDetail(makeCase());
    fireEvent.click(screen.getByRole('button', { name: 'Clear without approval' }));
    await waitFor(() => expect(toast).toHaveBeenCalled());
    const description = toast.mock.calls[0][0].description as string;
    expect(description).toMatch(/no Divine login/i);
    expect(description).not.toMatch(/nothing else was left outstanding/i);
    expect(description).toMatch(/1 file\(s\) to check are listed at the top of this case/);
  });

  it('says nothing else was left outstanding after a self-custody clear that left none', async () => {
    clearedWith({ keycast: 'not_applicable' });
    renderDetail(makeCase());
    fireEvent.click(screen.getByRole('button', { name: 'Clear without approval' }));
    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(toast.mock.calls[0][0].description).toMatch(/nothing else was left outstanding/i);
  });

  it('reads no notes for a case that kept none', async () => {
    renderDetail(makeCase({ state: 'cleared' }));
    await waitFor(() => expect(getAgeReviewBulkNotesJob).toHaveBeenCalled());
    expect(getBulkJobNotes).not.toHaveBeenCalled();
    expect(screen.queryByRole('region', { name: /to look at/i })).not.toBeInTheDocument();
  });

  it('shows no notes, and no error, when the worker predates kept notes', async () => {
    getAgeReviewBulkNotesJob.mockRejectedValue(new ApiError('Not found', 404, 'Not Found'));
    renderDetail(makeCase({ state: 'cleared' }));
    await waitFor(() => expect(getAgeReviewBulkNotesJob).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole('region', { name: /to look at/i })).not.toBeInTheDocument();
  });

  it('says why the kept notes could not be loaded, and tries again on request', async () => {
    getAgeReviewBulkNotesJob
      .mockRejectedValueOnce(new ApiError('HTTP 500: Internal Server Error', 500, 'Internal Server Error'))
      .mockResolvedValueOnce({ jobId: 'age-review:case-1:3:cleared', state: 'cleared' });
    getBulkJobNotes.mockResolvedValue({ notes: [{ kind: 'still-hidden', sha256: HIDDEN_A }], next: null });
    renderDetail(makeCase({ state: 'cleared' }));
    expect(await screen.findByText(/HTTP 500/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByText(HIDDEN_A)).toBeInTheDocument();
  });

  function clearedWith(enforcement: Record<string, unknown>) {
    updateAgeReviewCase.mockResolvedValueOnce({
      success: true,
      case: makeCase({ state: 'cleared' }),
      enforcementComplete: true,
      enforcement: { relay: 'ok', bulk: 'ok', keycast: 'ok', ...enforcement },
    });
  }

  it('lists the notes from a clear until the moderator dismisses them, without calling the clear a failure', async () => {
    clearedWith({ bulkNotes: [{ kind: 'still-hidden', sha256: HIDDEN_A }, { kind: 'still-hidden', sha256: HIDDEN_B }] });
    const { rerender, queryClient } = renderDetail(makeCase());
    fireEvent.click(screen.getByRole('button', { name: 'Clear without approval' }));
    expect(await screen.findByText(HIDDEN_A)).toBeInTheDocument();
    expect(screen.getByText(HIDDEN_B)).toBeInTheDocument();
    expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({ title: 'Enforcement incomplete' }));
    // The detail re-renders with the cleared case; the panel stays.
    rerender(
      <QueryClientProvider client={queryClient}>
        <AgeReviewDetail caseData={makeCase({ state: 'cleared', version: 1 })} />
      </QueryClientProvider>,
    );
    expect(screen.getByText(HIDDEN_A)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(screen.queryByText(HIDDEN_A)).not.toBeInTheDocument();
  });

  it('drops the notes when another case is opened', async () => {
    clearedWith({ bulkNotes: [{ kind: 'still-hidden', sha256: HIDDEN_A }] });
    const { rerender, queryClient } = renderDetail(makeCase());
    fireEvent.click(screen.getByRole('button', { name: 'Clear without approval' }));
    expect(await screen.findByText(HIDDEN_A)).toBeInTheDocument();
    rerender(
      <QueryClientProvider client={queryClient}>
        <AgeReviewDetail caseData={makeCase({ id: 'case-2', pubkey: 'c'.repeat(64) })} />
      </QueryClientProvider>,
    );
    expect(screen.queryByText(HIDDEN_A)).not.toBeInTheDocument();
  });

  function switchCase(rerender: (ui: React.ReactElement) => void, queryClient: QueryClient, caseData: AgeReviewCase) {
    rerender(
      <QueryClientProvider client={queryClient}>
        <AgeReviewDetail caseData={caseData} />
      </QueryClientProvider>,
    );
  }

  async function restoreFrom(hash: string) {
    const row = screen.getByText(hash).closest('li') as HTMLElement;
    const button = within(row).getByRole('button', { name: `Restore file ${hash}` });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: /restore file/i }));
    expect(await within(row).findByText('Restored')).toBeInTheDocument();
  }

  // The detail stays mounted across a case switch on the page. A file
  // restored here reads Restored when the case is opened again: the kept
  // results, read again, carry restoredAt, and the stale response is dropped.
  it('shows a file restored from a fresh transition as Restored after another case and back', async () => {
    clearedWith({ bulkNotes: [{ kind: 'still-hidden', sha256: HIDDEN_A }] });
    const { rerender, queryClient } = renderDetail(makeCase());
    fireEvent.click(screen.getByRole('button', { name: 'Clear without approval' }));
    expect(await screen.findByText(HIDDEN_A)).toBeInTheDocument();
    getAgeReviewBulkNotesJob.mockResolvedValue({ jobId: 'age-review:case-1:2:cleared', state: 'cleared' });
    getBulkJobNotes.mockResolvedValue({ notes: [{ kind: 'still-hidden', sha256: HIDDEN_A, restoredAt: '2026-10-14T10:00:00.000Z' }], next: null });
    await restoreFrom(HIDDEN_A);

    switchCase(rerender, queryClient, makeCase({ id: 'case-2', pubkey: 'c'.repeat(64) }));
    switchCase(rerender, queryClient, makeCase({ state: 'cleared', version: 2 }));

    const row = (await screen.findByText(HIDDEN_A)).closest('li') as HTMLElement;
    expect(await within(row).findByText('Restored')).toBeInTheDocument();
    expect(within(row).queryByText(/still hidden/i)).not.toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: /restore/i })).not.toBeInTheDocument();
  });

  // The app keeps a query fresh for 60 s; the kept results are read again on
  // every open regardless, so a restore made meanwhile shows.
  it('reads the kept results again when the case is opened again within the app\'s fresh window', async () => {
    getAgeReviewBulkNotesJob.mockResolvedValue({ jobId: 'age-review:case-1:3:cleared', state: 'cleared' });
    getBulkJobNotes.mockResolvedValueOnce({ notes: [{ kind: 'still-hidden', sha256: HIDDEN_A }], next: null });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000 }, mutations: { retry: false } } });
    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <AgeReviewDetail caseData={makeCase({ state: 'cleared' })} />
      </QueryClientProvider>,
    );
    expect(await screen.findByText('Still hidden after this step.')).toBeInTheDocument();
    getBulkJobNotes.mockResolvedValue({ notes: [{ kind: 'still-hidden', sha256: HIDDEN_A, restoredAt: '2026-10-14T10:00:00.000Z' }], next: null });
    switchCase(rerender, queryClient, makeCase({ id: 'case-2', pubkey: 'c'.repeat(64) }));
    switchCase(rerender, queryClient, makeCase({ state: 'cleared' }));
    expect(await screen.findByText('Restored')).toBeInTheDocument();
  });

  it('shows a file the kept results call restored as Restored, over the transition response that called it hidden', async () => {
    clearedWith({ bulkNotes: [{ kind: 'still-hidden', sha256: HIDDEN_A }, { kind: 'still-hidden', sha256: HIDDEN_B }] });
    renderDetail(makeCase());
    getAgeReviewBulkNotesJob.mockResolvedValue({ jobId: 'age-review:case-1:2:cleared', state: 'cleared' });
    getBulkJobNotes.mockResolvedValue({
      notes: [{ kind: 'still-hidden', sha256: HIDDEN_A, restoredAt: '2026-10-14T10:00:00.000Z' }, { kind: 'still-hidden', sha256: HIDDEN_B }],
      next: null,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Clear without approval' }));
    const rowA = (await screen.findByText(HIDDEN_A)).closest('li') as HTMLElement;
    expect(await within(rowA).findByText('Restored')).toBeInTheDocument();
    const rowB = screen.getByText(HIDDEN_B).closest('li') as HTMLElement;
    expect(within(rowB).getByText('Still hidden after this step.')).toBeInTheDocument();
  });

  // A later step, kept while another case was open, replaces this visit's
  // response: the panel shows the case's latest results, labelled with their
  // own step.
  it("shows the case's latest kept step after another case and back, not an earlier visit's response", async () => {
    clearedWith({ bulkNotes: [{ kind: 'still-hidden', sha256: HIDDEN_A }] });
    const { rerender, queryClient } = renderDetail(makeCase());
    fireEvent.click(screen.getByRole('button', { name: 'Clear without approval' }));
    expect(await screen.findByText(HIDDEN_A)).toBeInTheDocument();
    getAgeReviewBulkNotesJob.mockResolvedValue({ jobId: 'age-review:case-1:4:restricted_pending_user_response', state: 'restricted_pending_user_response' });
    getBulkJobNotes.mockResolvedValue({ notes: [{ kind: 'not-owned', sha256: HIDDEN_B, owner: 'b'.repeat(64) }], next: null });

    switchCase(rerender, queryClient, makeCase({ id: 'case-2', pubkey: 'c'.repeat(64) }));
    switchCase(rerender, queryClient, makeCase({ state: 'restricted_pending_user_response', version: 4 }));

    const panel = await screen.findByRole('region', { name: /results to look at/i });
    expect(await within(panel).findByText(HIDDEN_B)).toBeInTheDocument();
    expect(panel).toHaveTextContent(/When this case was restricted/);
    expect(within(panel).queryByText(HIDDEN_A)).not.toBeInTheDocument();
  });

  // Read again on each open, but not on every window focus: that would page
  // through up to 5,000 rows each time the moderator returns to the tab.
  it('does not read the kept results again when the window regains focus', async () => {
    getAgeReviewBulkNotesJob.mockResolvedValue({ jobId: 'age-review:case-1:3:cleared', state: 'cleared' });
    getBulkJobNotes.mockResolvedValue({ notes: [{ kind: 'still-hidden', sha256: HIDDEN_A }], next: null });
    renderDetail(makeCase({ state: 'cleared' }));
    expect(await screen.findByText(HIDDEN_A)).toBeInTheDocument();
    const before = [getAgeReviewBulkNotesJob.mock.calls.length, getBulkJobNotes.mock.calls.length];
    try {
      act(() => { focusManager.setFocused(false); });
      act(() => { focusManager.setFocused(true); });
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      focusManager.setFocused(undefined);
    }
    expect([getAgeReviewBulkNotesJob.mock.calls.length, getBulkJobNotes.mock.calls.length]).toEqual(before);
  });

  it('shows a dismissed panel again when the case is opened again', async () => {
    getAgeReviewBulkNotesJob.mockResolvedValue({ jobId: 'age-review:case-1:3:cleared', state: 'cleared' });
    getBulkJobNotes.mockResolvedValue({ notes: [{ kind: 'still-hidden', sha256: HIDDEN_A }], next: null });
    const { rerender, queryClient } = renderDetail(makeCase({ state: 'cleared' }));
    fireEvent.click(await screen.findByRole('button', { name: /dismiss/i }));
    expect(screen.queryByText(HIDDEN_A)).not.toBeInTheDocument();
    switchCase(rerender, queryClient, makeCase({ id: 'case-2', pubkey: 'c'.repeat(64) }));
    switchCase(rerender, queryClient, makeCase({ state: 'cleared' }));
    expect(await screen.findByText(HIDDEN_A)).toBeInTheDocument();
  });

  async function confirmApproval() {
    renderDetail(makeCase({ suspected_age_band: 'age_13_15' }));
    fireEvent.click(await screen.findByRole('button', { name: /Approve as protected minor/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(updateAgeReviewCase).toHaveBeenCalled());
  }

  it('points to the panel from an approval that was not recorded but left results', async () => {
    updateAgeReviewCase.mockResolvedValueOnce({
      success: false, enforcementComplete: false,
      case: makeCase({ state: 'cleared' }),
      enforcement: { relay: 'ok', bulk: 'ok', keycast: 'ok', subjectActivate: 'failed', bulkNotes: [{ kind: 'still-hidden', sha256: HIDDEN_A }] },
    });
    await confirmApproval();
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Protected-minor approval not recorded',
      description: expect.stringMatching(/re-approved from this case\. 1 file\(s\) to check are listed at the top of this case\.$/),
    })));
  });

  it("points to the panel from an approval keycast's minor flag refused, when it left results", async () => {
    updateAgeReviewCase.mockResolvedValueOnce({
      success: false, enforcementComplete: false,
      case: makeCase({ state: 'cleared' }),
      enforcement: {
        relay: 'ok', bulk: 'ok', keycast: 'ok', subjectActivate: 'ok', keycastMinorSet: 'failed', keycastMinorSetUnclaimed: true,
        bulkNotes: [{ kind: 'still-hidden', sha256: HIDDEN_A }],
      },
    });
    await confirmApproval();
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Approved, but keycast refused the minor flag',
      description: expect.stringMatching(/applies once the account is claimed\. 1 file\(s\) to check are listed at the top of this case\.$/),
    })));
  });

  it('shows no panel when the response has no notes, as from a worker that predates them', async () => {
    clearedWith({});
    renderDetail(makeCase());
    fireEvent.click(screen.getByRole('button', { name: 'Clear without approval' }));
    await waitFor(() => expect(updateAgeReviewCase).toHaveBeenCalled());
    expect(screen.queryByRole('region', { name: /to look at/i })).not.toBeInTheDocument();
  });
});
