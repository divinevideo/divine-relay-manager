// ABOUTME: Pins that EventDetail hides media and profile images by default when a related report
// ABOUTME: is sensitive, and keeps them hidden until a complete read of its reports finds none.

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NostrEvent } from '@nostrify/nostrify';
import { EventDetail } from './EventDetail';

const REPORTED_PUBKEY = 'd'.repeat(64);
const MOD_PUBKEY = 'e'.repeat(64);

const api = vi.hoisted(() => ({
  banPubkey: vi.fn(),
  deleteEvent: vi.fn(),
  unbanPubkey: vi.fn(),
  restoreEvent: vi.fn(),
  verifyPubkeyBanned: vi.fn(),
  verifyPubkeyUnbanned: vi.fn(),
  verifyEventDeleted: vi.fn(),
  logDecision: vi.fn(),
}));

vi.mock('@/hooks/useAdminApi', () => ({ useAdminApi: () => api }));
vi.mock('@/hooks/useToast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({
    user: { pubkey: MOD_PUBKEY },
    getModeratorPubkey: async () => MOD_PUBKEY,
  }),
}));
const reports = vi.hoisted(() => ({ value: [] as unknown[] }));
type RelayAnswer = (filters: Record<string, unknown>[], opts: { signal: AbortSignal }) => Promise<unknown[]>;
// How the relay answers each related-reports read. Unset, every read finishes
// at once with reports.value.
const relay = vi.hoisted(() => ({ answer: null as RelayAnswer | null }));
vi.mock('@/hooks/useNostr', () => ({
  useNostr: () => ({
    nostr: {
      query: vi.fn((filters: Record<string, unknown>[], opts: { signal: AbortSignal }) =>
        relay.answer ? relay.answer(filters, opts) : Promise.resolve(reports.value)),
    },
  }),
}));
// Profile pictures useAuthor answers with, by pubkey. None unless a test sets one.
const authors = vi.hoisted(() => ({ pictures: {} as Record<string, string> }));
vi.mock('@/hooks/useAuthor', () => ({
  useAuthor: (pubkey: string) => ({
    data: authors.pictures[pubkey] ? { metadata: { name: 'someone', picture: authors.pictures[pubkey] } } : undefined,
    isLoading: false,
  }),
}));
vi.mock('@/hooks/useUserStats', () => ({ useUserStats: () => ({ data: undefined, isLoading: false }) }));
vi.mock('@/hooks/useAgeReviewGuardRedirect', () => ({
  useAgeReviewGuardRedirect: () => ({ redirectIfGuarded: () => false }),
}));

const modStatus = vi.hoisted(() => ({
  isUserBanned: true as boolean | null,
  isUserBannedStale: false,
  isEventGone: false as boolean | null,
  isChecking: false,
  isUserBanChecking: false,
  isAccountStatusLoading: false,
  recheck: vi.fn(),
}));
vi.mock('@/hooks/useModerationStatus', async () => {
  const { moderationStatusMock } = await import('@/test/moderationStatusMock');
  return { useModerationStatus: () => moderationStatusMock({ ...modStatus }) };
});

vi.mock('@/components/HiveAIReport', () => ({ HiveAIReport: () => null }));
vi.mock('@/components/AIDetectionReport', () => ({ AIDetectionReport: () => null }));
vi.mock('@/components/SceneClassification', () => ({ SceneClassification: () => null }));
vi.mock('@/components/TranscriptAnalysis', () => ({ TranscriptAnalysis: () => null }));
vi.mock('@/components/ReporterCard', () => ({ ReporterList: () => null }));
// Stand-in that exposes showByDefault, so no media is ever loaded or fetched.
// 'null' is hidden because the reports are not known yet; 'false' is hidden
// because they are sensitive.
vi.mock('@/components/MediaPreview', () => ({
  MediaPreview: ({ showByDefault }: { showByDefault?: boolean | null }) => (
    <div data-testid="media" data-show={String(showByDefault)} />
  ),
}));
vi.mock('@/components/UserIdentifier', () => ({ UserIdentifier: () => null }));

const EVENT: NostrEvent = {
  id: 'c'.repeat(64),
  pubkey: REPORTED_PUBKEY,
  created_at: 1751000000,
  kind: 1,
  tags: [],
  content: 'clip https://example.invalid/clip.mp4',
  sig: 'c'.repeat(128),
};

function makeReport(tags: string[][], content: string): NostrEvent {
  return { id: 'f'.repeat(64), pubkey: 'a'.repeat(64), created_at: 1751000100, kind: 1984, tags, content, sig: 'b'.repeat(128) };
}
const OLD_BUILD = makeReport(
  [['e', EVENT.id, 'illegal'], ['p', REPORTED_PUBKEY, 'illegal'], ['client', 'diVine']],
  'CONTENT REPORT - NIP-56\nReason: csam\nDetails: x\n',
);
const PLAIN_ILLEGAL = makeReport([['e', EVENT.id, 'illegal'], ['p', REPORTED_PUBKEY, 'illegal']], 'bad');
const SPAM = makeReport([['e', EVENT.id, 'spam'], ['p', REPORTED_PUBKEY, 'spam']], 'buy now');

// The app's relay pool (NPool) resolves a query with whatever had arrived when
// its signal aborts, its own timeout included; it never rejects. This stands in
// for a read the relay never finishes.
function answerOnAbort(signal: AbortSignal, events: unknown[] = []): Promise<unknown[]> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve(events);
    else signal.addEventListener('abort', () => resolve(events), { once: true });
  });
}

function renderDetail(queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
})) {
  const view = render(
    <QueryClientProvider client={queryClient}>
      <EventDetail event={EVENT} />
    </QueryClientProvider>,
  );
  return { ...view, queryClient };
}

// The app's own query defaults (App.tsx): a cached read stays fresh for a
// minute and is never garbage-collected.
function appQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000, gcTime: Infinity } } });
}

const imageSrcs = (c: HTMLElement) => [...c.querySelectorAll('img')].map(i => i.getAttribute('src')).sort();

// A created <img> is already a request in a real browser, even if a later
// commit removes it, so this counts creations, not what the DOM ends with.
function imagesCreatedDuring(action: () => void): number {
  const spy = vi.spyOn(document, 'createElement');
  action();
  const count = spy.mock.calls.filter(c => String(c[0]).toLowerCase() === 'img').length;
  spy.mockRestore();
  return count;
}

beforeEach(() => {
  vi.clearAllMocks();
  relay.answer = null;
  authors.pictures = {};
  modStatus.isUserBanned = false;
  modStatus.isUserBannedStale = false;
  modStatus.isEventGone = false;
});

describe('EventDetail media gating by related reports', () => {

  it('hides media by default when a related report is an old-build CSAM report', async () => {
    reports.value = [OLD_BUILD];
    renderDetail();
    await screen.findByText('1 Related Report');
    await waitFor(() => expect(screen.getByTestId('media').dataset.show).toBe('false'));
  });

  it('keeps media shown for a bare illegal report (control)', async () => {
    reports.value = [PLAIN_ILLEGAL];
    renderDetail();
    await screen.findByText('1 Related Report');
    expect(screen.getByTestId('media').dataset.show).toBe('true');
  });
});

describe('EventDetail media before its reports are known', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // Runs the reads' 3 s timeout, then the timer the query library uses to hand
  // the settled result to React.
  async function letReadsTimeOut() {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
      await vi.runOnlyPendingTimersAsync();
    });
  }

  it('starts with media hidden while the reports read is still out', () => {
    relay.answer = () => new Promise(() => {});
    renderDetail();
    // Checked straight after the first commit, not in waitFor: a browser starts
    // loading whatever media that commit mounts.
    expect(screen.getByTestId('media').dataset.show).toBe('null');
  });

  it('keeps media hidden when every reports read times out with nothing', async () => {
    vi.useFakeTimers();
    relay.answer = (_filters, { signal }) => answerOnAbort(signal);
    const { queryClient } = renderDetail();
    expect(queryClient.isFetching()).toBe(1);

    await letReadsTimeOut();

    expect(queryClient.isFetching()).toBe(0);
    expect(screen.getByTestId('media').dataset.show).toBe('null');
  });

  it('lists what a timed-out read found, and keeps media hidden', async () => {
    vi.useFakeTimers();
    // The read for the event finishes with a spam report; the read for the
    // account never does.
    relay.answer = (filters, { signal }) =>
      filters[0]['#e'] ? Promise.resolve([SPAM]) : answerOnAbort(signal);
    renderDetail();

    await letReadsTimeOut();

    expect(screen.getByText('1 Related Report')).toBeInTheDocument();
    expect(screen.getByTestId('media').dataset.show).toBe('null');
  });

  it('shows media once every read has finished and found only spam', async () => {
    reports.value = [SPAM];
    renderDetail();
    await screen.findByText('1 Related Report');
    expect(screen.getByTestId('media').dataset.show).toBe('true');
  });
});

// A later read (a refetch on window focus, say) that times out must not undo
// what an earlier read since the event was opened found.
describe('EventDetail when a later read of its reports times out', () => {
  const media = () => screen.getByTestId('media').dataset.show;
  // Filed after the first read, and found by the event read of the second.
  const NEW_CSAM: NostrEvent = { ...OLD_BUILD, id: '9'.repeat(64), created_at: 1751000200 };

  afterEach(() => {
    vi.useRealTimers();
  });

  async function flushTimers() {
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
  }

  // Starts a refetch, then runs its 3 s timeout and the result's hand-off.
  async function refetchUntilTimeout(queryClient: QueryClient) {
    await act(async () => { void queryClient.refetchQueries({ queryKey: ['related-reports'] }); });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
      await vi.runOnlyPendingTimersAsync();
    });
  }

  it('keeps listing what the earlier read found, and keeps its media shown', async () => {
    vi.useFakeTimers();
    reports.value = [SPAM];
    const { queryClient } = renderDetail();
    await flushTimers();
    expect(screen.getByText('1 Related Report')).toBeInTheDocument();
    expect(media()).toBe('true');

    relay.answer = (_filters, { signal }) => answerOnAbort(signal);
    await refetchUntilTimeout(queryClient);

    expect(screen.getByText('1 Related Report')).toBeInTheDocument();
    expect(media()).toBe('true');
  });

  it('adds what the timed-out read did find', async () => {
    vi.useFakeTimers();
    reports.value = [SPAM];
    const { queryClient } = renderDetail();
    await flushTimers();

    // The event read now finds a CSAM report; the account read never answers.
    relay.answer = (filters, { signal }) =>
      filters[0]['#e'] ? Promise.resolve([NEW_CSAM]) : answerOnAbort(signal);
    await refetchUntilTimeout(queryClient);

    expect(screen.getByText('2 Related Reports')).toBeInTheDocument();
    expect(media()).toBe('false');
  });

  it('does not take a clean verdict from a read made before the event was opened', async () => {
    vi.useFakeTimers();
    const queryClient = appQueryClient();
    reports.value = [SPAM];
    const firstVisit = renderDetail(queryClient);
    await flushTimers();
    firstVisit.unmount();

    // This visit's first read times out with nothing.
    relay.answer = (_filters, { signal }) => answerOnAbort(signal);
    renderDetail(queryClient);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
      await vi.runOnlyPendingTimersAsync();
    });

    expect(media()).toBe('null');
  });
});

// A read that returns as many reports as it asked for may have left older ones
// on the relay, so it cannot rule out a sensitive one.
describe('EventDetail media when a read returns its full limit', () => {
  const accountReport = (n: number, tags: string[][]): NostrEvent => ({
    id: n.toString(16).padStart(64, '0'), pubkey: 'a'.repeat(64), created_at: 1751000000 + n,
    kind: 1984, tags, content: '', sig: 'b'.repeat(128),
  });
  const OLDER_CSAM = accountReport(1, [
    ['p', REPORTED_PUBKEY, 'illegal'], ['L', 'social.nos.ontology'], ['l', 'NS-csam', 'social.nos.ontology'],
  ]);
  const NEWER_SPAM = Array.from({ length: 50 }, (_, i) => accountReport(200 + i, [['p', REPORTED_PUBKEY, 'spam']]));
  const RELAY_REPORTS = [OLDER_CSAM, ...NEWER_SPAM, SPAM];

  it('keeps media hidden when the account read stops at its limit before an older CSAM report', async () => {
    // A relay answers each read with its newest matches, up to the limit.
    relay.answer = async (filters) => {
      const filter = filters[0];
      const [tag, values] = filter['#e'] ? ['e', filter['#e']] : ['p', filter['#p']];
      return RELAY_REPORTS
        .filter(r => r.tags.some(t => t[0] === tag && (values as string[]).includes(t[1])))
        .sort((a, b) => b.created_at - a.created_at)
        .slice(0, filter.limit as number);
    };
    renderDetail();

    // The event read found SPAM; the account read returned its 50 newest.
    await screen.findByText('51 Related Reports');
    expect(screen.getByTestId('media').dataset.show).toBe('null');
  });
});

// A read cached from an earlier visit can predate a report filed since, so
// only a read made since the event was opened may show its media.
describe('EventDetail media on a later visit', () => {
  const media = () => screen.getByTestId('media').dataset.show;
  const OTHER_EVENT: NostrEvent = { ...EVENT, id: 'b'.repeat(64) };

  async function visitOnce(queryClient: QueryClient, reportsFound: NostrEvent[]) {
    reports.value = reportsFound;
    const first = renderDetail(queryClient);
    await screen.findByText('1 Related Report');
    first.unmount();
  }

  it('starts hidden, though the last visit found nothing sensitive, until this visit has read', async () => {
    const queryClient = appQueryClient();
    await visitOnce(queryClient, [SPAM]);

    relay.answer = () => new Promise(() => {});
    renderDetail(queryClient);

    expect(media()).toBe('null');
  });

  it("shows media once this visit's own read finds nothing sensitive", async () => {
    const queryClient = appQueryClient();
    await visitOnce(queryClient, [SPAM]);

    renderDetail(queryClient);

    await waitFor(() => expect(media()).toBe('true'));
  });

  it('hides media at once when the last visit found a sensitive report', async () => {
    const queryClient = appQueryClient();
    await visitOnce(queryClient, [OLD_BUILD]);

    relay.answer = () => new Promise(() => {});
    renderDetail(queryClient);

    expect(media()).toBe('false');
  });

  // The events page keeps this pane mounted when the moderator picks another
  // event, so coming back to an event is a change of event, not a new mount.
  describe('when the pane moves back to an event', () => {
    const ui = (queryClient: QueryClient, event: NostrEvent) => (
      <QueryClientProvider client={queryClient}><EventDetail event={event} /></QueryClientProvider>
    );

    async function visitAndMoveOn(queryClient: QueryClient) {
      reports.value = [SPAM];
      const view = render(ui(queryClient, EVENT));
      await waitFor(() => expect(media()).toBe('true'));
      view.rerender(ui(queryClient, OTHER_EVENT));
      await waitFor(() => expect(media()).toBe('true'));
      return view;
    }

    it('starts hidden until the read for this return has answered', async () => {
      const queryClient = appQueryClient();
      const { rerender } = await visitAndMoveOn(queryClient);

      relay.answer = () => new Promise(() => {});
      rerender(ui(queryClient, EVENT));

      expect(media()).toBe('null');
    });

    it('shows media once the read for this return finds nothing sensitive', async () => {
      const queryClient = appQueryClient();
      const { rerender } = await visitAndMoveOn(queryClient);

      rerender(ui(queryClient, EVENT));

      await waitFor(() => expect(media()).toBe('true'));
    });
  });
});

// A profile (kind 0) event's picture and banner follow the same rule as the
// event's media.
describe('EventDetail profile images', () => {
  const PICTURE = 'https://example.invalid/picture.png';
  const BANNER = 'https://example.invalid/banner.png';
  const PROFILE_EVENT: NostrEvent = {
    ...EVENT,
    kind: 0,
    content: JSON.stringify({ name: 'someone', picture: PICTURE, banner: BANNER }),
  };
  function renderProfile() {
    return render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <EventDetail event={PROFILE_EVENT} />
      </QueryClientProvider>,
    );
  }

  it('creates no image for them while the reports read is still out', () => {
    relay.answer = () => new Promise(() => {});
    expect(imagesCreatedDuring(() => { renderProfile(); })).toBe(0);
  });

  it('shows them once the reports are known and none is sensitive', async () => {
    reports.value = [SPAM];
    const { container } = renderProfile();
    await waitFor(() => expect(imageSrcs(container)).toEqual([BANNER, PICTURE]));
  });

  it('keeps them hidden on a sensitive report until asked for', async () => {
    reports.value = [OLD_BUILD];
    const { container } = renderProfile();
    await screen.findByText('1 Related Report');
    expect(imageSrcs(container)).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: 'Show profile images' }));

    expect(imageSrcs(container)).toEqual([BANNER, PICTURE]);
  });

  it('hides them again when the reports turn out sensitive after a Show while they loaded', async () => {
    const answers: ((events: unknown[]) => void)[] = [];
    relay.answer = () => new Promise<unknown[]>((resolve) => { answers.push(resolve); });
    const { container } = renderProfile();
    fireEvent.click(screen.getByRole('button', { name: 'Show profile images' }));
    expect(imageSrcs(container)).toEqual([BANNER, PICTURE]);

    await act(async () => { answers.forEach(answer => answer([OLD_BUILD])); });
    await screen.findByText('1 Related Report');

    expect(imageSrcs(container)).toEqual([]);
  });

  // The events page keeps this pane mounted when another event is picked.
  it("does not carry a Show into the next profile event's images", async () => {
    reports.value = [OLD_BUILD];
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const ui = (event: NostrEvent) => (
      <QueryClientProvider client={queryClient}><EventDetail event={event} /></QueryClientProvider>
    );
    const { container, rerender } = render(ui(PROFILE_EVENT));
    await screen.findByText('1 Related Report');
    fireEvent.click(screen.getByRole('button', { name: 'Show profile images' }));
    expect(imageSrcs(container)).toEqual([BANNER, PICTURE]);

    rerender(ui({ ...PROFILE_EVENT, id: 'b'.repeat(64) }));

    expect(imageSrcs(container)).toEqual([]);
  });
});

// The author card shows the author's current picture, which follows the same
// rule as the event's media.
describe("EventDetail author's picture", () => {
  const AUTHOR_PICTURE = 'https://example.invalid/author.png';

  beforeEach(() => {
    authors.pictures = { [REPORTED_PUBKEY]: AUTHOR_PICTURE };
  });

  it('creates no image for it while the reports read is still out', () => {
    relay.answer = () => new Promise(() => {});
    expect(imagesCreatedDuring(() => { renderDetail(); })).toBe(0);
  });

  it('shows it once the reports are known and none is sensitive', async () => {
    reports.value = [SPAM];
    const { container } = renderDetail();
    await waitFor(() => expect(imageSrcs(container)).toEqual([AUTHOR_PICTURE]));
  });

  it('keeps it hidden on a sensitive report until asked for', async () => {
    reports.value = [OLD_BUILD];
    const { container } = renderDetail();
    await screen.findByText('1 Related Report');
    expect(imageSrcs(container)).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: 'Show profile picture' }));

    expect(imageSrcs(container)).toEqual([AUTHOR_PICTURE]);
  });

  it('hides it again when the reports turn out sensitive after a Show while they loaded', async () => {
    const answers: ((events: unknown[]) => void)[] = [];
    relay.answer = () => new Promise<unknown[]>((resolve) => { answers.push(resolve); });
    const { container } = renderDetail();
    fireEvent.click(screen.getByRole('button', { name: 'Show profile picture' }));
    expect(imageSrcs(container)).toEqual([AUTHOR_PICTURE]);

    await act(async () => { answers.forEach(answer => answer([OLD_BUILD])); });
    await screen.findByText('1 Related Report');

    expect(imageSrcs(container)).toEqual([]);
  });

  // The verdict is about this event and its author, not accounts it names.
  it("leaves a referenced account's picture as it was", () => {
    const REFERENCED = '7'.repeat(64);
    const REFERENCED_PICTURE = 'https://example.invalid/referenced.png';
    authors.pictures[REFERENCED] = REFERENCED_PICTURE;
    relay.answer = () => new Promise(() => {});
    const { container } = render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <EventDetail event={{ ...EVENT, tags: [['p', REFERENCED]] }} />
      </QueryClientProvider>,
    );

    expect(imageSrcs(container)).toEqual([REFERENCED_PICTURE]);
    // Only the author's card has a show or hide control for its picture.
    expect(screen.getAllByRole('button', { name: /^(Show|Hide) profile picture$/ })).toHaveLength(1);
  });
});
