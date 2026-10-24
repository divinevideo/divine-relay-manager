// ABOUTME: Pins how a reported video's own thumbnail reaches the single-post
// ABOUTME: media buttons: listed apart from the video, and never driving which buttons show.

import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReportDetail } from './ReportDetail';
import type { NostrEvent } from '@nostrify/nostrify';
import { moderationStatusMock } from '@/test/moderationStatusMock';

const REPORTED_PUBKEY = 'd'.repeat(64);
const MOD_PUBKEY = 'e'.repeat(64);
// Full-length 64-char hex hashes, never truncated.
const VIDEO = '81661ca024bec2be842557ff7e07c833660038f134203f10293568f5ea11863f';
const THUMB = 'b06e68dbec25463be257e44b06b0bcbb376d3cd1d5fa47e41747ead9e290e068';
const OTHER_VIDEO = 'c3d0f1a2b4e5968778695a4b3c2d1e0f9a8b7c6d5e4f30211203f4e5d6c7b8a9';
const VIDEO_EVENT_ID = 'c'.repeat(64);
const VIDEO_EVENT = vi.hoisted(() => ({
  value: {
    id: 'c'.repeat(64),
    pubkey: 'd'.repeat(64),
    created_at: 1751000000,
    kind: 34236,
    // The shape divine-mobile publishes (video_imeta_builder.dart).
    tags: [
      ['d', 'clip'],
      ['imeta',
        'url https://media.divine.video/81661ca024bec2be842557ff7e07c833660038f134203f10293568f5ea11863f',
        'm video/mp4',
        'image https://media.divine.video/b06e68dbec25463be257e44b06b0bcbb376d3cd1d5fa47e41747ead9e290e068',
        'x 81661ca024bec2be842557ff7e07c833660038f134203f10293568f5ea11863f'],
    ],
    content: '',
    sig: 'b'.repeat(128),
  } as NostrEvent,
}));

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
// No decisions on the reported video.
vi.mock('@/hooks/useDecisionLog', () => ({
  useDecisionLog: () => ({
    hasDecisions: false,
    hasHandlingDecisions: false,
    latestHandlingDecision: undefined,
    isPendingReview: false,
    isDeleted: false,
    isAutoHidden: false,
    isAutoHideRestored: false,
    decisions: [],
    latestDecision: null,
    refetch: vi.fn(),
  }),
}));
vi.mock('@/hooks/useModerationStatus', () => ({
  useModerationStatus: () => moderationStatusMock({ isUserBanned: false, isEventGone: false }),
}));
vi.mock('@/hooks/useBannedEvent', () => ({ useBannedEvent: () => ({ data: null, isLoading: false }) }));
vi.mock('@/hooks/useUserSummary', () => ({ useUserSummary: () => ({ data: null, isLoading: false }) }));
const mediaStatusLoading = vi.hoisted(() => ({ loading: false, fetching: false, paused: false }));
const mediaStatusCalls = vi.hoisted(() => ({ value: [] as string[][] }));
// The thumbnail alone is restricted, as if it had been gated separately.
vi.mock('@/hooks/useMediaStatus', () => ({
  useMediaStatus: (hashes: string[]) => {
    mediaStatusCalls.value.push(hashes);
    return {
      results: hashes.map(hash => ({
        hash,
        isBlocked: false,
        isRestricted: hash === 'b06e68dbec25463be257e44b06b0bcbb376d3cd1d5fa47e41747ead9e290e068',
      })),
      // As in TanStack v5: a first load is pending and fetching; one held back
      // offline is pending but not fetching.
      isLoading: mediaStatusLoading.loading,
      isPending: mediaStatusLoading.loading || mediaStatusLoading.paused,
      isFetching: mediaStatusLoading.loading || mediaStatusLoading.fetching,
    };
  },
}));

// When set, the report is on a kind 6 repost whose content is the video's JSON.
// Unresolved, useThread found no original for it (repostedEvent null).
const repost = vi.hoisted(() => ({ value: null as NostrEvent | null, resolved: true }));
vi.mock('@/hooks/useReportContext', () => ({
  useReportContext: () => ({
    target: { type: 'event', value: VIDEO_EVENT_ID },
    thread: repost.value
      ? { event: repost.value, repostedEvent: repost.resolved ? VIDEO_EVENT.value : null, ancestors: [], replies: [] }
      : { event: VIDEO_EVENT.value, ancestors: [], replies: [] },
    threadLoading: false,
    reportedUser: { profile: undefined, pubkey: REPORTED_PUBKEY, isFunnelcakeUser: false },
    userStats: undefined,
    reporter: { profile: undefined, pubkey: 'a'.repeat(64), reportCount: 0, isFunnelcakeUser: false },
    isLoading: false,
    error: null,
    relayHint: undefined,
    reportTags: REPORT.tags,
  }),
}));

vi.mock('@/components/ThreadContext', () => ({ ThreadContext: () => null }));
vi.mock('@/components/UserProfileCard', () => ({ UserProfileCard: () => null }));
vi.mock('@/components/AISummary', () => ({ AISummary: () => null }));
vi.mock('@/components/HiveAIReport', () => ({ HiveAIReport: () => null }));
vi.mock('@/components/AIDetectionReport', () => ({ AIDetectionReport: () => null }));
vi.mock('@/components/MediaPreview', () => ({ MediaPreview: () => null }));
vi.mock('@/components/ThreadModal', () => ({ ThreadModal: () => null }));
const eventActionsProps = vi.hoisted(() => ({ value: null as Record<string, unknown> | null }));
vi.mock('@/components/EventActions', () => ({
  EventActions: (props: Record<string, unknown>) => {
    eventActionsProps.value = props;
    return null;
  },
}));
vi.mock('@/components/UserActions', () => ({ UserActions: () => null }));
vi.mock('@/components/BulkDeleteByKind', () => ({ BulkDeleteByKind: () => null }));
vi.mock('@/components/ReporterCard', () => ({ ReporterInline: () => null }));
vi.mock('@/components/UserIdentifier', () => ({ UserIdentifier: () => null }));

const REPORT: NostrEvent = {
  id: 'f'.repeat(64),
  pubkey: 'a'.repeat(64),
  created_at: 1751000000,
  kind: 1984,
  tags: [['e', VIDEO_EVENT_ID], ['p', REPORTED_PUBKEY]],
  content: 'harassment',
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

describe('ReportDetail for a reported video with its own thumbnail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mediaStatusCalls.value = [];
    eventActionsProps.value = null;
    repost.value = null;
    repost.resolved = true;
    mediaStatusLoading.loading = false;
    mediaStatusLoading.fetching = false;
    mediaStatusLoading.paused = false;
  });

  it('tells the buttons while a first load is held back offline, with no status yet', () => {
    mediaStatusLoading.paused = true;
    renderDetail();

    expect(eventActionsProps.value).toMatchObject({ mediaStatusLoading: true });
  });

  it('lets the buttons go once the status has answered', () => {
    renderDetail();

    expect(eventActionsProps.value).toMatchObject({ mediaStatusLoading: false });
  });

  it('tells the buttons while a re-check runs, with the old status still showing', () => {
    // After an action the status is fetched again, and until it answers the
    // screen still has the old one: a file just blocked reads as open.
    mediaStatusLoading.fetching = true;
    renderDetail();

    expect(eventActionsProps.value).toMatchObject({ mediaStatusLoading: true });
  });

  it('tells the buttons while the media status check has not answered', () => {
    mediaStatusLoading.loading = true;
    renderDetail();

    expect(eventActionsProps.value).toMatchObject({ mediaStatusLoading: true });
  });

  it("reads a repost's files from the original, not from the repost's JSON text", () => {
    // A kind 6 repost carries the original event as JSON. Scanning that text
    // picked up the original's id and author key as "files", and the video's
    // thumbnail as media, so Age Restrict failed on the first call.
    repost.value = {
      id: '9'.repeat(64),
      pubkey: '8'.repeat(64),
      created_at: 1751000100,
      kind: 6,
      tags: [['e', VIDEO_EVENT_ID], ['p', REPORTED_PUBKEY]],
      content: JSON.stringify(VIDEO_EVENT.value),
      sig: 'b'.repeat(128),
    };

    renderDetail();

    expect(eventActionsProps.value).toMatchObject({ mediaHashes: [VIDEO], thumbnailHashes: [THUMB] });
  });

  it("reads an unresolved repost's files from its content, not from its JSON text", () => {
    // useThread had no original for it: a banned repost shown from the ban list,
    // or one whose e-tag fetch missed. The repost still carries it as JSON.
    repost.resolved = false;
    repost.value = {
      id: '9'.repeat(64),
      pubkey: '8'.repeat(64),
      created_at: 1751000100,
      kind: 6,
      tags: [['e', VIDEO_EVENT_ID], ['p', REPORTED_PUBKEY]],
      content: JSON.stringify(VIDEO_EVENT.value),
      sig: 'b'.repeat(128),
    };

    renderDetail();

    expect(eventActionsProps.value).toMatchObject({ mediaHashes: [VIDEO], thumbnailHashes: [THUMB] });
  });

  it.each([
    ['an object that is not an event', JSON.stringify({ id: VIDEO_EVENT_ID, pubkey: REPORTED_PUBKEY })],
    ['cut off', `{"id":"${VIDEO_EVENT_ID}","pubkey":"${REPORTED_PUBKEY}"`],
    ['an array', JSON.stringify([VIDEO_EVENT_ID, REPORTED_PUBKEY])],
  ])('reads no files from the text of a repost whose content is JSON %s', (_, content) => {
    repost.resolved = false;
    repost.value = {
      id: '9'.repeat(64),
      pubkey: '8'.repeat(64),
      created_at: 1751000100,
      kind: 6,
      tags: [['e', VIDEO_EVENT_ID], ['p', REPORTED_PUBKEY]],
      content,
      sig: 'b'.repeat(128),
    };

    renderDetail();

    expect(eventActionsProps.value).toMatchObject({ mediaHashes: [], thumbnailHashes: [] });
  });

  it.each([
    ['unresolved', false, [OTHER_VIDEO], []],
    ['resolved', true, [VIDEO, OTHER_VIDEO], [THUMB]],
  ])('still reads the media of a %s repost whose content is plain text', (_, resolved, media, thumbnails) => {
    // Out of spec, but some reposts carry a media URL as text, and the post
    // preview shows it, so the buttons must reach it too.
    repost.resolved = resolved;
    repost.value = {
      id: '9'.repeat(64),
      pubkey: '8'.repeat(64),
      created_at: 1751000100,
      kind: 6,
      tags: [['e', VIDEO_EVENT_ID], ['p', REPORTED_PUBKEY]],
      content: `https://media.divine.video/${OTHER_VIDEO}.mp4`,
      sig: 'b'.repeat(128),
    };

    renderDetail();

    expect(eventActionsProps.value).toMatchObject({ mediaHashes: media, thumbnailHashes: thumbnails });
  });

  it('hands the buttons the video and its thumbnail separately', () => {
    renderDetail();

    expect(eventActionsProps.value).toMatchObject({ mediaHashes: [VIDEO], thumbnailHashes: [THUMB] });
  });

  it('checks the thumbnail status too, so the undo buttons can reach it', () => {
    renderDetail();

    expect(mediaStatusCalls.value.at(-1)).toEqual([VIDEO, THUMB]);
    expect(eventActionsProps.value?.mediaHashStatuses).toEqual([
      { hash: VIDEO, isBlocked: false, isRestricted: false },
      { hash: THUMB, isBlocked: false, isRestricted: true },
    ]);
  });

  it('shows the buttons for the video, not for a thumbnail restricted on its own', () => {
    renderDetail();

    expect(eventActionsProps.value).toMatchObject({ hasRestrictedMedia: false, hasBlockedMedia: false });
  });
});
