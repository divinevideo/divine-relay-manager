// ABOUTME: Tests that UserIdentifier marks a claimed nip05 as unverified wherever it
// ABOUTME: shows one on screen, the same as the profile card and reporter rows (#132).

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UserIdentifier } from './UserIdentifier';

const authorState = vi.hoisted(() => ({
  result: { data: undefined, isLoading: false } as {
    data: { metadata?: Record<string, string>; isFunnelcakeUser: boolean } | undefined;
    isLoading: boolean;
  },
}));
vi.mock('@/hooks/useAuthor', () => ({ useAuthor: () => authorState.result }));

const PUBKEY = 'a'.repeat(64);
const NIP05 = 'synthetic@example.test';

beforeEach(() => {
  authorState.result = { data: { metadata: { name: 'synthetic', nip05: NIP05 }, isFunnelcakeUser: false }, isLoading: false };
});

describe('UserIdentifier claimed nip05', () => {
  it('marks it unverified in the block layout', () => {
    render(<UserIdentifier pubkey={PUBKEY} variant="block" />);
    expect(screen.getByText(NIP05).parentElement).toHaveTextContent('(unverified)');
  });

  it('marks it unverified in the inline layout, shown when there is no name', () => {
    authorState.result = { data: { metadata: { nip05: NIP05 }, isFunnelcakeUser: false }, isLoading: false };
    render(<UserIdentifier pubkey={PUBKEY} variant="inline" />);
    expect(screen.getByText(NIP05).parentElement).toHaveTextContent('(unverified)');
  });

  // The inline claim sits inside the identifier's own tooltip trigger; a second,
  // native hover text on it would open two tooltips at once.
  it('adds no second hover text to the inline claim', () => {
    authorState.result = { data: { metadata: { nip05: NIP05 }, isFunnelcakeUser: false }, isLoading: false };
    render(<UserIdentifier pubkey={PUBKEY} variant="inline" />);
    expect(screen.getByText(NIP05).parentElement).not.toHaveAttribute('title');
  });

  // The tooltip body lists the claim in full: it wraps rather than cutting off,
  // and adds no native hover text of its own inside the tooltip.
  it.each(['compact', 'inline'] as const)('shows the full claim in the %s tooltip', async (variant) => {
    render(<UserIdentifier pubkey={PUBKEY} variant={variant} />);
    fireEvent.focus(screen.getAllByText(/synthetic|npub1/)[0].closest('span')!);
    const tooltip = await screen.findByRole('tooltip');
    const claim = Array.from(tooltip.querySelectorAll('bdi')).find(b => b.textContent === NIP05)!;
    expect(claim.className).toContain('break-all');
    expect(claim.parentElement).not.toHaveAttribute('title');
  });
});
