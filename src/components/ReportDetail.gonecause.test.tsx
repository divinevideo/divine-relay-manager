// ABOUTME: Report detail with the real moderation-status hook and thread panel, for a
// ABOUTME: post the relay won't return: an unknown cause must not read as "deleted".

import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReportDetail } from './ReportDetail';
import type { NostrEvent } from '@nostrify/nostrify';

// The live check that marks a post gone is a public REQ. When the suspended
// list cannot be read, nothing says whether a suspension is hiding the post,
// so the green "Event has been deleted from the relay" would state a removal
// nobody observed.

const REPORTED_PUBKEY = 'd'.repeat(64);
const MOD_PUBKEY = 'e'.repeat(64);
const EVENT_ID = 'c'.repeat(64);

const api = vi.hoisted(() => ({
  deleteEvent: vi.fn(),
  restoreEvent: vi.fn(),
  markAsReviewed: vi.fn(),
  logDecision: vi.fn(),
  deleteDecisions: vi.fn(),
  verifyPubkeyBanned: vi.fn(),
  verifyEventDeleted: vi.fn(),
  listBannedPubkeys: vi.fn(),
  listBannedEvents: vi.fn(),
  listSuspendedPubkeys: vi.fn(),
  // The real useDecisionLog reads through this.
  getDecisions: vi.fn(),
}));

vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()),
  useNavigate: () => vi.fn(),
}));
vi.mock('@/hooks/useAdminApi', () => ({
  useAdminApi: () => api,
  useApiUrl: () => 'https://api.a.example',
}));
vi.mock('@/hooks/useToast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ user: { pubkey: MOD_PUBKEY }, getModeratorPubkey: async () => MOD_PUBKEY }),
}));
vi.mock('@/hooks/useAppContext', () => ({
  useAppContext: () => ({ config: { relayUrl: 'wss://relay.example' } }),
}));
vi.mock('@/hooks/useBannedEvent', () => ({ useBannedEvent: () => ({ data: null, isLoading: false }) }));
vi.mock('@/hooks/useUserSummary', () => ({ useUserSummary: () => ({ data: null, isLoading: false }) }));
vi.mock('@/hooks/useMediaStatus', () => ({ useMediaStatus: () => ({ results: [] }) }));
vi.mock('@/hooks/useAuthor', () => ({ useAuthor: () => ({ data: undefined, isLoading: false }) }));
vi.mock('@/hooks/useReportContext', () => ({
  useReportContext: () => ({
    target: { type: 'event', value: EVENT_ID },
    thread: { event: undefined, ancestors: [], replies: [] },
    threadLoading: false,
    reportedUser: { profile: undefined, pubkey: REPORTED_PUBKEY, isFunnelcakeUser: false },
    userStats: undefined,
    isLoading: false,
    error: null,
    relayHint: undefined,
    reportTags: REPORT.tags,
  }),
}));

vi.mock('@/components/UserProfileCard', () => ({ UserProfileCard: () => null }));
vi.mock('@/components/AISummary', () => ({ AISummary: () => null }));
vi.mock('@/components/HiveAIReport', () => ({ HiveAIReport: () => null }));
vi.mock('@/components/AIDetectionReport', () => ({ AIDetectionReport: () => null }));
vi.mock('@/components/MediaPreview', () => ({ MediaPreview: () => null }));
vi.mock('@/components/ThreadModal', () => ({ ThreadModal: () => null }));
vi.mock('@/components/EventActions', () => ({ EventActions: () => null }));
vi.mock('@/components/UserActions', () => ({ UserActions: () => null }));
vi.mock('@/components/BulkDeleteByKind', () => ({ BulkDeleteByKind: () => null }));
vi.mock('@/components/ReporterCard', () => ({ ReporterInline: () => null }));
vi.mock('@/components/UserIdentifier', () => ({ UserIdentifier: () => null }));

const REPORT: NostrEvent = {
  id: 'f'.repeat(64),
  pubkey: 'a'.repeat(64),
  created_at: 1751000000,
  kind: 1984,
  tags: [['e', EVENT_ID], ['p', REPORTED_PUBKEY]],
  content: 'spam',
  sig: 'b'.repeat(128),
};

function renderDetail() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <ReportDetail report={REPORT} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

const DELETED = 'Event has been deleted from the relay';

describe('ReportDetail missing post, real moderation status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The post is gone from the relay's answer, and neither ban explains it.
    api.verifyEventDeleted.mockResolvedValue(true);
    api.verifyPubkeyBanned.mockResolvedValue(false);
    api.listBannedPubkeys.mockResolvedValue([]);
    api.listBannedEvents.mockResolvedValue([]);
    api.getDecisions.mockResolvedValue([]);
  });

  it('does not call the post deleted when the suspended list could not be read', async () => {
    api.listSuspendedPubkeys.mockRejectedValue(new Error('relay unreachable'));

    renderDetail();

    // The suspended list has one retry (useRelayBanLists), so its failure lands late.
    expect(await screen.findByText(/Couldn't check whether the account is suspended\. That would hide it/, {}, { timeout: 4000 }))
      .toBeInTheDocument();
    expect(screen.queryByText(DELETED)).not.toBeInTheDocument();

    const badge = screen.getAllByText('Not Found on Relay').find(el => el.classList.contains('cursor-help'));
    expect(badge).toBeDefined();
    fireEvent.focus(badge!);
    expect((await screen.findByRole('tooltip')).textContent).toMatch(/Couldn't check whether the account is suspended\. That would hide it/);
  });

  it('names the suspension when the suspended list says so', async () => {
    api.listSuspendedPubkeys.mockResolvedValue([{ pubkey: REPORTED_PUBKEY }]);

    renderDetail();

    expect(await screen.findByText(/The reported account is suspended/, {}, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.queryByText(DELETED)).not.toBeInTheDocument();
  });

  // Funnelcake also withholds quarantined posts and deactivated or vanished
  // accounts, which no list here reports, so this is not "deleted" either.
  it('does not call the post deleted even when every list answered and none explains it', async () => {
    api.listSuspendedPubkeys.mockResolvedValue([]);

    renderDetail();

    expect(await screen.findByText(/held for review/, {}, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.queryByText(DELETED)).not.toBeInTheDocument();
  });

  // The decision log is the only source for a recorded delete. A read still
  // out, or one that failed, is not "nothing recorded".
  it('says still checking while the decision read is out', async () => {
    api.listSuspendedPubkeys.mockResolvedValue([]);
    api.getDecisions.mockImplementation(() => new Promise(() => {}));

    renderDetail();

    expect(await screen.findByText(/Still checking whether a moderator removed it/, {}, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.queryByText(DELETED)).not.toBeInTheDocument();
  });

  it('calls the cause unknown when the decision read failed', async () => {
    api.listSuspendedPubkeys.mockResolvedValue([]);
    api.getDecisions.mockRejectedValue(new Error('worker unreachable'));

    renderDetail();

    expect(await screen.findByText(/Couldn't check whether a moderator removed it/, {}, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.queryByText(DELETED)).not.toBeInTheDocument();
  });

  // The banned-events list keeps a positive after a failed refresh. That kept
  // ban is last known, so it must not explain the post as removed.
  it('stops calling the post deleted once the event-ban refresh fails', async () => {
    api.listSuspendedPubkeys.mockResolvedValue([]);
    // Answers until the refresh below; the auto-check re-reads it too.
    api.listBannedEvents.mockResolvedValue([{ id: EVENT_ID }]);

    renderDetail();
    // A confirmed event ban is a hide, not a deletion.
    expect(await screen.findByText("The event is in the relay's ban list", {}, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.queryByText(DELETED)).not.toBeInTheDocument();

    api.listBannedEvents.mockRejectedValue(new Error('relay unreachable'));
    fireEvent.click(screen.getByRole('button', { name: /Re-check/ }));

    expect(await screen.findByText(/Couldn't check whether the event is still banned, as it was at the last good read/, {}, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.queryByText(DELETED)).not.toBeInTheDocument();
  });
});
