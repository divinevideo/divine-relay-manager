// ABOUTME: Tests BannedUserCard's recent-content query kinds and rendering —
// ABOUTME: banned comment-spam accounts must not show "No posts found" (#159)

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { NostrEvent } from '@nostrify/nostrify';
import { RECENT_CONTENT_KINDS } from '@/lib/constants';
import { BannedUserCard } from './BannedUserCard';

const relayQuery = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock('@nostrify/react', () => ({
  useNostr: () => ({ nostr: { query: relayQuery.fn } }),
}));

// Profile loading is useAuthor's concern (tested elsewhere); these tests
// exercise the recent-content query and rendering.
vi.mock('@/hooks/useAuthor', () => ({
  useAuthor: () => ({ data: undefined, isLoading: false }),
}));

// The batched parent-title hook is mocked so comment-row links are deterministic
vi.mock('@/hooks/useEventTitles', () => ({
  useEventTitles: (targets: string[]) => ({
    titles: new Map(targets.map(t => [t, { target: t, title: 'Parent Video', encoded: 'nevent1parent' }])),
    isLoading: false,
  }),
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
// go through the mocked useAuthor, so every nostr.query call here is the
// content query). Returns a copy — the component sorts its results, and a
// shared-reference fixture would be mutated across tests.
function setAuthored(events: NostrEvent[]) {
  relayQuery.fn.mockImplementation(async () => [...events]);
}

function renderCard() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <BannedUserCard pubkey={PUBKEY} />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  relayQuery.fn.mockReset();
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
});
