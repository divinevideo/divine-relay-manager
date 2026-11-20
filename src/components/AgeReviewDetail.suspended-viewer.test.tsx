// ABOUTME: Pins that age review gates the suspended-content viewer on the relay's suspended list
// ABOUTME: (the source report detail uses and the worker serves from), not on keycast's status.

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';

import { AgeReviewDetail } from './AgeReviewDetail';
import type { AgeReviewCase } from '../../shared/age-review';
import { withAsModerator } from '@/test/adminApiMock';

const userStats = vi.fn();
const accountStatus = vi.fn();
const reportedEvent = vi.fn();

vi.mock('@/hooks/useUserStats', () => ({ useUserStats: () => userStats() }));
vi.mock('@/hooks/useAccountStatus', () => ({ useAccountStatus: () => accountStatus() }));
vi.mock('@/hooks/useReportedEvent', () => ({ useReportedEvent: (...args: unknown[]) => reportedEvent(...args) }));
vi.mock('@/components/MediaPreview', () => ({ MediaPreview: () => <div data-testid="media-preview" /> }));
vi.mock('@/hooks/useAuthor', () => ({ useAuthor: () => ({ data: undefined, isLoading: false }) }));
vi.mock('@/hooks/useToast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
// Exposes the pubkey the enforcement path would act on, which is the one value
// in this component that is written rather than read.
vi.mock('@/components/UserActions', () => ({
  UserActions: ({ pubkey }: { pubkey: string }) => <div data-testid="user-actions">{pubkey}</div>,
}));
// The case's own actions (restrict, clear) go through asModerator (#178).
const updateAgeReviewCase = vi.fn();
// The relay's suspended list, which useSuspendedPubkeys reads.
const suspendedList = vi.fn();
const api = withAsModerator({
  updateAgeReviewCase: (...args: unknown[]) => updateAgeReviewCase(...args),
  getAgeReviewConfig: vi.fn().mockResolvedValue({ auto_delete_on_deny: false }),
  // No bulk notes kept for any case (#299).
  getAgeReviewBulkNotesJob: vi.fn().mockResolvedValue({ jobId: null }),
  getAccountStatus: vi.fn().mockResolvedValue({ success: true, status: 'active' }),
  listSuspendedPubkeys: () => suspendedList(),
});
vi.mock('@/hooks/useAdminApi', () => ({
  useApiUrl: () => 'https://api.test',
  useAdminApi: () => api,
}));
vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ user: undefined, users: [], getModeratorToken: () => 'moderator-login-token' }),
}));
// The panels have their own tests; here they only mark where they mount.
vi.mock('@/components/suspended/SuspendedContentPanel', () => ({
  SuspendedPostViewer: () => <div data-testid="post-viewer" />,
  SuspendedAccountViewer: ({ pubkey }: { pubkey: string }) => <div data-testid="account-viewer">{pubkey}</div>,
}))

// Deliberately mixed case: the case pubkey is stored verbatim from an untrusted
// `p` tag, and every consumer (relay filters, the worker, the management API)
// requires lowercase. A lowercase fixture cannot observe the normalization.
const RAW_PUBKEY = 'AbCd'.repeat(16);
const PUBKEY = RAW_PUBKEY.toLowerCase();

function makeCase(over: Partial<AgeReviewCase> = {}): AgeReviewCase {
  return {
    id: 'case-1',
    pubkey: RAW_PUBKEY,
    reporter_pubkey: 'b'.repeat(64),
    report_id: 'report-1',
    suspected_age_band: 'age_13_15',
    state: 'under_moderator_review',
    allowed_resolution: 'parent_video_or_email',
    parent_contact_email: null,
    deadline_at: new Date(Date.now() + 7 * 864e5).toISOString(),
    clock_paused: 0,
    clock_paused_at: null,
    remaining_days_when_paused: null,
    moderator_pubkey: null,
    resolution_note: null,
    last_alerted_at: null,
    zendesk_ticket_id: null,
    created_via: null,
    ...over,
  } as AgeReviewCase;
}

const emptyStats = (over: Record<string, unknown> = {}) => ({
  data: {
    postCount: 0, reportCount: 0, labelCount: 0,
    recentPosts: [], existingLabels: [], previousReports: [],
    relayIncomplete: false,
    authoredContentIncomplete: false,
    labelsIncomplete: false,
    reportsIncomplete: false,
    reportsTruncated: false,
    labelsTruncated: false,
    ...over,
  },
  isError: false, isFetching: false, refetch: vi.fn(),
});

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  vi.clearAllMocks();
  userStats.mockReturnValue(emptyStats());
  accountStatus.mockReturnValue({ data: { success: true, status: 'active' }, isError: false, isLoading: false, refetch: vi.fn() });
  reportedEvent.mockReturnValue({ data: undefined, isFetching: false, isError: false, refetch: vi.fn() });
  suspendedList.mockResolvedValue([]);
});

const show = () => render(<AgeReviewDetail caseData={makeCase()} />, { wrapper });
const keycastSays = (status: string) =>
  accountStatus.mockReturnValue({ data: { success: true, status }, isError: false, isLoading: false, refetch: vi.fn() });

function updateRelayListOnDecision(entries: { pubkey: string }[]) {
  updateAgeReviewCase.mockImplementationOnce(async () => {
    suspendedList.mockResolvedValue(entries);
    return { success: true, enforcement: { relay: 'ok', bulk: 'ok', keycast: 'ok' } };
  });
}

describe('AgeReviewDetail gates the suspended-content viewer on the relay list', () => {
  it('offers the viewer when the relay lists the subject, matched however either side spells it', async () => {
    keycastSays('suspended');
    suspendedList.mockResolvedValue([{ pubkey: RAW_PUBKEY.toUpperCase() }]);
    show();

    expect(await screen.findByTestId('account-viewer')).toHaveTextContent(PUBKEY);
  });

  it('offers it for a relay-listed self-custody account keycast has no record of', async () => {
    keycastSays('not_found');
    suspendedList.mockResolvedValue([{ pubkey: PUBKEY }]);
    show();

    expect(await screen.findByTestId('account-viewer')).toBeInTheDocument();
  });

  it('does not offer it when keycast says suspended but the relay list does not hold the subject', async () => {
    keycastSays('suspended');
    suspendedList.mockResolvedValue([{ pubkey: 'f'.repeat(64) }]);
    show();

    await waitFor(() => expect(suspendedList).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText(/hidden by suspension/i)).toBeInTheDocument());
    expect(screen.queryByTestId('account-viewer')).not.toBeInTheDocument();
  });

  it('does not offer it when the relay list read fails', async () => {
    keycastSays('suspended');
    suspendedList.mockRejectedValue(new Error('relay down'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    show();

    // One retry, as every list read, after React Query's 1 s backoff.
    await waitFor(() => expect(suspendedList).toHaveBeenCalledTimes(2), { timeout: 3000 });
    await new Promise(r => setTimeout(r, 0));
    expect(screen.queryByTestId('account-viewer')).not.toBeInTheDocument();
  });
});

// A case decision changes the relay's suspended list: restrict suspends the
// account and clear lifts the suspension (#437). The viewer reads that list,
// so it must follow the decision rather than a copy read before it.
describe('AgeReviewDetail re-reads the relay list after a case decision', () => {
  it('withdraws the viewer after a clear lifted the suspension', async () => {
    keycastSays('suspended');
    suspendedList.mockResolvedValue([{ pubkey: PUBKEY }]);
    render(<AgeReviewDetail caseData={makeCase({ state: 'restricted_pending_user_response' })} />, { wrapper });
    expect(await screen.findByTestId('account-viewer')).toBeInTheDocument();

    // The worker's clear unsuspends the account on the relay.
    updateRelayListOnDecision([]);
    fireEvent.click(await screen.findByRole('button', { name: 'Clear without approval' }));

    await waitFor(() => expect(updateAgeReviewCase).toHaveBeenCalledWith(
      'case-1', expect.objectContaining({ state: 'cleared' }),
    ));
    await waitFor(() => expect(screen.queryByTestId('account-viewer')).not.toBeInTheDocument());
  });

  it('offers the viewer after a restrict suspended the account', async () => {
    suspendedList.mockResolvedValue([]);
    show();
    await waitFor(() => expect(suspendedList).toHaveBeenCalled());
    expect(screen.queryByTestId('account-viewer')).not.toBeInTheDocument();

    // The worker's restrict suspends the account on the relay.
    updateRelayListOnDecision([{ pubkey: PUBKEY }]);
    fireEvent.click(screen.getByRole('button', { name: 'Restrict Account' }));

    await waitFor(() => expect(updateAgeReviewCase).toHaveBeenCalledWith(
      'case-1', expect.objectContaining({ state: 'restricted_pending_user_response' }),
    ));
    expect(await screen.findByTestId('account-viewer')).toHaveTextContent(PUBKEY);
  });

  it('replaces the first suspended-list read when a restrict settles before it', async () => {
    let resolveFirstRead!: (entries: { pubkey: string }[]) => void;
    const firstRead = new Promise<{ pubkey: string }[]>(resolve => { resolveFirstRead = resolve; });
    suspendedList.mockReturnValueOnce(firstRead);
    show();
    await waitFor(() => expect(suspendedList).toHaveBeenCalledTimes(1));

    updateRelayListOnDecision([{ pubkey: PUBKEY }]);
    fireEvent.click(screen.getByRole('button', { name: 'Restrict Account' }));

    expect(await screen.findByTestId('account-viewer')).toHaveTextContent(PUBKEY);
    await act(async () => { resolveFirstRead([]); });
    expect(screen.getByTestId('account-viewer')).toHaveTextContent(PUBKEY);
    expect(suspendedList).toHaveBeenCalledTimes(2);
  });
});
