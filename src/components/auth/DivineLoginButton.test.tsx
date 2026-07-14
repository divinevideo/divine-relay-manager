import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const { useCurrentUser, startLogin, logout } = vi.hoisted(() => ({
  useCurrentUser: vi.fn(),
  startLogin: vi.fn(),
  logout: vi.fn(),
}));
vi.mock('@/hooks/useCurrentUser', () => ({ useCurrentUser }));
vi.mock('@/hooks/useDivineSession', () => ({
  useDivineSession: () => ({ startLogin, logout, isResolving: false }),
}));

import { DivineLoginButton } from './DivineLoginButton';

const PUBKEY = 'c'.repeat(64);

beforeEach(() => vi.clearAllMocks());

describe('DivineLoginButton', () => {
  it('shows a sign-in button when signed out and starts login with the current path', () => {
    useCurrentUser.mockReturnValue({ user: undefined });
    render(<DivineLoginButton />);
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    expect(startLogin).toHaveBeenCalled();
  });

  it('shows the signed-in moderator and a sign-out control', () => {
    useCurrentUser.mockReturnValue({ user: { pubkey: PUBKEY }, metadata: { name: 'Mod Squad' } });
    render(<DivineLoginButton />);
    expect(screen.getByText('Mod Squad')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /sign out/i }));
    expect(logout).toHaveBeenCalled();
  });
});
