// ABOUTME: Tests that ThreadContext withholds every participant's avatar image
// ABOUTME: on a sensitive report, and loads them otherwise

import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import type { NostrEvent } from '@nostrify/nostrify';
import { ThreadContext } from './ThreadContext';

const PICTURE = 'https://example.invalid/a.png';

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

function note(idByte: string, pubkeyByte: string, kind = 1): NostrEvent {
  return { id: idByte.repeat(64), pubkey: pubkeyByte.repeat(64), kind, tags: [], content: `post ${idByte}`, created_at: 1_750_000_000, sig: 'f'.repeat(128) };
}

function renderThread(hideAvatars?: boolean) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ThreadContext
        ancestors={[note('1', 'a')]}
        reportedEvent={note('2', 'b')}
        replies={[note('3', 'c', 1111)]}
        reportedPubkey={'b'.repeat(64)}
        hideAvatars={hideAvatars}
      />
    </QueryClientProvider>,
  );
}

describe('ThreadContext hideAvatars', () => {
  it('loads every participant avatar when not set (existing behavior)', () => {
    renderThread();
    const imgs = screen.getAllByTestId('avatar-img');
    expect(imgs).toHaveLength(3);
    expect(imgs.every(i => i.getAttribute('src') === PICTURE)).toBe(true);
  });

  it('mounts no avatar image for any participant when set, and keeps the fallback', () => {
    renderThread(true);
    expect(screen.queryByTestId('avatar-img')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('avatar-fallback')).toHaveLength(3);
  });
});
