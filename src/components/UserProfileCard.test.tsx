// ABOUTME: Tests UserProfileCard's recent-content badge mapping and the
// ABOUTME: View Activity drill-down added for report review (#156)

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { NostrEvent } from '@nostrify/nostrify';
import { UserProfileCard } from './UserProfileCard';
import type { UserStats } from '@/hooks/useUserStats';

vi.mock('@/hooks/useAdminApi', () => ({
  useApiUrl: () => 'https://api.example.test',
}));

// Media preview fetches/renders remote content; irrelevant to badge mapping
vi.mock('@/components/MediaPreview', () => ({
  InlineMediaPreview: () => null,
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

function post(kind: number, content: string, idByte: string, tags: string[][] = []): NostrEvent {
  return {
    id: idByte.repeat(64),
    pubkey: PUBKEY,
    kind,
    content,
    tags,
    created_at: 1_750_000_000,
    sig: 'f'.repeat(128),
  };
}

// Keep to 5 posts — RecentPostsSection shows slice(0, 5) before "Show all"
const RECENT: NostrEvent[] = [
  post(21, 'a video', '1'),
  post(1111, 'scam comment text', '2'),
  post(16, JSON.stringify({ content: 'inner reposted text', kind: 34236, pubkey: 'b'.repeat(64) }), '3'),
  post(1, 'plain note', '4'),
  post(30023, 'long form', '5'),
];

function stats(recentPosts: NostrEvent[]): UserStats {
  return {
    postCount: recentPosts.length,
    reportCount: 0,
    labelCount: 0,
    recentPosts,
    existingLabels: [],
    previousReports: [],
  };
}

describe('UserProfileCard', () => {
  it('maps recent-content kinds to the right badges (no kind mislabeled as text note)', () => {
    render(<UserProfileCard pubkey={PUBKEY} stats={stats(RECENT)} />);

    expect(screen.getByText('Video')).toBeInTheDocument(); // kind 21
    expect(screen.getByText('Comment')).toBeInTheDocument(); // kind 1111
    expect(screen.getByText('Repost')).toBeInTheDocument(); // kind 16
    expect(screen.getByText('Note')).toBeInTheDocument(); // kind 1 only
    expect(screen.getByText('Long-form Article')).toBeInTheDocument(); // named via getKindName
    // Exactly one "Note" badge: non-1 kinds must not fall through to it
    expect(screen.getAllByText('Note')).toHaveLength(1);
  });

  it('renders repost inner content with a label instead of raw NIP-18 JSON', () => {
    render(<UserProfileCard pubkey={PUBKEY} stats={stats(RECENT)} />);

    expect(screen.getByText(/inner reposted text/)).toBeInTheDocument();
    expect(screen.queryByText(/"kind":34236/)).not.toBeInTheDocument();
    // Attribution: full inner pubkey surfaced via tooltip (never truncated)
    expect(screen.getByText(/reposted:/)).toHaveAttribute(
      'title',
      `Reposted from pubkey ${'b'.repeat(64)}`
    );
  });

  it('identifies the target event for an empty-content repost', () => {
    const emptyRepost = post(16, '', '6', [['e', 'c'.repeat(64)]]);
    render(<UserProfileCard pubkey={PUBKEY} stats={stats([emptyRepost])} />);

    expect(screen.getByText('Repost')).toBeInTheDocument();
    expect(screen.getByText(`reposted event ${'c'.repeat(64)}`)).toBeInTheDocument();
  });

  it("shows a repost's readable inner text even when a kind claim tries to disguise it", () => {
    // A reposter could tag readable spam ['k','1064'] to try to hide it; the
    // card must still surface the text (evidence), never blank it.
    const disguised = post(
      16,
      JSON.stringify({ content: 'FREE GIVEAWAY click my profile', kind: 1064, pubkey: 'b'.repeat(64) }),
      '7',
      [['e', 'c'.repeat(64)], ['k', '1064']]
    );
    render(<UserProfileCard pubkey={PUBKEY} stats={stats([disguised])} />);

    expect(screen.getByText(/FREE GIVEAWAY click my profile/)).toBeInTheDocument();
  });

  it('shows View Activity only when onViewActivity is provided, and fires it', () => {
    const onViewActivity = vi.fn();

    const { rerender } = render(
      <UserProfileCard pubkey={PUBKEY} stats={stats(RECENT)} onViewActivity={onViewActivity} />
    );
    fireEvent.click(screen.getByRole('button', { name: /view activity/i }));
    expect(onViewActivity).toHaveBeenCalledTimes(1);

    rerender(<UserProfileCard pubkey={PUBKEY} stats={stats(RECENT)} />);
    expect(screen.queryByRole('button', { name: /view activity/i })).not.toBeInTheDocument();
  });
});

describe('UserProfileCard comment context', () => {
  beforeEach(() => {
    titleCalls.targets.length = 0;
  });

  it('shows the spray roll-up and a per-row "on <parent>" link for comments', () => {
    const recent = [
      post(1111, 'spam comment', '1', [['E', 'e'.repeat(64)], ['K', '34236']]),
      post(1111, 'spam comment', '2', [['E', 'd'.repeat(64)], ['K', '34236']]),
    ];
    render(
      <MemoryRouter>
        <UserProfileCard pubkey={PUBKEY} stats={stats(recent)} />
      </MemoryRouter>
    );
    expect(screen.getByText(/2 comments across 2 videos/)).toBeInTheDocument();
    const link = screen.getAllByRole('link', { name: /on Parent Video/ })[0];
    expect(link).toHaveAttribute('href', '/events?event=nevent1parent');
  });

  it('resolves parent titles only for visible rows, widening on Show all (#165 review)', () => {
    // 7 comments; only 5 rows are visible before "Show all"
    const recent = ['1', '2', '3', '4', '5', '6', '7'].map((b, i) =>
      post(1111, `comment ${b}`, b, [['E', String.fromCharCode(98 + i).repeat(64)], ['K', '34236']])
    );
    render(
      <MemoryRouter>
        <UserProfileCard pubkey={PUBKEY} stats={stats(recent)} />
      </MemoryRouter>
    );

    // Visible slice only — the 2 hidden rows are not resolved
    expect(titleCalls.targets.at(-1)).toEqual(
      ['b', 'c', 'd', 'e', 'f'].map(ch => ch.repeat(64))
    );

    fireEvent.click(screen.getByRole('button', { name: /show 2 more events/i }));
    expect(titleCalls.targets.at(-1)).toEqual(
      ['b', 'c', 'd', 'e', 'f', 'g', 'h'].map(ch => ch.repeat(64))
    );
  });

  it('requests no parent-title resolution while the section is collapsed (#165 review)', () => {
    const recent = [
      post(1111, 'spam comment', '1', [['E', 'e'.repeat(64)], ['K', '34236']]),
    ];
    render(
      <MemoryRouter>
        <UserProfileCard pubkey={PUBKEY} stats={stats(recent)} />
      </MemoryRouter>
    );

    fireEvent.click(screen.getByRole('button', { name: /toggle recent content/i }));
    expect(titleCalls.targets.at(-1)).toEqual([]);
  });
});
