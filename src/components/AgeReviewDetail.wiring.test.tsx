import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';

import { AgeReviewDetail } from './AgeReviewDetail';
import type { AgeReviewCase } from '../../shared/age-review';

// The pure derivations (contentVisibility, useReportedEvent) are covered by their
// own tests. What was NOT covered is that AgeReviewDetail actually FEEDS them:
// every plumbing prop could be hardcoded to a falsy default and the whole suite
// still passed. These tests assert the wiring through the rendered output, so a
// dropped prop shows up as a wrong claim on screen rather than as silence.

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
vi.mock('@/hooks/useAdminApi', () => ({
  useApiUrl: () => 'https://api.test',
  useAdminApi: () => ({
    updateAgeReviewCase: vi.fn().mockResolvedValue({ success: true }),
    getAgeReviewConfig: vi.fn().mockResolvedValue({ auto_delete_on_deny: false }),
    getAccountStatus: vi.fn().mockResolvedValue({ success: true, status: 'active' }),
  }),
}));

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
});

const show = () => render(<AgeReviewDetail caseData={makeCase()} />, { wrapper });

describe('AgeReviewDetail feeds the content derivations', () => {
  it('passes authoredContentIncomplete through, so a truncated content read is not shown as absence', async () => {
    userStats.mockReturnValue(emptyStats({
      relayIncomplete: true,
      authoredContentIncomplete: true,
    }));
    show();
    await waitFor(() => expect(screen.getByText(/couldn't load/i)).toBeInTheDocument());
    expect(screen.queryByText(/no content found/i)).not.toBeInTheDocument();
  });

  it('does not treat an ancillary stats failure as an authored-content failure', async () => {
    userStats.mockReturnValue(emptyStats({
      relayIncomplete: true,
      authoredContentIncomplete: false,
      labelsIncomplete: true,
    }));
    const { container } = show();
    await waitFor(() => expect(screen.getByText(/no content found/i)).toBeInTheDocument());
    expect(screen.queryByText(/couldn't load this account's content/i)).not.toBeInTheDocument();
    expect(container.textContent).toMatch(/n\/a/i);
  });

  it('does not rule out suspension when keycast could not answer', async () => {
    accountStatus.mockReturnValue({ data: { success: false }, isError: true, isLoading: false, refetch: vi.fn() });
    show();
    await waitFor(() => expect(screen.getByText(/suspension cannot be ruled out/i)).toBeInTheDocument());
  });

  it('does not let the account panel and the content card contradict each other', async () => {
    // Both read the same status. A stale suspended value retained after a failed
    // refetch must not make one assert the suspension while the other says it
    // cannot be ruled out, 20px apart on the same screen.
    accountStatus.mockReturnValue({
      data: { success: true, status: 'suspended' }, isError: true, isLoading: false, refetch: vi.fn(),
    });
    const { container } = show();
    await waitFor(() => expect(screen.getByText(/hidden by suspension/i)).toBeInTheDocument());
    expect(container.textContent).not.toMatch(/cannot be ruled out/i);
  });

  it('does not claim absence before account status has arrived', async () => {
    accountStatus.mockReturnValue({ data: undefined, isError: false, isLoading: true, refetch: vi.fn() });
    show();
    await waitFor(() => expect(screen.getByText(/suspension cannot be ruled out/i)).toBeInTheDocument());
  });

  it('keeps content enforcement available when the relay read was truncated', async () => {
    // A zero count from an unfinished read must not mark the content levers n/a:
    // that tells a moderator an action is unavailable when it may well apply.
    userStats.mockReturnValue(emptyStats({
      relayIncomplete: true,
      authoredContentIncomplete: true,
    }));
    const { container } = show();
    await waitFor(() => expect(screen.getByText(/couldn't load/i)).toBeInTheDocument());
    expect(container.textContent).not.toMatch(/n\/a/i);
  });

  it('marks content enforcement n/a only on a complete read that found nothing', async () => {
    // The contrast case: same zero count, but the read actually finished.
    userStats.mockReturnValue(emptyStats({ relayIncomplete: false }));
    const { container } = show();
    await waitFor(() => expect(screen.getByText(/no content found/i)).toBeInTheDocument());
    expect(container.textContent).toMatch(/n\/a/i);
  });

  it('passes the reported-event error through, so it is not shown as deleted', async () => {
    reportedEvent.mockReturnValue({ data: undefined, isFetching: false, isError: true, refetch: vi.fn() });
    show();
    await waitFor(() => expect(screen.getByText(/couldn't load the reported content/i)).toBeInTheDocument());
  });

  it('passes the in-flight reported-event read through as loading', async () => {
    reportedEvent.mockReturnValue({ data: undefined, isFetching: true, isError: false, refetch: vi.fn() });
    show();
    await waitFor(() => expect(screen.getByText(/loading reported content/i)).toBeInTheDocument());
  });

  it('passes the case subject to the lookup, so the author check can run at all', async () => {
    // The guard is `if (casePubkey && ...)`, so dropping this argument silently
    // disables author verification with no type error and no visible change.
    show();
    await waitFor(() => expect(reportedEvent).toHaveBeenCalled());
    expect(reportedEvent).toHaveBeenCalledWith('report-1', PUBKEY);
  });

  it('normalizes the case pubkey before handing it to the lookups', async () => {
    show();
    await waitFor(() => expect(reportedEvent).toHaveBeenCalled());
    expect(reportedEvent).toHaveBeenCalledWith('report-1', PUBKEY);
  });

  it('marks a claim resting on an unrefreshed status, and offers a retry', async () => {
    // Cached status with a failed refetch. The state stays data-first so this
    // and the panel above agree, but the moderator must be able to see that the
    // answer is not current, and to re-ask.
    accountStatus.mockReturnValue({
      data: { success: true, status: 'active' }, isError: true, isLoading: false, refetch: vi.fn(),
    });
    show();
    await waitFor(() => expect(screen.getByText(/could not be refreshed/i)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('enforces against the normalized pubkey, not the raw one from the report', async () => {
    // The reads and the writes must target the same account. The worker forwards
    // this value verbatim to the relay, which keys on lowercase hex, so a raw
    // mixed-case pubkey would report success while enforcing nothing.
    render(<AgeReviewDetail caseData={makeCase({ state: 'denied_closed' })} />, { wrapper });
    await waitFor(() => expect(screen.getByTestId('user-actions')).toBeInTheDocument());
    expect(screen.getByTestId('user-actions')).toHaveTextContent(PUBKEY);
    expect(screen.getByTestId('user-actions')).not.toHaveTextContent(RAW_PUBKEY);
  });

  it('labels a foreign-authored reported event instead of attributing it', async () => {
    const foreign = {
      id: 'c'.repeat(64), pubkey: 'e'.repeat(64), created_at: 1, kind: 34235,
      tags: [], content: 'clip', sig: '',
    };
    reportedEvent.mockReturnValue({
      data: { status: 'target_foreign', event: foreign, banned: false },
      isFetching: false, isError: false, refetch: vi.fn(),
    });
    show();
    // Evidence is shown, but the attribution warning must come with it.
    await waitFor(() => expect(screen.getByText(/not by this case's subject/i)).toBeInTheDocument());
    expect(screen.getByTestId('media-preview')).toBeInTheDocument();
  });
});
