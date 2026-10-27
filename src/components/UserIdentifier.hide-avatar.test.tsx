// ABOUTME: Tests that UserIdentifier can keep its avatar slot (initials) while
// ABOUTME: never mounting the image, for sensitive reports

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { UserIdentifier } from './UserIdentifier';

const PUBKEY = 'a'.repeat(64);

vi.mock('@/hooks/useAuthor', () => ({
  useAuthor: () => ({ data: { metadata: { name: 'someone', picture: 'https://example.invalid/a.png' } }, isLoading: false }),
}));

// Mounting Radix's AvatarImage is what starts the request; see
// UserProfileCard.hide-media.test.tsx.
vi.mock('@/components/ui/avatar', () => ({
  Avatar: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  AvatarImage: ({ src }: { src?: string }) => <img data-testid="avatar-img" src={src} />,
  AvatarFallback: ({ children }: { children: React.ReactNode }) => <span data-testid="avatar-fallback">{children}</span>,
}));

describe('UserIdentifier hideAvatarImage', () => {
  for (const variant of ['inline', 'block', 'compact'] as const) {
    it(`loads the avatar image when not set (${variant}, existing behavior)`, () => {
      render(<UserIdentifier pubkey={PUBKEY} showAvatar variant={variant} />);
      expect(screen.getByTestId('avatar-img')).toBeInTheDocument();
    });

    it(`mounts no avatar image but keeps the fallback when set (${variant})`, () => {
      render(<UserIdentifier pubkey={PUBKEY} showAvatar hideAvatarImage variant={variant} />);
      expect(screen.queryByTestId('avatar-img')).not.toBeInTheDocument();
      expect(screen.getByTestId('avatar-fallback')).toHaveTextContent('SO');
    });
  }
});
