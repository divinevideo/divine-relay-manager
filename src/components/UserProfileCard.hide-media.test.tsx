// ABOUTME: Tests that UserProfileCard hides the account's avatar and post media
// ABOUTME: until a moderator asks for them, when hideMediaByDefault is set

import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { NostrEvent } from '@nostrify/nostrify';
import { UserProfileCard } from './UserProfileCard';
import type { UserStats } from '@/hooks/useUserStats';

vi.mock('@/hooks/useAdminApi', () => ({
  useApiUrl: () => 'https://api.example.invalid',
}));

vi.mock('@/hooks/useEventTitles', () => ({
  useEventTitles: () => ({ titles: new Map(), isLoading: false }),
}));

// Radix's AvatarImage only renders an <img> after a real image load, which jsdom
// never performs. Mounting it at all is what triggers the request (it does
// new Image() and sets src), so asserting the stand-in is never mounted is the
// meaningful check, not whether an <img> is in the DOM.
vi.mock('@/components/ui/avatar', () => ({
  Avatar: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  AvatarImage: ({ src }: { src?: string }) => <img data-testid="avatar-img" src={src} />,
  AvatarFallback: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));

const PUBKEY = 'a'.repeat(64);
const PICTURE = 'https://example.invalid/a.png';
const VIDEO = 'https://example.invalid/v.mp4';

const POST: NostrEvent = {
  id: '1'.repeat(64),
  pubkey: PUBKEY,
  kind: 1,
  content: `look ${VIDEO}`,
  tags: [],
  created_at: 1_750_000_000,
  sig: 'f'.repeat(128),
};

const STATS: UserStats = {
  postCount: 1,
  reportCount: 0,
  labelCount: 0,
  recentPosts: [POST],
  existingLabels: [],
  previousReports: [],
  authoredContentIncomplete: false,
  labelsIncomplete: false,
  reportsIncomplete: false,
  reportsTruncated: false,
  labelsTruncated: false,
  relayIncomplete: false,
};

function renderCard(hide?: boolean) {
  return render(
    <MemoryRouter>
      <UserProfileCard
        pubkey={PUBKEY}
        profile={{ picture: PICTURE }}
        stats={STATS}
        hideMediaByDefault={hide}
      />
    </MemoryRouter>,
  );
}

describe('UserProfileCard hideMediaByDefault', () => {
  it('keeps the avatar image when the flag is not set (existing behavior)', () => {
    renderCard();
    expect(screen.getByTestId('avatar-img')).toHaveAttribute('src', PICTURE);
    expect(screen.queryByRole('button', { name: 'Show profile picture' })).not.toBeInTheDocument();
  });

  it('withholds the avatar image until Show profile picture is clicked', () => {
    renderCard(true);
    expect(screen.queryByTestId('avatar-img')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show profile picture' }));
    expect(screen.getByTestId('avatar-img')).toHaveAttribute('src', PICTURE);
    fireEvent.click(screen.getByRole('button', { name: 'Hide profile picture' }));
    expect(screen.queryByTestId('avatar-img')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show profile picture' })).toBeInTheDocument();
  });

  it('shows recent post media when the flag is not set (existing behavior)', () => {
    const { container } = renderCard();
    expect(container.querySelector('video')).not.toBeNull();
  });

  it('withholds recent post media until its own show control is clicked', () => {
    const { container } = renderCard(true);
    expect(container.querySelector('video, img[src*="example.invalid/v"]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /show 1 media/i }));
    expect(container.querySelector('video')).not.toBeNull();
  });
});

// The report pane is reused across reports, so the card is too.
describe('UserProfileCard across reports on the same account', () => {
  const card = (hide: boolean) => (
    <MemoryRouter>
      <UserProfileCard pubkey={PUBKEY} profile={{ picture: PICTURE }} stats={STATS} hideMediaByDefault={hide} />
    </MemoryRouter>
  );

  it('hides a revealed avatar again when a later report is sensitive, as it does post media', () => {
    const { container, rerender } = render(card(true));
    fireEvent.click(screen.getByRole('button', { name: 'Show profile picture' }));
    fireEvent.click(screen.getByRole('button', { name: /show 1 media/i }));

    rerender(card(false));
    rerender(card(true));

    expect(screen.queryByTestId('avatar-img')).not.toBeInTheDocument();
    expect(container.querySelector('video')).toBeNull();
  });

  it('keeps a revealed avatar while the next report is sensitive too', () => {
    const { rerender } = render(card(true));
    fireEvent.click(screen.getByRole('button', { name: 'Show profile picture' }));

    rerender(card(true));

    expect(screen.getByTestId('avatar-img')).toHaveAttribute('src', PICTURE);
  });
});

describe('UserProfileCard across reports on different accounts', () => {
  const OTHER_PUBKEY = 'b'.repeat(64);
  const sensitiveCard = (pubkey: string) => (
    <MemoryRouter>
      <UserProfileCard pubkey={pubkey} profile={{ picture: PICTURE }} stats={STATS} hideMediaByDefault />
    </MemoryRouter>
  );

  it("does not show an account's avatar again without a click after the pane visits another account", () => {
    const { rerender } = render(sensitiveCard(PUBKEY));
    fireEvent.click(screen.getByRole('button', { name: 'Show profile picture' }));
    expect(screen.getByTestId('avatar-img')).toBeInTheDocument();

    rerender(sensitiveCard(OTHER_PUBKEY));
    expect(screen.queryByTestId('avatar-img')).not.toBeInTheDocument();
    rerender(sensitiveCard(PUBKEY));

    expect(screen.queryByTestId('avatar-img')).not.toBeInTheDocument();
  });
});
