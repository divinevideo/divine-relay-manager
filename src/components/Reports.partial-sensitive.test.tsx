// ABOUTME: A poll that adds a CSAM-signal report to the open target and marks the feed stopped early, or that
// ABOUTME: drops the open target from the feed, hides its post media, avatar and recent-post media in the real pane,
// ABOUTME: and keeps a moderator's Show on a target that has left across later polls.

import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { nip19 } from 'nostr-tools';
import type { NostrEvent } from '@nostrify/nostrify';
import TestApp from '@/test/TestApp';
import { TooltipProvider } from '@/components/ui/tooltip';
import { moderationStatusMock } from '@/test/moderationStatusMock';
import { resolvedPage } from '@/test/resolvedHistory';
import { Reports } from './Reports';

const RELAY_URL = 'wss://relay.example';
const AUTHOR = 'd'.repeat(64);
const EVENT = '3'.repeat(64);
const POST_IMG = 'https://example.invalid/post.png';
const RECENT_IMG = 'https://example.invalid/recent.png';
const AVATAR = 'https://example.invalid/avatar.png';

const REPORTED_POST: NostrEvent = {
  id: EVENT, pubkey: AUTHOR, created_at: 1751000000, kind: 1, tags: [], content: `pic ${POST_IMG}`, sig: 'b'.repeat(128),
};
const RECENT_POST: NostrEvent = { ...REPORTED_POST, id: '6'.repeat(64), content: `pic ${RECENT_IMG}` };

function report(id: string, createdAt: number, tags: string[][], content = '') {
  return { id, pubkey: '5'.repeat(64), created_at: createdAt, kind: 1984, tags, content, sig: 'f'.repeat(128) };
}
const SPAM_REPORT = report('c'.repeat(64), 1751000050, [['e', EVENT, 'spam'], ['p', AUTHOR, 'spam']]);
const CSAM_REPORT = report('a'.repeat(64), 1751000100, [['e', EVENT, 'other'], ['p', AUTHOR], ['report', 'csam']], 'synthetic csam-signal report');

// The pane's own reads, stood in so it renders the target's media, avatar and
// recent posts with no relay.
vi.mock('@/hooks/useReportContext', () => ({
  useReportContext: () => ({
    target: { type: 'event', value: EVENT },
    thread: { event: REPORTED_POST, ancestors: [], replies: [] },
    threadLoading: false,
    reportedUser: { profile: { picture: AVATAR }, pubkey: AUTHOR, isFunnelcakeUser: false },
    userStats: {
      postCount: 1, reportCount: 0, labelCount: 0, recentPosts: [RECENT_POST], existingLabels: [], previousReports: [],
      authoredContentIncomplete: false, labelsIncomplete: false, reportsIncomplete: false, reportsTruncated: false,
      labelsTruncated: false, relayIncomplete: false,
    },
    isLoading: false,
    error: null,
    relayHint: undefined,
    reportTags: [],
  }),
}));
vi.mock('@/hooks/useDecisionLog', () => ({
  useDecisionLog: () => ({
    hasDecisions: false, hasHandlingDecisions: false, latestHandlingDecision: undefined, isPendingReview: false,
    isAutoHideRestoreFailed: false, isAutoHideUnresolved: false, isDeleted: false, isAutoHidden: false,
    isAutoHideRestored: false, decisions: [], latestDecision: null, refetch: vi.fn(),
  }),
}));
vi.mock('@/hooks/useModerationStatus', () => ({
  useModerationStatus: () => moderationStatusMock({ isUserBanned: false, isEventGone: false }),
}));
vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ user: { pubkey: 'e'.repeat(64) }, getModeratorPubkey: async () => 'e'.repeat(64) }),
}));
vi.mock('@/hooks/useBannedEvent', () => ({ useBannedEvent: () => ({ data: null, isLoading: false }) }));
vi.mock('@/hooks/useUserSummary', () => ({ useUserSummary: () => ({ data: null, isLoading: false }) }));
vi.mock('@/hooks/useMediaStatus', () => ({ useMediaStatus: () => ({}) }));
vi.mock('@/hooks/useEventTitles', () => ({ useEventTitles: () => ({ titles: new Map(), isLoading: false }) }));
vi.mock('@/components/ThreadContext', () => ({ ThreadContext: () => null }));
vi.mock('@/components/AISummary', () => ({ AISummary: () => null }));
vi.mock('@/components/HiveAIReport', () => ({ HiveAIReport: () => null }));
vi.mock('@/components/AIDetectionReport', () => ({ AIDetectionReport: () => null }));
vi.mock('@/components/ThreadModal', () => ({ ThreadModal: () => null }));
vi.mock('@/components/EventActions', () => ({ EventActions: () => null }));
vi.mock('@/components/UserActions', () => ({ UserActions: () => null }));
vi.mock('@/components/BulkDeleteByKind', () => ({ BulkDeleteByKind: () => null }));
vi.mock('@/components/ReporterCard', () => ({ ReporterInline: () => null }));
vi.mock('@/components/LinkedTicketPanel', () => ({ LinkedTicketPanel: () => null }));
vi.mock('@/components/UserIdentifier', () => ({ UserIdentifier: () => null }));
vi.mock('@/components/RelatedReportsCard', () => ({ RelatedReportsCard: () => null }));
// Radix's AvatarImage renders an <img> only after a real load, which jsdom never
// does; mounting it is what starts the request, so a stand-in shows the mount.
vi.mock('@/components/ui/avatar', () => ({
  Avatar: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  AvatarImage: ({ src }: { src?: string }) => <img data-testid="avatar-img" src={src} />,
  AvatarFallback: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

const hasImg = (src: string) => document.querySelector(`img[src="${src}"]`) !== null;

let consoleError: MockInstance;
beforeEach(() => {
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  consoleError.mockRestore();
});

describe('a poll that adds a CSAM-signal report and stops early', () => {
  it("hides the open target's post media, avatar and recent-post media", async () => {
    // First read: the target's one spam report, read in full. Every later read:
    // a CSAM-signal report on the same post as well, and the walk stopped early.
    let feedReads = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes('/api/reports?needs_attention=1')) {
        feedReads += 1;
        return feedReads === 1
          ? jsonResponse({ success: true, events: [SPAM_REPORT], truncated: false })
          : jsonResponse({ success: true, events: [CSAM_REPORT, SPAM_REPORT], truncated: true, oldest_covered: 1751000000 });
      }
      if (url.includes('/api/resolution-label-targets')) {
        return jsonResponse({ success: true, targets: [], truncated: false, oldest_covered: null });
      }
      if (url.includes('/api/resolution-state')) return jsonResponse({ success: true, resolved: [], states: [] });
      if (url.includes('/api/relay-rpc')) return jsonResponse({ success: true, result: [] });
      return jsonResponse({ success: true });
    }));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });
    const user = userEvent.setup();
    // The app root provides tooltips; TestApp does not, and the pane uses them.
    render(<TestApp queryClient={queryClient}><TooltipProvider><Reports relayUrl={RELAY_URL} /></TooltipProvider></TestApp>);

    await user.click(await screen.findByText(nip19.noteEncode(EVENT)));
    await waitFor(() => expect(hasImg(POST_IMG)).toBe(true));
    expect(hasImg(AVATAR)).toBe(true);
    expect(hasImg(RECENT_IMG)).toBe(true);

    await act(async () => { await queryClient.refetchQueries({ queryKey: ['reports', RELAY_URL] }); });
    await waitFor(() => expect(feedReads).toBe(2));
    // The stopped-early banner says the feed is now partial.
    await screen.findByText(/stopped/i);

    expect(hasImg(POST_IMG)).toBe(false);
    expect(hasImg(AVATAR)).toBe(false);
    expect(hasImg(RECENT_IMG)).toBe(false);
  });
});

describe('a poll on which the open target has left the feed', () => {
  it("hides the open target's post media, avatar and recent-post media", async () => {
    // First read: the target's one spam report, read in full. Every later read:
    // the target is gone (handled elsewhere), and the feed read to its end.
    let feedReads = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes('/api/reports?needs_attention=1')) {
        feedReads += 1;
        return feedReads === 1
          ? jsonResponse({ success: true, events: [SPAM_REPORT], truncated: false })
          : jsonResponse({ success: true, events: [], truncated: false });
      }
      if (url.includes('/api/resolution-label-targets')) {
        return jsonResponse({ success: true, targets: [], truncated: false, oldest_covered: null });
      }
      if (url.includes('/api/resolution-state')) return jsonResponse({ success: true, resolved: [], states: [] });
      if (url.includes('/api/relay-rpc')) return jsonResponse({ success: true, result: [] });
      return jsonResponse({ success: true });
    }));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });
    const user = userEvent.setup();
    render(<TestApp queryClient={queryClient}><TooltipProvider><Reports relayUrl={RELAY_URL} /></TooltipProvider></TestApp>);

    await user.click(await screen.findByText(nip19.noteEncode(EVENT)));
    await waitFor(() => expect(hasImg(POST_IMG)).toBe(true));
    expect(hasImg(AVATAR)).toBe(true);
    expect(hasImg(RECENT_IMG)).toBe(true);

    await act(async () => { await queryClient.refetchQueries({ queryKey: ['reports', RELAY_URL] }); });
    await waitFor(() => expect(feedReads).toBe(2));
    // The row is gone; the pane stays open on the same report.
    await waitFor(() => expect(screen.queryByText(nip19.noteEncode(EVENT))).not.toBeInTheDocument());
    expect(screen.getByText('Media Content')).toBeInTheDocument();

    expect(hasImg(POST_IMG)).toBe(false);
    expect(hasImg(AVATAR)).toBe(false);
    expect(hasImg(RECENT_IMG)).toBe(false);
  });

  // A later poll in flight does not undo the queue's call that the target has
  // left (a read in flight only stops a target being called left in the first
  // place), so the media stays hidden while it reads and after it answers.
  it('keeps them hidden while a later poll is in flight and after it answers', async () => {
    let feedReads = 0;
    let openThird = () => {};
    const thirdGate = new Promise<void>(r => { openThird = r; });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes('/api/reports?needs_attention=1')) {
        feedReads += 1;
        if (feedReads === 1) return jsonResponse({ success: true, events: [SPAM_REPORT], truncated: false });
        if (feedReads >= 3) await thirdGate;
        return jsonResponse({ success: true, events: [], truncated: false });
      }
      if (url.includes('/api/resolution-label-targets')) {
        return jsonResponse({ success: true, targets: [], truncated: false, oldest_covered: null });
      }
      if (url.includes('/api/resolution-state')) return jsonResponse({ success: true, resolved: [], states: [] });
      if (url.includes('/api/relay-rpc')) return jsonResponse({ success: true, result: [] });
      return jsonResponse({ success: true });
    }));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });
    const user = userEvent.setup();
    render(<TestApp queryClient={queryClient}><TooltipProvider><Reports relayUrl={RELAY_URL} /></TooltipProvider></TestApp>);
    await user.click(await screen.findByText(nip19.noteEncode(EVENT)));
    await waitFor(() => expect(hasImg(POST_IMG)).toBe(true));

    // The target leaves, and its media hides.
    await act(async () => { await queryClient.refetchQueries({ queryKey: ['reports', RELAY_URL] }); });
    await waitFor(() => expect(hasImg(POST_IMG)).toBe(false));
    const hidden = () => [hasImg(POST_IMG), hasImg(AVATAR), hasImg(RECENT_IMG)];
    expect(hidden()).toEqual([false, false, false]);

    // A later poll, held in flight.
    let poll: Promise<unknown> = Promise.resolve();
    await act(async () => {
      poll = queryClient.refetchQueries({ queryKey: ['reports', RELAY_URL] });
      await new Promise(r => setTimeout(r, 50));
    });
    expect(feedReads).toBe(3);
    expect(queryClient.isFetching({ queryKey: ['reports', RELAY_URL] })).toBe(1);
    expect(screen.getByText('Media Content')).toBeInTheDocument();
    expect(hidden()).toEqual([false, false, false]);

    await act(async () => { openThird(); await poll; await new Promise(r => setTimeout(r, 50)); });
    expect(queryClient.isFetching({ queryKey: ['reports', RELAY_URL] })).toBe(0);
    expect(hidden()).toEqual([false, false, false]);
  });

  // The feed's first read holds `firstEvents`; every later one is empty, so the
  // target leaves on the second. Each later read is a poll held in flight for a
  // moment before it answers, as a real one is, so the screen renders mid-read.
  function stubLeavingFeed(firstEvents: unknown[]) {
    let feedReads = 0;
    let answer: Promise<void> = Promise.resolve();
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes('/api/reports?needs_attention=1')) {
        feedReads += 1;
        if (feedReads === 1) return jsonResponse({ success: true, events: firstEvents, truncated: false });
        await answer;
        return jsonResponse({ success: true, events: [], truncated: false });
      }
      if (url.includes('/api/resolution-label-targets')) {
        return jsonResponse({ success: true, targets: [], truncated: false, oldest_covered: null });
      }
      if (url.includes('/api/resolution-state')) return jsonResponse({ success: true, resolved: [], states: [] });
      if (url.includes('/api/relay-rpc')) return jsonResponse({ success: true, result: [] });
      return jsonResponse({ success: true });
    }));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });
    const user = userEvent.setup();
    render(<TestApp queryClient={queryClient}><TooltipProvider><Reports relayUrl={RELAY_URL} /></TooltipProvider></TestApp>);
    const poll = async () => {
      let open = () => {};
      answer = new Promise<void>(r => { open = r; });
      let read: Promise<unknown> = Promise.resolve();
      await act(async () => {
        read = queryClient.refetchQueries({ queryKey: ['reports', RELAY_URL] });
        await new Promise(r => setTimeout(r, 50));
      });
      await act(async () => { open(); await read; await new Promise(r => setTimeout(r, 50)); });
    };
    return { user, poll };
  }
  const showing = () => [hasImg(POST_IMG), hasImg(AVATAR), hasImg(RECENT_IMG)];
  async function showAll(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getAllByRole('button', { name: /^Show$/ })[0]);
    await user.click(screen.getByRole('button', { name: 'Show profile picture' }));
    await user.click(screen.getByRole('button', { name: /show 1 media/i }));
  }

  it('keeps a Show made after the target left across a later poll', async () => {
    const { user, poll } = stubLeavingFeed([SPAM_REPORT]);
    await user.click(await screen.findByText(nip19.noteEncode(EVENT)));
    await waitFor(() => expect(hasImg(POST_IMG)).toBe(true));

    await poll(); // the target leaves, and its media hides
    expect(screen.queryByText(nip19.noteEncode(EVENT))).not.toBeInTheDocument();
    expect(showing()).toEqual([false, false, false]);

    await showAll(user);
    expect(showing()).toEqual([true, true, true]);

    await poll(); // an ordinary later poll; the target is still gone
    expect(showing()).toEqual([true, true, true]);
  });

  it('keeps a Show on a sensitive target across the poll it leaves on and a later one', async () => {
    const { user, poll } = stubLeavingFeed([
      report('9'.repeat(64), 1751000100, [['e', EVENT, 'terrorism_extremism'], ['p', AUTHOR]]),
    ]);
    await user.click(await screen.findByText(nip19.noteEncode(EVENT)));
    await screen.findByText('Media Content');
    expect(showing()).toEqual([false, false, false]);

    await showAll(user);
    expect(showing()).toEqual([true, true, true]);

    await poll(); // the target leaves; a Show on a sensitive target is kept
    expect(screen.queryByText(nip19.noteEncode(EVENT))).not.toBeInTheDocument();
    expect(showing()).toEqual([true, true, true]);

    await poll(); // an ordinary later poll
    expect(showing()).toEqual([true, true, true]);
  });
});

// In the history view (Hide resolved off), resolving the open target moves it
// from the feed into resolved history, and both re-read. Whichever lands first,
// the target never leaves the list for good: it turns partial (a history-only
// target), so what was showing keeps showing. Only a target neither read brings
// back has left.
describe('in the history view, the open target moving into resolved history', () => {
  // `inHistory`: whether resolved history's re-read holds the target, as it does
  // when its report is on a loaded page. Once resolved, each read waits for its
  // gate, so a test decides which lands first.
  async function openThenResolve(inHistory: boolean) {
    let resolved = false;
    const gate = () => {
      let open = () => {};
      const opened = new Promise<void>(r => { open = r; });
      return { opened, open: () => open() };
    };
    const gates = { feed: gate(), history: gate() };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes('/api/reports?needs_attention=1')) {
        if (resolved) await gates.feed.opened;
        return jsonResponse({ success: true, events: resolved ? [] : [SPAM_REPORT], truncated: false });
      }
      if (url.includes('/api/reports/resolved')) {
        if (resolved) await gates.history.opened;
        return jsonResponse(resolvedPage(resolved && inHistory ? [SPAM_REPORT] : [], { nextCursor: null, done: true }));
      }
      if (url.includes('/api/resolution-label-targets')) {
        return jsonResponse({ success: true, targets: [], truncated: false, oldest_covered: null });
      }
      if (url.includes('/api/resolution-state')) return jsonResponse({ success: true, resolved: [], states: [] });
      if (url.includes('/api/relay-rpc')) return jsonResponse({ success: true, result: [] });
      return jsonResponse({ success: true });
    }));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });
    const user = userEvent.setup();
    render(<TestApp queryClient={queryClient}><TooltipProvider><Reports relayUrl={RELAY_URL} /></TooltipProvider></TestApp>);
    await user.click(await screen.findByRole('switch', { name: /hide resolved/i }));
    await user.click(await screen.findByText(nip19.noteEncode(EVENT)));
    await waitFor(() => expect(hasImg(POST_IMG)).toBe(true));
    expect(hasImg(AVATAR)).toBe(true);
    expect(hasImg(RECENT_IMG)).toBe(true);
    resolved = true;
    // Both re-reads start together, as a resolve or Refresh starts them.
    const feed = queryClient.refetchQueries({ queryKey: ['reports', RELAY_URL] });
    const history = queryClient.refetchQueries({ queryKey: ['reports-resolved'] });
    return { gates, feed, history };
  }

  // Lets one read answer and the screen settle, while the other still waits.
  const land = (gate: { open: () => void }, read: Promise<unknown>) =>
    act(async () => { gate.open(); await read; await new Promise(r => setTimeout(r, 50)); });
  const allShowing = () => [hasImg(POST_IMG), hasImg(AVATAR), hasImg(RECENT_IMG)];

  it("keeps showing when the queue's re-read lands before history's", async () => {
    const { gates, feed, history } = await openThenResolve(true);
    await land(gates.feed, feed);
    expect(allShowing()).toEqual([true, true, true]);

    await land(gates.history, history);
    expect(screen.getByText(nip19.noteEncode(EVENT))).toBeInTheDocument();
    expect(allShowing()).toEqual([true, true, true]);
  });

  it("keeps showing when history's re-read lands before the queue's", async () => {
    const { gates, feed, history } = await openThenResolve(true);
    await land(gates.history, history);
    expect(allShowing()).toEqual([true, true, true]);

    await land(gates.feed, feed);
    expect(screen.getByText(nip19.noteEncode(EVENT))).toBeInTheDocument();
    expect(allShowing()).toEqual([true, true, true]);
  });

  it('hides once both reads have answered without the target', async () => {
    const { gates, feed, history } = await openThenResolve(false);
    await land(gates.feed, feed);
    await land(gates.history, history);
    expect(screen.queryByText(nip19.noteEncode(EVENT))).not.toBeInTheDocument();
    expect(screen.getByText('Media Content')).toBeInTheDocument();
    expect(allShowing()).toEqual([false, false, false]);
  });

  // A target that left and then came back is in hand again, so the call that it
  // had left no longer holds: the next time it is only between two reads, it
  // keeps showing like any other.
  it("keeps showing a target that left and came back, when the queue's re-read lands before history's", async () => {
    let phase: 'start' | 'gone' | 'back' | 'resolved' = 'start';
    const gate = () => {
      let open = () => {};
      const opened = new Promise<void>(r => { open = r; });
      return { opened, open: () => open() };
    };
    const gates = { feed: gate(), history: gate() };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes('/api/reports?needs_attention=1')) {
        if (phase === 'resolved') await gates.feed.opened;
        const inFeed = phase === 'start' || phase === 'back';
        return jsonResponse({ success: true, events: inFeed ? [SPAM_REPORT] : [], truncated: false });
      }
      if (url.includes('/api/reports/resolved')) {
        if (phase === 'resolved') await gates.history.opened;
        return jsonResponse(resolvedPage(phase === 'resolved' ? [SPAM_REPORT] : [], { nextCursor: null, done: true }));
      }
      if (url.includes('/api/resolution-label-targets')) {
        return jsonResponse({ success: true, targets: [], truncated: false, oldest_covered: null });
      }
      if (url.includes('/api/resolution-state')) return jsonResponse({ success: true, resolved: [], states: [] });
      if (url.includes('/api/relay-rpc')) return jsonResponse({ success: true, result: [] });
      return jsonResponse({ success: true });
    }));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });
    const user = userEvent.setup();
    render(<TestApp queryClient={queryClient}><TooltipProvider><Reports relayUrl={RELAY_URL} /></TooltipProvider></TestApp>);
    await user.click(await screen.findByRole('switch', { name: /hide resolved/i }));
    await user.click(await screen.findByText(nip19.noteEncode(EVENT)));
    await waitFor(() => expect(hasImg(POST_IMG)).toBe(true));
    const rereadBoth = () => act(async () => {
      await Promise.all([
        queryClient.refetchQueries({ queryKey: ['reports', RELAY_URL] }),
        queryClient.refetchQueries({ queryKey: ['reports-resolved'] }),
      ]);
      await new Promise(r => setTimeout(r, 50));
    });

    phase = 'gone'; // handled elsewhere: in neither read
    await rereadBoth();
    expect(screen.queryByText(nip19.noteEncode(EVENT))).not.toBeInTheDocument();
    expect(allShowing()).toEqual([false, false, false]);

    phase = 'back'; // reported again: back in the feed
    await rereadBoth();
    expect(screen.getByText(nip19.noteEncode(EVENT))).toBeInTheDocument();
    expect(allShowing()).toEqual([true, true, true]);

    phase = 'resolved'; // resolved here: from the feed into history
    const feed = queryClient.refetchQueries({ queryKey: ['reports', RELAY_URL] });
    const history = queryClient.refetchQueries({ queryKey: ['reports-resolved'] });
    await land(gates.feed, feed);
    expect(allShowing()).toEqual([true, true, true]);

    await land(gates.history, history);
    expect(screen.getByText(nip19.noteEncode(EVENT))).toBeInTheDocument();
    expect(allShowing()).toEqual([true, true, true]);
  });

  // The other way: reopening a history-only target moves it from resolved
  // history back into the feed. If history's re-read lands first, the target is
  // in neither until the feed's does.
  it("keeps a Show on a history-only target that is reopened, when history's re-read lands first", async () => {
    let reopened = false;
    let openFeed = () => {};
    const feedGate = new Promise<void>(r => { openFeed = r; });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes('/api/reports?needs_attention=1')) {
        if (reopened) await feedGate;
        return jsonResponse({ success: true, events: reopened ? [SPAM_REPORT] : [], truncated: false });
      }
      if (url.includes('/api/reports/resolved')) {
        return jsonResponse(resolvedPage(reopened ? [] : [SPAM_REPORT], { nextCursor: null, done: true }));
      }
      if (url.includes('/api/resolution-label-targets')) {
        return jsonResponse({ success: true, targets: [], truncated: false, oldest_covered: null });
      }
      if (url.includes('/api/resolution-state')) return jsonResponse({ success: true, resolved: [], states: [] });
      if (url.includes('/api/relay-rpc')) return jsonResponse({ success: true, result: [] });
      return jsonResponse({ success: true });
    }));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });
    const user = userEvent.setup();
    render(<TestApp queryClient={queryClient}><TooltipProvider><Reports relayUrl={RELAY_URL} /></TooltipProvider></TestApp>);
    await user.click(await screen.findByRole('switch', { name: /hide resolved/i }));
    await user.click(await screen.findByText(nip19.noteEncode(EVENT)));
    // History-only, so partial: its media starts hidden, and the moderator shows it.
    await screen.findByText('Media Content');
    expect(hasImg(POST_IMG)).toBe(false);
    await user.click(screen.getAllByRole('button', { name: /^Show$/ })[0]);
    expect(hasImg(POST_IMG)).toBe(true);

    reopened = true;
    const feed = queryClient.refetchQueries({ queryKey: ['reports', RELAY_URL] });
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['reports-resolved'] });
      await new Promise(r => setTimeout(r, 50));
    });
    // In neither read for now, but the feed's is still coming.
    expect(screen.queryByText(nip19.noteEncode(EVENT))).not.toBeInTheDocument();
    expect(hasImg(POST_IMG)).toBe(true);

    await land({ open: openFeed }, feed);
    expect(screen.getByText(nip19.noteEncode(EVENT))).toBeInTheDocument();
    expect(hasImg(POST_IMG)).toBe(true);
  });
});
