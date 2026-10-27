// ABOUTME: Pins that an old-build CSAM report (NIP-56 'illegal' plus a Reason line) gates media,
// ABOUTME: styles the header as high priority, and that age review reads the worker's category.

import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReportDetail } from './ReportDetail';
import type { NostrEvent } from '@nostrify/nostrify';
import type { ModerationStatus } from '@/hooks/useModerationStatus';
import { moderationStatusMock } from '@/test/moderationStatusMock';

const REPORTED_PUBKEY = 'd'.repeat(64);
const MOD_PUBKEY = 'e'.repeat(64);
const REPORTED_EVENT = vi.hoisted(() => ({
  value: {
    id: 'c'.repeat(64),
    pubkey: 'd'.repeat(64),
    created_at: 1751000000,
    kind: 1,
    tags: [],
    content: 'clip https://example.invalid/clip.mp4',
    sig: 'b'.repeat(128),
  } as NostrEvent,
}));

// Set in beforeEach; tests change single fields.
const status = vi.hoisted(() => ({ value: {} as ModerationStatus }));

vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()),
  useNavigate: () => vi.fn(),
}));
vi.mock('@/hooks/useAdminApi', () => ({
  useAdminApi: () => ({
    deleteEvent: vi.fn(),
    restoreEvent: vi.fn(),
    markAsReviewed: vi.fn(),
    logDecision: vi.fn(),
    deleteDecisions: vi.fn(),
  }),
}));
vi.mock('@/hooks/useToast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ user: { pubkey: MOD_PUBKEY }, getModeratorPubkey: async () => MOD_PUBKEY }),
}));
vi.mock('@/hooks/useAppContext', () => ({
  useAppContext: () => ({ config: { relayUrl: 'wss://relay.example' } }),
}));
// The decision log the reported event's id returns. Empty by default.
const decisionRows = vi.hoisted(() => ({
  value: [] as { id: number; action: string; reason: string | null; created_at: string }[],
  handling: false,
  pending: false,
  restoreFailed: false,
  unresolved: false,
}));
vi.mock('@/hooks/useDecisionLog', () => ({
  useDecisionLog: () => ({
    hasDecisions: decisionRows.value.length > 0,
    hasHandlingDecisions: decisionRows.handling,
    latestHandlingDecision: decisionRows.handling
      ? decisionRows.value.find(row => !row.action.startsWith('auto_hide_'))
      : undefined,
    isPendingReview: decisionRows.pending,
    isAutoHideRestoreFailed: decisionRows.restoreFailed,
    isAutoHideUnresolved: decisionRows.unresolved,
    isDeleted: false,
    isAutoHidden: decisionRows.pending,
    isAutoHideRestored: false,
    decisions: decisionRows.value,
    latestDecision: decisionRows.value[0] ?? null,
    refetch: vi.fn(),
  }),
}));
vi.mock('@/hooks/useModerationStatus', () => ({
  useModerationStatus: () => status.value,
}));
vi.mock('@/hooks/useBannedEvent', () => ({ useBannedEvent: () => ({ data: null, isLoading: false }) }));
vi.mock('@/hooks/useUserSummary', () => ({ useUserSummary: () => ({ data: null, isLoading: false }) }));
vi.mock('@/hooks/useMediaStatus', () => ({ useMediaStatus: () => ({}) }));

const reportTarget = vi.hoisted(() => ({
  value: { type: 'event', value: 'c'.repeat(64) } as { type: string; value: string },
}));
// Extra thread fields, so a test can make the reported event a repost.
const threadExtra = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock('@/hooks/useReportContext', () => ({
  useReportContext: () => ({
    target: reportTarget.value,
    thread: { event: REPORTED_EVENT.value, ancestors: [], replies: [], ...threadExtra.value },
    threadLoading: false,
    reportedUser: { profile: undefined, pubkey: REPORTED_PUBKEY, isFunnelcakeUser: false },
    userStats: undefined,
    reporter: { profile: undefined, pubkey: 'a'.repeat(64), reportCount: 0, isFunnelcakeUser: false },
    isLoading: false,
    error: null,
    relayHint: undefined,
    reportTags: [],
  }),
}));

vi.mock('@/components/ThreadContext', () => ({
  ThreadContext: ({ hideAvatars }: { hideAvatars?: boolean }) => (
    <div data-testid="thread" data-hide-avatars={String(hideAvatars)} />
  ),
}));
vi.mock('@/components/UserProfileCard', () => ({
  UserProfileCard: ({ hideMediaByDefault }: { hideMediaByDefault?: boolean }) => (
    <div data-testid="profile-card" data-hide={String(hideMediaByDefault)} />
  ),
}));
vi.mock('@/components/AISummary', () => ({ AISummary: () => null }));
vi.mock('@/components/HiveAIReport', () => ({ HiveAIReport: () => null }));
vi.mock('@/components/AIDetectionReport', () => ({ AIDetectionReport: () => null }));
// Stand-in that exposes showByDefault, so no media is ever loaded or fetched.
vi.mock('@/components/MediaPreview', () => ({
  MediaPreview: ({ showByDefault }: { showByDefault?: boolean }) => (
    <div data-testid="media" data-show={String(showByDefault)} />
  ),
}));
vi.mock('@/components/ThreadModal', () => ({
  ThreadModal: ({ hideAvatars }: { hideAvatars?: boolean }) => (
    <div data-testid="thread-modal" data-hide-avatars={String(hideAvatars)} />
  ),
}));
vi.mock('@/components/EventActions', () => ({ EventActions: () => null }));
vi.mock('@/components/UserActions', () => ({
  UserActions: ({ reportCategory }: { reportCategory?: string }) => (
    <div data-testid="user-actions" data-report-category={reportCategory} />
  ),
}));
vi.mock('@/components/BulkDeleteByKind', () => ({ BulkDeleteByKind: () => null }));
vi.mock('@/components/ReporterCard', () => ({ ReporterInline: () => null }));
vi.mock('@/components/UserIdentifier', () => ({
  UserIdentifier: ({ pubkey, hideAvatarImage }: { pubkey: string; hideAvatarImage?: boolean }) => (
    <div data-testid={`identifier-${pubkey}`} data-hide-avatar={String(hideAvatarImage)} />
  ),
}));

const E = 'c'.repeat(64);
const P = REPORTED_PUBKEY;

function makeReport(tags: string[][], content: string): NostrEvent {
  return { id: 'f'.repeat(64), pubkey: 'a'.repeat(64), created_at: 1751000000, kind: 1984, tags, content, sig: 'b'.repeat(128) };
}
const OLD_BUILD = makeReport(
  [['e', E, 'illegal'], ['p', P, 'illegal'], ['client', 'diVine']],
  'CONTENT REPORT - NIP-56\nReason: csam\nDetails: x\n',
);
const PLAIN_ILLEGAL = makeReport([['e', E, 'illegal'], ['p', P, 'illegal']], 'bad');

function renderDetail(report: NostrEvent, allReportsForTarget: NostrEvent[] | null = [report]) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <ReportDetail report={report} allReportsForTarget={allReportsForTarget ?? undefined} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  status.value = moderationStatusMock({ isUserBanned: false, isEventGone: false });
  decisionRows.value = [];
  decisionRows.handling = false;
  decisionRows.pending = false;
  decisionRows.restoreFailed = false;
  decisionRows.unresolved = false;
  threadExtra.value = {};
});

describe('ReportDetail for an old-build CSAM report', () => {
  it('hides media by default', () => {
    renderDetail(OLD_BUILD);
    expect(screen.getAllByTestId('media').every(m => m.dataset.show === 'false')).toBe(true);
  });

  it('hides the reported account images by default', () => {
    renderDetail(OLD_BUILD);
    expect(screen.getByTestId('profile-card').dataset.hide).toBe('true');
  });

  it('shows the reported account images for a bare illegal report (control)', () => {
    renderDetail(PLAIN_ILLEGAL);
    expect(screen.getByTestId('profile-card').dataset.hide).toBe('false');
  });

  it('hides the reported account images while the report set is still loading', () => {
    renderDetail(PLAIN_ILLEGAL, null);
    expect(screen.getByTestId('profile-card').dataset.hide).toBe('true');
  });

  it('shows media by default for a bare illegal report (control)', () => {
    renderDetail(PLAIN_ILLEGAL);
    expect(screen.getAllByTestId('media').every(m => m.dataset.show === 'true')).toBe(true);
  });

  it('styles the header category badge as high priority, not the illegal control', () => {
    const { unmount } = renderDetail(OLD_BUILD, [PLAIN_ILLEGAL]);
    expect(screen.getAllByText('Illegal')[0].className).toContain('bg-destructive');
    unmount();
    renderDetail(PLAIN_ILLEGAL);
    expect(screen.getAllByText('Illegal')[0].className).not.toContain('bg-destructive');
  });

  it('hands age review the worker category, not the display category', () => {
    // The display category prefers the high-priority Divine label; the worker
    // (and so age review) takes the first one.
    const report = makeReport(
      [['p', P], ['l', 'NS-spam', 'social.nos.ontology'], ['l', 'NS-underageUser', 'social.nos.ontology']],
      '',
    );
    renderDetail(report);
    expect(screen.getByTestId('user-actions')).toHaveAttribute('data-report-category', 'NS-spam');
  });
});

describe('ReportDetail switch label', () => {
  function renderWithSwitch(props: Partial<Parameters<typeof ReportDetail>[0]>) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={qc}>
        <TooltipProvider>
          <ReportDetail report={OLD_BUILD} allReportsForTarget={[OLD_BUILD]} {...props} />
        </TooltipProvider>
      </QueryClientProvider>,
    );
  }

  it('labels a not-hidden target the way its queue row is labelled', () => {
    renderWithSwitch({ switchState: 'not-hidden' });
    expect(screen.getByText('Not hidden, needs review')).toBeInTheDocument();
  });

  // The pane's own auto-hide banner and badge already describe these states,
  // so a second badge would only duplicate or contradict them.
  it('adds no switch badge for an auto-hidden target', () => {
    const { unmount } = renderWithSwitch({ switchState: 'auto-hidden' });
    expect(screen.queryByText(/Hidden automatically|Not hidden, needs review|Hidden, needs a check/)).not.toBeInTheDocument();
    unmount();
    renderWithSwitch({ switchState: 'hidden-needs-check' });
    expect(screen.queryByText(/Hidden automatically|Not hidden, needs review|Hidden, needs a check/)).not.toBeInTheDocument();
  });

  it('shows no switch label outside the switch', () => {
    renderWithSwitch({});
    expect(screen.queryByText(/Hidden automatically|Not hidden, needs review|Hidden, needs a check/)).not.toBeInTheDocument();
  });
});

describe('ReportDetail on a sensitive report, elsewhere in the pane', () => {
  const ORIGINAL_AUTHOR = '9'.repeat(64);
  const SPAM = makeReport([['e', E, 'spam'], ['p', P, 'spam']], 'buy now');

  function makeRepost() {
    threadExtra.value = {
      isRepost: true,
      repostedEvent: { ...REPORTED_EVENT.value, id: '8'.repeat(64), pubkey: ORIGINAL_AUTHOR },
    };
  }

  it('withholds thread participant avatars on a CSAM report', () => {
    renderDetail(OLD_BUILD);
    expect(screen.getByTestId('thread').dataset.hideAvatars).toBe('true');
  });

  it('loads thread participant avatars on a bare illegal report (control)', () => {
    renderDetail(PLAIN_ILLEGAL);
    expect(screen.getByTestId('thread').dataset.hideAvatars).toBe('false');
  });

  it('withholds avatars in the full-thread view on a CSAM report', () => {
    renderDetail(OLD_BUILD);
    expect(screen.getByTestId('thread-modal').dataset.hideAvatars).toBe('true');
  });

  it('loads avatars in the full-thread view on a spam report once its reports have loaded (control)', () => {
    renderDetail(SPAM);
    expect(screen.getByTestId('thread-modal').dataset.hideAvatars).toBe('false');
  });

  it('withholds avatars in the full-thread view while the report set is still loading', () => {
    renderDetail(SPAM, null);
    expect(screen.getByTestId('thread-modal').dataset.hideAvatars).toBe('true');
  });

  it("withholds a repost's original author avatar on a CSAM report", () => {
    makeRepost();
    renderDetail(OLD_BUILD);
    expect(screen.getByTestId(`identifier-${ORIGINAL_AUTHOR}`).dataset.hideAvatar).toBe('true');
  });

  it("loads a repost's original author avatar on a bare illegal report (control)", () => {
    makeRepost();
    renderDetail(PLAIN_ILLEGAL);
    expect(screen.getByTestId(`identifier-${ORIGINAL_AUTHOR}`).dataset.hideAvatar).toBe('false');
  });

  // The selected report is the newest; an older report on the same target is
  // the one carrying the CSAM signal. The queue row goes red on any report.
  it('styles the header badge as high priority when an older report on the target signals CSAM', () => {
    renderDetail(SPAM, [SPAM, OLD_BUILD]);
    expect(screen.getAllByText('Spam')[0].className).toContain('bg-destructive');
  });

  it('keeps the header badge plain when no report on the target signals CSAM (control)', () => {
    renderDetail(SPAM, [SPAM, PLAIN_ILLEGAL]);
    expect(screen.getAllByText('Spam')[0].className).not.toContain('bg-destructive');
  });

  function renderPending(switchState?: Parameters<typeof ReportDetail>[0]['switchState']) {
    decisionRows.pending = true;
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={qc}>
        <TooltipProvider>
          <ReportDetail report={OLD_BUILD} allReportsForTarget={[OLD_BUILD]} switchState={switchState} />
        </TooltipProvider>
      </QueryClientProvider>,
    );
  }

  // The pane reads the hide's state from its own decision log, so the switch
  // state (from /api/resolution-state) is left undefined: it may still be
  // loading, or have failed. The worker writes the two states that need a
  // check only after the relay ban landed, so both say the content is hidden.
  it('says an unresolved hide is hidden, and that the restore check failed', () => {
    decisionRows.unresolved = true;
    renderPending(undefined);
    expect(screen.getByText('Auto-Hidden — Restore Check Failed')).toBeInTheDocument();
    expect(screen.getByText('This content was hidden automatically, but the worker could not check whether a moderator restored it at the same time. Review and confirm or restore.')).toBeInTheDocument();
    expect(screen.queryByText('Auto-Hidden — Pending Review')).not.toBeInTheDocument();
    // The header badge beside the banner agrees with the queue row.
    expect(screen.getByText('Hidden, needs a check')).toBeInTheDocument();
    expect(screen.queryByText('Hidden automatically')).not.toBeInTheDocument();
  });

  it('says a failed restore left the content hidden, and to retry restoring it', () => {
    decisionRows.restoreFailed = true;
    renderPending(undefined);
    expect(screen.getByText('Auto-Hidden — Restore Failed')).toBeInTheDocument();
    expect(screen.getByText('A moderator restored this while it was being hidden automatically, and undoing the hide failed. Retry restoring this content.')).toBeInTheDocument();
    expect(screen.queryByText('Auto-Hidden — Pending Review')).not.toBeInTheDocument();
    expect(screen.getByText('Hidden, needs a check')).toBeInTheDocument();
    expect(screen.queryByText('Hidden automatically')).not.toBeInTheDocument();
  });

  it("labels a plain auto-hide as pending review, with the queue row's badge (control)", () => {
    renderPending(undefined);
    expect(screen.getByText('Auto-Hidden — Pending Review')).toBeInTheDocument();
    expect(screen.getByText('This content was automatically hidden based on a report. Please review and confirm or restore.')).toBeInTheDocument();
    expect(screen.getByText('Hidden automatically')).toBeInTheDocument();
    expect(screen.queryByText(/needs a check|Restore Check Failed|Restore Failed/)).not.toBeInTheDocument();
  });

  // All three states leave the event banned on the relay, which shows a second
  // header badge, worded like the first. A plain auto-hide's first badge says
  // "Hidden automatically" too, so that one shows the words twice.
  it.each([
    ['a plain auto-hide', null, 2],
    ['an unresolved hide', 'unresolved', 1],
    ['a hide whose restore failed', 'restoreFailed', 1],
  ] as const)('calls %s Hidden automatically when the event is gone, not Not Found on Relay', (_label, flag, count) => {
    if (flag) decisionRows[flag] = true;
    status.value = moderationStatusMock({ isUserBanned: false, isEventGone: true });
    renderPending(undefined);
    expect(screen.getAllByText('Hidden automatically')).toHaveLength(count);
    expect(screen.queryByText('Auto-Hidden')).not.toBeInTheDocument();
    expect(screen.queryByText('Not Found on Relay')).not.toBeInTheDocument();
  });

  it('calls an unresolved hide Hidden automatically for a banned user too, as it does a plain one', () => {
    decisionRows.unresolved = true;
    status.value = moderationStatusMock({ isUserBanned: true, isEventGone: true });
    renderPending(undefined);
    expect(screen.getByText('Hidden, needs a check')).toBeInTheDocument();
    expect(screen.getByText('Hidden automatically')).toBeInTheDocument();
    // The account's own badge still names the ban.
    expect(screen.getByText('User Banned')).toBeInTheDocument();
  });
});
