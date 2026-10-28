// ABOUTME: Tests that the full-thread view withholds every participant's avatar image
// ABOUTME: on a sensitive report, replies included, and loads them otherwise

import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import type { NostrEvent, NostrFilter } from '@nostrify/nostrify';
import { ThreadModal } from './ThreadModal';

const PICTURE = 'https://example.invalid/a.png';

// A post and a Divine comment (NIP-22, kind 1111) on it.
const thread = vi.hoisted(() => {
  const root: NostrEvent = {
    id: '1'.repeat(64), pubkey: 'a'.repeat(64), kind: 1, tags: [],
    content: 'the root post', created_at: 1_750_000_000, sig: 'f'.repeat(128),
  };
  const reply: NostrEvent = {
    id: '2'.repeat(64), pubkey: 'b'.repeat(64), kind: 1111,
    tags: [['E', root.id, '', root.pubkey], ['K', '1'], ['P', root.pubkey], ['e', root.id, '', root.pubkey], ['k', '1'], ['p', root.pubkey]],
    content: 'a reply', created_at: 1_750_000_100, sig: 'f'.repeat(128),
  };
  return { root, reply };
});

// An id lookup returns that event; the reply filters return the comment.
vi.mock('@nostrify/react', () => ({
  useNostr: () => ({
    nostr: {
      query: async (filters: NostrFilter[]) => filters[0].ids
        ? [thread.root, thread.reply].filter(e => filters[0].ids!.includes(e.id))
        : [thread.reply],
    },
  }),
}));
vi.mock('@/hooks/useAppContext', () => ({
  useAppContext: () => ({ config: { apiUrl: 'https://api.example.invalid' } }),
}));
vi.mock('@/hooks/useAuthor', () => ({
  useAuthor: () => ({ data: { metadata: { name: 'someone', picture: 'https://example.invalid/a.png' } }, isLoading: false }),
}));

// Radix's AvatarImage starts loading its src as soon as it mounts (jsdom never
// finishes the load, so no <img> would appear either way). Whether the stand-in
// mounts is the meaningful check.
vi.mock('@/components/ui/avatar', () => ({
  Avatar: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  AvatarImage: ({ src }: { src?: string }) => <img data-testid="avatar-img" src={src} />,
  AvatarFallback: ({ children }: { children: React.ReactNode }) => <span data-testid="avatar-fallback">{children}</span>,
}));

function renderModal(hideAvatars?: boolean) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ThreadModal eventId={thread.root.id} open onOpenChange={() => {}} hideAvatars={hideAvatars} />
    </QueryClientProvider>,
  );
}

describe('ThreadModal hideAvatars', () => {
  it('loads the root and reply avatars when not set (existing behavior)', async () => {
    renderModal();
    await screen.findByText('a reply');
    const imgs = screen.getAllByTestId('avatar-img');
    expect(imgs).toHaveLength(2);
    expect(imgs.every(i => i.getAttribute('src') === PICTURE)).toBe(true);
  });

  it('mounts no avatar image for the root post or a reply when set, and keeps the fallback', async () => {
    renderModal(true);
    await screen.findByText('a reply');
    expect(screen.getByText('the root post')).toBeInTheDocument();
    expect(screen.queryAllByTestId('avatar-img')).toHaveLength(0);
    expect(screen.getAllByTestId('avatar-fallback')).toHaveLength(2);
  });
});
