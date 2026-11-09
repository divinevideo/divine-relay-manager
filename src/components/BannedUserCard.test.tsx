// ABOUTME: Tests BannedUserCard's recent-content query kinds and rendering —
// ABOUTME: banned comment-spam accounts must not show "No posts found" (#159)

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { NostrEvent } from '@nostrify/nostrify';
import { RECENT_CONTENT_KINDS } from '@/lib/constants';
import { AppProvider } from '@/components/AppProvider';
import { BannedUserCard } from './BannedUserCard';

// The card reads through queryStrict, which drives nostr.req and needs EOSE to
// count a read as finished. NPool.query would resolve [] on a failed read.
const relayQuery = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock('@nostrify/react', () => ({
  useNostr: () => ({ nostr: { req: relayQuery.fn } }),
}));

// Profile loading is useAuthor's concern (tested elsewhere); these tests
// exercise the recent-content query and rendering.
const authorState = vi.hoisted(() => ({
  data: undefined as { metadata: Record<string, unknown> } | undefined,
}));
vi.mock('@/hooks/useAuthor', () => ({
  useAuthor: () => ({ data: authorState.data, isLoading: false }),
}));

// The batched parent-title hook is mocked so comment-row links are deterministic;
// calls are recorded so tests can assert what resolution was requested and when
const titleCalls = vi.hoisted(() => ({ targets: [] as string[][] }));
vi.mock('@/hooks/useEventTitles', () => ({
  useEventTitles: (targets: string[]) => {
    titleCalls.targets.push(targets);
    return {
      titles: new Map(targets.map(t => [t, { target: t, title: 'Parent Video', encoded: 'nevent1parent' }])),
      isLoading: false,
    };
  },
}));

const PUBKEY = 'a'.repeat(64);

const T = 1_750_000_000;

function event(kind: number, content: string, idByte: string, tags: string[][] = [], created_at = T + kind): NostrEvent {
  return {
    id: idByte.repeat(64),
    pubkey: PUBKEY,
    kind,
    content,
    tags,
    created_at,
    sig: 'f'.repeat(128),
  };
}

const AUTHORED: NostrEvent[] = [
  event(1111, 'repetitive scam comment', '1'),
  event(16, JSON.stringify({ content: 'inner reposted text', kind: 22, pubkey: 'b'.repeat(64) }), '2'),
  event(1, 'plain note', '3'),
];

// Point the relay mock's content query at a specific fixture set (profiles
// go through the mocked useAuthor, so every nostr.req call here is the
// content query): the events, then EOSE. Yields copies — the component sorts
// its results, and a shared-reference fixture would be mutated across tests.
function setAuthored(events: NostrEvent[]) {
  relayQuery.fn.mockImplementation(async function* () {
    for (const e of events) yield ['EVENT', 'sub', { ...e }];
    yield ['EOSE', 'sub'];
  });
}

/** A read the relay cut short: Funnelcake's "could not complete query" close. */
function setReadCutShort() {
  relayQuery.fn.mockImplementation(async function* () {
    yield ['CLOSED', 'sub', 'error: could not complete query'];
  });
}

/** A read that never answers. */
function setReadHangs() {
  relayQuery.fn.mockImplementation(() => ({
    [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
  }));
}

function renderCard(props: Partial<React.ComponentProps<typeof BannedUserCard>> = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return { client, ...render(
    <AppProvider storageKey="test-app-config" defaultConfig={{ theme: 'light', relayUrl: 'wss://relay.test', apiUrl: 'https://api.test' }}>
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <BannedUserCard pubkey={PUBKEY} {...props} />
        </MemoryRouter>
      </QueryClientProvider>
    </AppProvider>
  ) };
}

beforeEach(() => {
  authorState.data = undefined;
  relayQuery.fn.mockReset();
  titleCalls.targets.length = 0;
  setAuthored(AUTHORED);
});

describe('BannedUserCard', () => {
  it('queries the shared moderation-relevant kinds, not just kind 1', async () => {
    renderCard();

    await waitFor(() => {
      const postFilter = relayQuery.fn.mock.calls
        .map(args => args[0]?.[0])
        .find(f => f?.kinds && !f.kinds.includes(0));
      expect(postFilter?.kinds).toEqual([...RECENT_CONTENT_KINDS]);
      // The kinds this issue exists for must never fall out of the list
      expect(postFilter?.kinds).toContain(1111);
      expect(postFilter?.kinds).toContain(6);
      expect(postFilter?.kinds).toContain(16);
    });
  });

  it('shows a banned comment-only account\'s comments with the Comment badge', async () => {
    renderCard();

    fireEvent.click(await screen.findByRole('button', { name: /toggle details/i }));

    expect(await screen.findByText('repetitive scam comment')).toBeInTheDocument();
    expect(screen.getByText('Comment')).toBeInTheDocument();
  });

  it('renders reposts as labeled inner content, not raw NIP-18 JSON', async () => {
    renderCard();

    fireEvent.click(await screen.findByRole('button', { name: /toggle details/i }));

    expect(await screen.findByText(/inner reposted text/)).toBeInTheDocument();
    expect(screen.getByText('Repost')).toBeInTheDocument();
    expect(screen.queryByText(/"content"/)).not.toBeInTheDocument();
    expect(screen.queryByText(/"pubkey"/)).not.toBeInTheDocument();
  });

  it('counts all authored events, labeled as events rather than posts', async () => {
    renderCard();

    expect(await screen.findByText(/3 events on relay/)).toBeInTheDocument();
  });

  it('shows the newest 3 events regardless of relay result order', async () => {
    // Relay order deliberately scrambled and NOT newest-first
    setAuthored([
      event(1, 'ancient note', '4', [], T - 9999),
      event(1, 'middle note', '5', [], T + 200),
      event(1, 'newest note', '6', [], T + 300),
      event(1, 'older note', '7', [], T + 100),
    ]);
    renderCard();

    fireEvent.click(await screen.findByRole('button', { name: /toggle details/i }));

    expect(await screen.findByText('newest note')).toBeInTheDocument();
    expect(screen.getByText('middle note')).toBeInTheDocument();
    expect(screen.getByText('older note')).toBeInTheDocument();
    expect(screen.queryByText('ancient note')).not.toBeInTheDocument();
  });

  it('identifies the target of an empty-content repost (NIP-18 allows empty content)', async () => {
    const target = 'c'.repeat(64);
    setAuthored([event(6, '', '8', [['e', target]])]);
    renderCard();

    fireEvent.click(await screen.findByRole('button', { name: /toggle details/i }));

    expect(await screen.findByText(`reposted event ${target}`)).toBeInTheDocument();
  });

  it("shows a repost's readable inner text even when a kind claim tries to disguise it", async () => {
    // A reposter could tag readable spam ['k','1064'] to try to hide it; the
    // card must still surface the text (evidence), never blank it.
    setAuthored([
      event(16, JSON.stringify({ content: 'FREE GIVEAWAY click my profile', pubkey: 'b'.repeat(64) }), '9', [['e', 'c'.repeat(64)], ['k', '1064']]),
    ]);
    renderCard();

    fireEvent.click(await screen.findByRole('button', { name: /toggle details/i }));

    expect(await screen.findByText(/FREE GIVEAWAY click my profile/)).toBeInTheDocument();
  });

  it('identifies a-tag-only addressable reposts (NIP-18 latest-version pattern)', async () => {
    const coordinate = `34236:${'b'.repeat(64)}:my-video`;
    setAuthored([event(16, '', '9', [['k', '34236'], ['a', coordinate]])]);
    renderCard();

    fireEvent.click(await screen.findByRole('button', { name: /toggle details/i }));

    expect(await screen.findByText(`reposted ${coordinate}`)).toBeInTheDocument();
  });

  it('preserves out-of-spec repost content as moderation evidence instead of discarding it', async () => {
    setAuthored([event(6, 'plain text spam pushed as a repost', '9')]);
    renderCard();

    fireEvent.click(await screen.findByRole('button', { name: /toggle details/i }));

    expect(await screen.findByText(/plain text spam pushed as a repost/)).toBeInTheDocument();
  });

  it('shows the comment spray roll-up over all fetched comments (#164 A)', async () => {
    setAuthored([
      event(1111, 'x', '1', [['E', 'e'.repeat(64)], ['K', '34236']]),
      event(1111, 'y', '2', [['E', 'd'.repeat(64)], ['K', '34236']]),
      event(1111, 'z', '3', [['E', 'c'.repeat(64)], ['K', '34236']]),
      event(1111, 'w', '4', [['E', 'b'.repeat(64)], ['K', '34236']]),
    ]);
    renderCard();

    // Roll-up lives in the always-visible stats row (no expand needed)
    expect(await screen.findByText(/4 comments across 4 videos/)).toBeInTheDocument();
  });

  it('renders an "on <parent>" link on a comment row (#164 A)', async () => {
    setAuthored([event(1111, 'scam', '1', [['E', 'e'.repeat(64)], ['K', '34236']])]);
    renderCard();

    fireEvent.click(await screen.findByRole('button', { name: /toggle details/i }));

    const link = await screen.findByRole('link', { name: /on Parent Video/ });
    expect(link).toHaveAttribute('href', '/events?event=nevent1parent');
  });

  it('requests no parent-title resolution while the card is collapsed (#165 review)', async () => {
    setAuthored([
      event(1111, 'x', '1', [['E', 'e'.repeat(64)], ['K', '34236']]),
      event(1111, 'y', '2', [['E', 'd'.repeat(64)], ['K', '34236']]),
    ]);
    renderCard();

    // Content query settled (roll-up rendered) with the card still collapsed
    expect(await screen.findByText(/2 comments across 2 videos/)).toBeInTheDocument();

    expect(titleCalls.targets.flat()).toEqual([]);
  });

  it('resolves parent titles only for the 3 rendered rows once open (#165 review)', async () => {
    // 5 comments fetched; only the newest 3 render as rows
    setAuthored([
      event(1111, 'v', '1', [['E', 'b'.repeat(64)], ['K', '34236']], T + 1),
      event(1111, 'w', '2', [['E', 'c'.repeat(64)], ['K', '34236']], T + 2),
      event(1111, 'x', '3', [['E', 'd'.repeat(64)], ['K', '34236']], T + 3),
      event(1111, 'y', '4', [['E', 'e'.repeat(64)], ['K', '34236']], T + 4),
      event(1111, 'z', '5', [['E', 'f'.repeat(64)], ['K', '34236']], T + 5),
    ]);
    renderCard();

    fireEvent.click(await screen.findByRole('button', { name: /toggle details/i }));
    await screen.findAllByRole('link', { name: /on Parent Video/ });

    // Newest 3 targets only — the 2 never-rendered comments are not resolved
    expect(titleCalls.targets.at(-1)).toEqual(['f'.repeat(64), 'e'.repeat(64), 'd'.repeat(64)]);
  });
});

describe('BannedUserCard event count', () => {
  it('does not print a read the relay cut short as zero', async () => {
    setReadCutShort();
    renderCard();

    expect(await screen.findByText(/events on relay unavailable/, {}, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.queryByText(/0 events on relay/)).not.toBeInTheDocument();
  });

  it('does not say the account has no content when the read was cut short', async () => {
    setReadCutShort();
    renderCard();
    await screen.findByText(/events on relay unavailable/, {}, { timeout: 4000 });

    fireEvent.click(screen.getByRole('button', { name: /toggle details/i }));

    expect(screen.queryByText(/No recent content found/)).not.toBeInTheDocument();
    expect(screen.getByText(/Couldn't load this account's content/)).toBeInTheDocument();
  });

  it('does not print a read that has not answered as zero', () => {
    setReadHangs();
    renderCard();

    expect(screen.getByText(/checking events on relay/)).toBeInTheDocument();
    expect(screen.queryByText(/0 events on relay/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /toggle details/i }));
    expect(screen.queryByText(/No recent content found/)).not.toBeInTheDocument();
  });

  // The card asks the relay for at most 50 events, so a full page may not be
  // the account's total.
  it('marks a count that reached the read limit as a floor', async () => {
    setAuthored(Array.from({ length: 50 }, (_, i) => event(1, `note ${i}`, i.toString(16).padStart(2, '0'), [], T + i)));
    renderCard();

    expect(await screen.findByText(/50\+ events on relay/)).toBeInTheDocument();
    // The floor is right only because the read asked for exactly 50.
    const postFilter = relayQuery.fn.mock.calls.map(args => args[0]?.[0]).find(f => f?.authors);
    expect(postFilter?.limit).toBe(50);
  });

  it('prints a count under the read limit exactly', async () => {
    setAuthored(Array.from({ length: 49 }, (_, i) => event(1, `note ${i}`, i.toString(16).padStart(2, '0'), [], T + i)));
    renderCard();

    expect(await screen.findByText(/^49 events on relay$/)).toBeInTheDocument();
  });

  // The read throws on failure now, so it gets ReporterCard's one retry: a
  // single dropped subscription should not show "unavailable".
  it('retries a failed read once before saying it is unavailable', async () => {
    setReadCutShort();
    renderCard();

    await screen.findByText(/events on relay unavailable/, {}, { timeout: 4000 });
    expect(relayQuery.fn).toHaveBeenCalledTimes(2);
  });

  // React Query keeps the last good data when a refresh fails. A count kept that
  // way is what the relay said before, not what it says now.
  it('marks a kept count as last known when a refresh fails', async () => {
    setAuthored([]);
    const { client } = renderCard();
    expect(await screen.findByText(/^0 events on relay$/)).toBeInTheDocument();

    setReadCutShort();
    await act(async () => { await client.refetchQueries(); });

    expect(await screen.findByText(/^0 events on relay \(last known\)$/, {}, { timeout: 4000 })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /toggle details/i }));
    expect(screen.queryByText(/^No recent content found on this relay$/)).not.toBeInTheDocument();
    expect(screen.getByText(/latest refresh failed/)).toBeInTheDocument();
  });

  it('still says a completed empty read is empty', async () => {
    setAuthored([]);
    renderCard();

    expect(await screen.findByText(/0 events on relay/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /toggle details/i }));
    expect(screen.getByText(/No recent content found on this relay/)).toBeInTheDocument();
  });

  it("says a suspended account's empty read is the suspension, not an empty account", async () => {
    setAuthored([]);
    renderCard({ suspended: true });

    expect(await screen.findByText(/events on relay hidden \(account suspended\)/)).toBeInTheDocument();
    expect(screen.queryByText(/0 events on relay/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /toggle details/i }));
    expect(screen.queryByText(/No recent content found/)).not.toBeInTheDocument();
    expect(screen.getByText(/relay hides a suspended account's content/)).toBeInTheDocument();
  });
});

describe('BannedUserCard claimed nip05', () => {
  it('marks it unverified', () => {
    authorState.data = { metadata: { name: 'synthetic', nip05: 'synthetic@example.test' } };
    renderCard();
    expect(screen.getByText('synthetic@example.test').parentElement).toHaveTextContent('(unverified)');
  });
});
