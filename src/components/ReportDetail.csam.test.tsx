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
const LIST_EVENT = vi.hoisted(() => ({
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
// The decision log the reported list's id returns. Empty by default.
const decisionRows = vi.hoisted(() => ({
  value: [] as { id: number; action: string; reason: string | null; created_at: string }[],
  handling: false,
}));
vi.mock('@/hooks/useDecisionLog', () => ({
  useDecisionLog: () => ({
    hasDecisions: decisionRows.value.length > 0,
    hasHandlingDecisions: decisionRows.handling,
    latestHandlingDecision: decisionRows.handling
      ? decisionRows.value.find(row => !row.action.startsWith('auto_hide_'))
      : undefined,
    isPendingReview: false,
    isDeleted: false,
    isAutoHidden: false,
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
vi.mock('@/hooks/useReportContext', () => ({
  useReportContext: () => ({
    target: reportTarget.value,
    thread: { event: LIST_EVENT.value, ancestors: [], replies: [] },
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

vi.mock('@/components/ThreadContext', () => ({ ThreadContext: () => null }));
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
vi.mock('@/components/ThreadModal', () => ({ ThreadModal: () => null }));
vi.mock('@/components/EventActions', () => ({ EventActions: () => null }));
vi.mock('@/components/UserActions', () => ({
  UserActions: ({ reportCategory }: { reportCategory?: string }) => (
    <div data-testid="user-actions" data-report-category={reportCategory} />
  ),
}));
vi.mock('@/components/BulkDeleteByKind', () => ({ BulkDeleteByKind: () => null }));
vi.mock('@/components/ReporterCard', () => ({ ReporterInline: () => null }));
vi.mock('@/components/UserIdentifier', () => ({ UserIdentifier: () => null }));

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

describe('ReportDetail for an old-build CSAM report', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    status.value = moderationStatusMock({ isUserBanned: false, isEventGone: false });
    decisionRows.value = [];
    decisionRows.handling = false;
  });

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
  beforeEach(() => {
    vi.clearAllMocks();
    status.value = moderationStatusMock({ isUserBanned: false, isEventGone: false });
    decisionRows.value = [];
    decisionRows.handling = false;
  });

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
    expect(screen.queryByText(/Hidden automatically|Not hidden, needs review|Hide not confirmed/)).not.toBeInTheDocument();
    unmount();
    renderWithSwitch({ switchState: 'hide-unconfirmed' });
    expect(screen.queryByText(/Hidden automatically|Not hidden, needs review|Hide not confirmed/)).not.toBeInTheDocument();
  });

  it('shows no switch label outside the switch', () => {
    renderWithSwitch({});
    expect(screen.queryByText(/Hidden automatically|Not hidden, needs review|Hide not confirmed/)).not.toBeInTheDocument();
  });
});
