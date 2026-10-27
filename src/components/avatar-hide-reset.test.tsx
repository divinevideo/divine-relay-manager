// ABOUTME: Tests that a hidden avatar shows its initials even after its image
// ABOUTME: had loaded, using the real Radix avatar with an image that loads

import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NostrEvent } from '@nostrify/nostrify';
import { UserProfileCard } from './UserProfileCard';
import { ThreadContext } from './ThreadContext';
import { ThreadModal } from './ThreadModal';
import { UserIdentifier } from './UserIdentifier';
import type { UserStats } from '@/hooks/useUserStats';

vi.mock('@/hooks/useAdminApi', () => ({
  useApiUrl: () => 'https://api.example.invalid',
}));

// The full-thread view reads its thread from the relay: one post, no replies.
const threadRoot = vi.hoisted((): NostrEvent => ({
  id: '3'.repeat(64), pubkey: 'c'.repeat(64), kind: 1, tags: [], content: 'root post',
  created_at: 1_750_000_000, sig: 'f'.repeat(128),
}));
vi.mock('@nostrify/react', () => ({
  useNostr: () => ({
    nostr: { query: async (filters: { ids?: string[] }[]) => (filters[0].ids ? [threadRoot] : []) },
  }),
}));
vi.mock('@/hooks/useAppContext', () => ({
  useAppContext: () => ({ config: { apiUrl: 'https://api.example.invalid' } }),
}));

vi.mock('@/hooks/useEventTitles', () => ({
  useEventTitles: () => ({ titles: new Map(), isLoading: false }),
}));

vi.mock('@/hooks/useAuthor', () => ({
  useAuthor: () => ({ data: { metadata: { name: 'someone', picture: 'https://example.invalid/a.png' } }, isLoading: false }),
}));

// jsdom never loads images, so Radix never reaches "loaded" and the bug can't
// show. Radix reads complete and naturalWidth to decide an image has loaded.
class LoadedImage {
  complete = true;
  naturalWidth = 1;
  src = '';
  addEventListener() {}
  removeEventListener() {}
}

beforeEach(() => { vi.stubGlobal('Image', LoadedImage); });
afterEach(() => { vi.unstubAllGlobals(); });

const PUBKEY = 'a'.repeat(64);

const STATS: UserStats = {
  postCount: 0,
  reportCount: 0,
  labelCount: 0,
  recentPosts: [],
  existingLabels: [],
  previousReports: [],
  authoredContentIncomplete: false,
  labelsIncomplete: false,
  reportsIncomplete: false,
  reportsTruncated: false,
  labelsTruncated: false,
  relayIncomplete: false,
};

function profileCard(hide: boolean) {
  return (
    <MemoryRouter>
      <UserProfileCard
        pubkey={PUBKEY}
        profile={{ name: 'someone', picture: 'https://example.invalid/a.png' }}
        stats={STATS}
        hideMediaByDefault={hide}
      />
    </MemoryRouter>
  );
}

describe('UserProfileCard avatar after its image loaded', () => {
  it('shows the initials again after Show then Hide', () => {
    render(profileCard(true));
    fireEvent.click(screen.getByRole('button', { name: 'Show profile picture' }));
    expect(screen.getByRole('img')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Hide profile picture' }));
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getByText('SO')).toBeInTheDocument();
  });

  // The pane reuses the card when the moderator moves from a non-sensitive
  // report to a sensitive one on the same account.
  it('shows the initials when a loaded avatar becomes hidden', () => {
    const { rerender } = render(profileCard(false));
    expect(screen.getByRole('img')).toBeInTheDocument();
    rerender(profileCard(true));
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getByText('SO')).toBeInTheDocument();
  });
});

describe('UserIdentifier avatar after its image loaded', () => {
  for (const variant of ['inline', 'block', 'compact'] as const) {
    it(`shows the initials when a loaded avatar becomes hidden (${variant})`, () => {
      const { rerender } = render(<UserIdentifier pubkey={PUBKEY} showAvatar variant={variant} />);
      expect(screen.getByRole('img')).toBeInTheDocument();
      rerender(<UserIdentifier pubkey={PUBKEY} showAvatar hideAvatarImage variant={variant} />);
      expect(screen.queryByRole('img')).not.toBeInTheDocument();
      expect(screen.getByText('SO')).toBeInTheDocument();
    });
  }
});

describe('ThreadContext avatar after its image loaded', () => {
  const note: NostrEvent = { id: '2'.repeat(64), pubkey: 'b'.repeat(64), kind: 1, tags: [], content: 'post', created_at: 1_750_000_000, sig: 'f'.repeat(128) };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const thread = (hide: boolean) => (
    <QueryClientProvider client={client}>
      <ThreadContext ancestors={[]} reportedEvent={note} replies={[]} reportedPubkey={note.pubkey} hideAvatars={hide} />
    </QueryClientProvider>
  );

  it('shows the initials when a loaded avatar becomes hidden', () => {
    const { rerender } = render(thread(false));
    expect(screen.getByRole('img')).toBeInTheDocument();
    rerender(thread(true));
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getByText('SO')).toBeInTheDocument();
  });
});

// The report pane keeps its full-thread view when the moderator moves to a
// sensitive report, so the same avatar goes from loaded to hidden.
describe('ThreadModal avatar after its image loaded', () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const modal = (hide: boolean) => (
    <QueryClientProvider client={client}>
      <ThreadModal eventId={threadRoot.id} open onOpenChange={() => {}} hideAvatars={hide} />
    </QueryClientProvider>
  );

  it('shows the initials when a loaded avatar becomes hidden', async () => {
    const { rerender } = render(modal(false));
    expect(await screen.findByRole('img')).toBeInTheDocument();
    rerender(modal(true));
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getByText('SO')).toBeInTheDocument();
  });
});
