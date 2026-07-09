// ABOUTME: Tests ThreadContext's comments-on-reported-content section (#164 B)

import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import type { NostrEvent } from '@nostrify/nostrify';
import { ThreadContext } from './ThreadContext';

// Author metadata is useAuthor's concern (tested elsewhere); stub it so these
// tests exercise the comments section, not profile fetching.
vi.mock('@/hooks/useAuthor', () => ({
  useAuthor: () => ({ data: undefined, isLoading: false }),
}));

const REPORTED_USER = 'a'.repeat(64);
const OTHER_USER = 'b'.repeat(64);
const VIDEO_ID = 'c'.repeat(64);

function video(): NostrEvent {
  return { id: VIDEO_ID, pubkey: OTHER_USER, kind: 34236, tags: [['d', 'v1']], content: 'a video', created_at: 1_750_000_000, sig: 'f'.repeat(128) };
}

function comment(author: string, content: string, idByte: string, created_at: number): NostrEvent {
  return { id: idByte.repeat(64), pubkey: author, kind: 1111, tags: [['E', VIDEO_ID]], content, created_at, sig: 'f'.repeat(128) };
}

function renderThread(props: Partial<React.ComponentProps<typeof ThreadContext>>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ThreadContext ancestors={[]} reportedEvent={video()} {...props} />
    </QueryClientProvider>
  );
}

describe('ThreadContext comments section (#164 B)', () => {
  it('lists NIP-22 comments left on the reported content', () => {
    renderThread({
      replies: [comment(OTHER_USER, 'nice video', '1', 1_750_000_100)],
      reportedPubkey: REPORTED_USER,
    });

    expect(screen.getByText('nice video')).toBeInTheDocument();
    expect(screen.getByText(/comments on this content/i)).toBeInTheDocument();
  });

  it("flags the reported user's own comment rows and counts them", () => {
    renderThread({
      replies: [
        comment(REPORTED_USER, 'FREE GIVEAWAY click my profile', '1', 1_750_000_300),
        comment(OTHER_USER, 'sick trick', '2', 1_750_000_200),
      ],
      reportedPubkey: REPORTED_USER,
    });

    // header calls out how many are by the reported user
    expect(screen.getByText(/2, 1 by the reported user/i)).toBeInTheDocument();

    // the offender's row carries the flag badge; the other does not
    const flagged = screen.getByText('FREE GIVEAWAY click my profile').closest('div[class*="border-amber"]');
    expect(flagged).not.toBeNull();
    expect(within(flagged as HTMLElement).getByText(/by reported user/i)).toBeInTheDocument();

    const innocent = screen.getByText('sick trick').closest('div[class*="border-amber"]');
    expect(innocent).toBeNull();
  });

  it('renders nothing extra when there are no comments', () => {
    renderThread({ replies: [], reportedPubkey: REPORTED_USER });
    expect(screen.queryByText(/comments on this content/i)).not.toBeInTheDocument();
  });
});
