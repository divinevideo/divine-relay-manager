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

// The moderation summary line used to read "Event not found on relay. User is
// not banned." whenever both flags were falsy and a check timestamp existed.
// ReportDetail collapsed the tri-state outcome with `=== true` on the way in,
// so a check that could not reach the relay arrived here as `false` and was
// stated as fact.
describe('ThreadContext moderation status summary', () => {
  const CHECKED = new Date('2026-08-10T12:00:00Z');

  // `isEventDeleted === false` is the verification REQ getting the event back,
  // not a failed lookup, so this line reports it as present rather than missing.
  it('reports the event as still present when the check found it', () => {
    renderThread({ reportedEvent: undefined, isEventDeleted: false, isUserBanned: false, checkedAt: CHECKED });

    expect(screen.getByText('Event is still on the relay. User is not banned.')).toBeInTheDocument();
    expect(screen.queryByText(/Event not found on relay/)).not.toBeInTheDocument();
  });

  it('does not claim the user is unbanned when that check could not answer', () => {
    renderThread({ reportedEvent: undefined, isEventDeleted: false, isUserBanned: null, checkedAt: CHECKED });

    expect(screen.getByText(/Could not check the user's ban status\./)).toBeInTheDocument();
    expect(screen.queryByText(/User is not banned\./)).not.toBeInTheDocument();
  });

  it('does not claim the event is absent when that check could not answer', () => {
    renderThread({ reportedEvent: undefined, isEventDeleted: null, isUserBanned: false, checkedAt: CHECKED });

    expect(screen.getByText(/Could not check whether the event is on the relay\./)).toBeInTheDocument();
    expect(screen.queryByText(/Event is still on the relay\./)).not.toBeInTheDocument();
  });

  it('still reports a confirmed ban', () => {
    renderThread({ reportedEvent: undefined, isEventDeleted: false, isUserBanned: true, checkedAt: CHECKED });

    expect(screen.getByText('User is banned on the relay')).toBeInTheDocument();
  });
});

