// ABOUTME: Pins how a reported video's own thumbnail reaches the single-post
// ABOUTME: media buttons: listed apart from the video, and never driving which buttons show.

import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReportDetail } from './ReportDetail';
import type { NostrEvent } from '@nostrify/nostrify';
import { moderationStatusMock } from '@/test/moderationStatusMock';
import { SIGNED_NOTE, SIGNED_VIDEO } from '@/test/signedEvents';

// nostr-tools cannot verify under jsdom; this accepts exactly the pre-signed fixtures.
vi.mock('nostr-tools', async (importOriginal) => {
  const { verifyKnownSignedEvent } = await import('@/test/signedEvents');
  return { ...(await importOriginal<typeof import('nostr-tools')>()), verifyEvent: verifyKnownSignedEvent };
});

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
  useCurrentUser: () => ({ user: { pubkey: MOD_PUBKEY }, getModeratorToken: () => 'moderator-login-token' }),
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
const mediaStatusLoading = vi.hoisted(() => ({ loading: false, fetching: false, paused: false, pausedRecheck: false }));
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
      // offline is pending but not fetching; a re-check held back offline, with
      // the old status cached, is neither pending nor fetching, only paused.
      isLoading: mediaStatusLoading.loading,
      isPending: mediaStatusLoading.loading || mediaStatusLoading.paused,
      isFetching: mediaStatusLoading.loading || mediaStatusLoading.fetching,
      isPaused: mediaStatusLoading.paused || mediaStatusLoading.pausedRecheck,
    };
  },
}));

// When set, the report is on a kind 6 repost whose content is the video's JSON.
// Unresolved, useThread found no original for it (repostedEvent null).
const repost = vi.hoisted(() => ({ value: null as NostrEvent | null, resolved: true, original: null as NostrEvent | null }));
vi.mock('@/hooks/useReportContext', () => ({
  useReportContext: () => ({
    target: { type: 'event', value: VIDEO_EVENT_ID },
    thread: repost.value
      ? { event: repost.value, repostedEvent: repost.resolved ? (repost.original ?? VIDEO_EVENT.value) : null, ancestors: [], replies: [] }
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

// The account-type label has its own tests; here it would need the account-status query.
vi.mock('@/components/AccountTypeBadge', () => ({ AccountTypeLabel: () => null }));
vi.mock('@/components/ThreadContext', () => ({ ThreadContext: () => null }));
vi.mock('@/components/UserProfileCard', () => ({ UserProfileCard: () => null }));
vi.mock('@/components/AISummary', () => ({ AISummary: () => null }));
vi.mock('@/components/HiveAIReport', () => ({ HiveAIReport: () => null }));
vi.mock('@/components/AIDetectionReport', () => ({ AIDetectionReport: () => null }));
// Records each event a media preview is given, so a test can see what the
// moderator would be shown.
const previewedEvents = vi.hoisted(() => ({ value: [] as NostrEvent[] }));
vi.mock('@/components/MediaPreview', () => ({
  MediaPreview: ({ event }: { event: NostrEvent }) => {
    previewedEvents.value.push(event);
    return null;
  },
}));
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
    previewedEvents.value = [];
    repost.value = null;
    repost.resolved = true;
    repost.original = null;
    mediaStatusLoading.loading = false;
    mediaStatusLoading.fetching = false;
    mediaStatusLoading.paused = false;
    mediaStatusLoading.pausedRecheck = false;
  });

  it('tells the buttons while a re-check is held back offline, with the old status still showing', () => {
    // An action's re-check that goes offline pauses with the old status
    // cached: neither pending nor fetching. A click then would queue an
    // action on that old status, to run when the connection returns.
    mediaStatusLoading.pausedRecheck = true;
    renderDetail();

    expect(eventActionsProps.value).toMatchObject({ mediaStatusLoading: true });
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

  it("reads an unresolved repost's files from its copy of the original when the copy checks out", () => {
    // useThread had no original for it: a banned repost shown from the ban list,
    // or one whose e-tag fetch missed. The repost still carries it as JSON, and
    // the copy is the signed event its e tag names.
    repost.resolved = false;
    repost.value = {
      id: '9'.repeat(64),
      pubkey: '8'.repeat(64),
      created_at: 1751000100,
      kind: 6,
      tags: [['e', SIGNED_VIDEO.id], ['p', SIGNED_VIDEO.pubkey]],
      content: JSON.stringify(SIGNED_VIDEO),
      sig: 'b'.repeat(128),
    };

    renderDetail();

    expect(eventActionsProps.value).toMatchObject({ mediaHashes: [VIDEO], thumbnailHashes: [THUMB] });
    // The repost card previews the same checked original the buttons act on.
    expect(previewedEvents.value.some((event) => event.id === SIGNED_VIDEO.id)).toBe(true);
  });

  it.each([
    ['is not signed', JSON.stringify({ ...SIGNED_VIDEO, sig: undefined }), SIGNED_VIDEO.id],
    ['has its files changed', JSON.stringify({ ...SIGNED_VIDEO, tags: [['imeta', `url https://media.divine.video/${OTHER_VIDEO}`, 'm video/mp4']] }), SIGNED_VIDEO.id],
    ['is not the event the repost names', JSON.stringify(SIGNED_VIDEO), VIDEO_EVENT_ID],
    ['is malformed, with no string content', JSON.stringify({ ...SIGNED_VIDEO, content: 5, tags: [['imeta', `url https://media.divine.video/${OTHER_VIDEO}`, 'm video/mp4']] }), SIGNED_VIDEO.id],
    ['is cut off', JSON.stringify({ ...SIGNED_VIDEO, tags: [['imeta', `url https://media.divine.video/${OTHER_VIDEO}`, 'm video/mp4']] }).slice(0, -1), SIGNED_VIDEO.id],
  ])("offers none of an unresolved repost's files, and says why, when its copy %s", (_, content, target) => {
    // The copy is the reposter's writing (#337): unchecked, it would let them
    // choose which files the buttons act on, Delete Media included.
    repost.resolved = false;
    repost.value = {
      id: '9'.repeat(64),
      pubkey: '8'.repeat(64),
      created_at: 1751000100,
      kind: 6,
      tags: [['e', target], ['p', REPORTED_PUBKEY]],
      content,
      sig: 'b'.repeat(128),
    };

    renderDetail();

    expect(eventActionsProps.value).toMatchObject({ mediaHashes: [], thumbnailHashes: [] });
    expect(screen.getByText(/No copy of the original that checks out was found/)).toBeInTheDocument();
    // Nor does any preview show the copy's files, in its text or its tags.
    expect(JSON.stringify(previewedEvents.value)).not.toMatch(/media\.divine\.video/);
  });

  it.each([
    ['names no event, only an addressable one', [['a', `34236:${SIGNED_VIDEO.pubkey}:clip`], ['p', SIGNED_VIDEO.pubkey]], JSON.stringify(SIGNED_VIDEO)],
    ['has plain text that happens to start with a bracket', [['e', VIDEO_EVENT_ID], ['p', REPORTED_PUBKEY]], `[watch] https://media.divine.video/${OTHER_VIDEO}.mp4`],
  ])('offers no files, and says no checked original was found, when a repost %s', (_, tags, content) => {
    // Content that looks like JSON is taken as the repost's copy and never read,
    // so nothing is offered. The card says only that no checked original was
    // found, which holds for a repost that names no event and for plain text
    // that merely starts with a bracket, where "does not match" would not.
    repost.resolved = false;
    repost.value = {
      id: '9'.repeat(64),
      pubkey: '8'.repeat(64),
      created_at: 1751000100,
      kind: 16,
      tags,
      content,
      sig: 'b'.repeat(128),
    };

    renderDetail();

    expect(eventActionsProps.value).toMatchObject({ mediaHashes: [], thumbnailHashes: [] });
    expect(screen.getByText(/No copy of the original that checks out was found/)).toBeInTheDocument();
  });

  it.each([
    ['an object that is not an event', JSON.stringify({ id: VIDEO_EVENT_ID, pubkey: REPORTED_PUBKEY })],
    ['cut off', `{"id":"${VIDEO_EVENT_ID}","pubkey":"${REPORTED_PUBKEY}"`],
    ['an array', JSON.stringify([VIDEO_EVENT_ID, REPORTED_PUBKEY])],
    ['after leading whitespace', `  ${JSON.stringify({ id: VIDEO_EVENT_ID, pubkey: REPORTED_PUBKEY })}`],
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

  it("keeps the original's thumbnail a thumbnail when the repost's text links it too", () => {
    // Read as media, Unblock Media and Remove Restriction would lift it with the video.
    repost.value = {
      id: '9'.repeat(64),
      pubkey: '8'.repeat(64),
      created_at: 1751000100,
      kind: 6,
      tags: [['e', VIDEO_EVENT_ID], ['p', REPORTED_PUBKEY]],
      content: `look https://media.divine.video/${THUMB}`,
      sig: 'b'.repeat(128),
    };

    renderDetail();

    expect(eventActionsProps.value).toMatchObject({ mediaHashes: [VIDEO], thumbnailHashes: [THUMB] });
  });

  it("reads a repost's own media tags as well as the original's files", () => {
    repost.value = {
      id: '9'.repeat(64),
      pubkey: '8'.repeat(64),
      created_at: 1751000100,
      kind: 6,
      tags: [['e', VIDEO_EVENT_ID], ['p', REPORTED_PUBKEY], ['imeta', `url https://media.divine.video/${OTHER_VIDEO}`, 'm video/mp4']],
      content: JSON.stringify(VIDEO_EVENT.value),
      sig: 'b'.repeat(128),
    };

    renderDetail();

    expect(eventActionsProps.value).toMatchObject({ mediaHashes: [OTHER_VIDEO, VIDEO], thumbnailHashes: [THUMB] });
  });

  it("takes no file from the JSON content of an original that is itself a repost", () => {
    // A repost of a repost: the checked original is a real signed repost, and its
    // content is the inner event as JSON. Read as text, that would take the inner
    // event's id and author key for files, and the buttons would delete and block
    // hashes that are not files.
    repost.original = {
      id: 'd'.repeat(64),
      pubkey: '7'.repeat(64),
      created_at: 1751000050,
      kind: 6,
      tags: [['e', SIGNED_NOTE.id], ['p', SIGNED_NOTE.pubkey]],
      content: JSON.stringify(SIGNED_NOTE),
      sig: 'b'.repeat(128),
    };
    repost.value = {
      id: '9'.repeat(64),
      pubkey: '8'.repeat(64),
      created_at: 1751000100,
      kind: 6,
      tags: [['e', 'd'.repeat(64)], ['p', '7'.repeat(64)]],
      content: '',
      sig: 'b'.repeat(128),
    };

    renderDetail();

    expect(eventActionsProps.value).toMatchObject({ mediaHashes: [], thumbnailHashes: [] });
  });

  it("shows no file from the JSON content of an original that is itself a repost, in its preview either", () => {
    // That content is the original's own unchecked copy of another event. The
    // preview reads media URLs out of text, so it would render a file the
    // buttons were refused.
    const uncheckedCopy = JSON.stringify({
      ...SIGNED_VIDEO,
      tags: [['imeta', `url https://media.divine.video/${OTHER_VIDEO}`, 'm video/mp4']],
    });
    repost.original = {
      id: 'd'.repeat(64),
      pubkey: '7'.repeat(64),
      created_at: 1751000050,
      kind: 6,
      tags: [['e', SIGNED_VIDEO.id], ['p', SIGNED_VIDEO.pubkey]],
      content: uncheckedCopy,
      sig: 'b'.repeat(128),
    };
    repost.value = {
      id: '9'.repeat(64),
      pubkey: '8'.repeat(64),
      created_at: 1751000100,
      kind: 6,
      tags: [['e', 'd'.repeat(64)], ['p', '7'.repeat(64)]],
      content: '',
      sig: 'b'.repeat(128),
    };

    renderDetail();

    expect(eventActionsProps.value).toMatchObject({ mediaHashes: [], thumbnailHashes: [] });
    expect(JSON.stringify(previewedEvents.value)).not.toContain(OTHER_VIDEO);
    // The original is still previewed, as the checked event it is.
    expect(previewedEvents.value.some((event) => event.id === 'd'.repeat(64))).toBe(true);
  });

  it("still reads the text of an original that is a repost with plain text in its content", () => {
    // Out of spec, like a plain-text repost reported directly: some carry a media
    // URL as text, and the preview shows it, so the buttons must reach it too.
    repost.original = {
      id: 'd'.repeat(64),
      pubkey: '7'.repeat(64),
      created_at: 1751000050,
      kind: 6,
      tags: [['e', SIGNED_VIDEO.id], ['p', SIGNED_VIDEO.pubkey]],
      content: `https://media.divine.video/${OTHER_VIDEO}.mp4`,
      sig: 'b'.repeat(128),
    };
    repost.value = {
      id: '9'.repeat(64),
      pubkey: '8'.repeat(64),
      created_at: 1751000100,
      kind: 6,
      tags: [['e', 'd'.repeat(64)], ['p', '7'.repeat(64)]],
      content: '',
      sig: 'b'.repeat(128),
    };

    renderDetail();

    expect(eventActionsProps.value).toMatchObject({ mediaHashes: [OTHER_VIDEO], thumbnailHashes: [] });
    expect(JSON.stringify(previewedEvents.value)).toContain(OTHER_VIDEO);
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

  it('checks the thumbnail status too, so a gated thumbnail gets its own undo button', () => {
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

  // An action that ends in showDone, a thumbnail's failure or a partial one
  // included, leaves the media status re-read to this host (#336), so the
  // buttons match the files again.
  it('reads the media status again, once, when the media buttons report an action done', () => {
    const invalidate = vi.spyOn(QueryClient.prototype, 'invalidateQueries');
    try {
      renderDetail();
      const onActionComplete = eventActionsProps.value?.onActionComplete as () => void;
      invalidate.mockClear();

      onActionComplete();

      const mediaStatusReads = invalidate.mock.calls.filter(
        ([filters]) => JSON.stringify(filters?.queryKey) === JSON.stringify(['media-status']),
      );
      expect(mediaStatusReads).toHaveLength(1);
    } finally {
      invalidate.mockRestore();
    }
  });
});
