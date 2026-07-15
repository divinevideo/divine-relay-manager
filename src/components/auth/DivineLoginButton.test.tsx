import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { useCurrentUser, startLogin, logout, toast } = vi.hoisted(() => ({
  useCurrentUser: vi.fn(),
  startLogin: vi.fn(),
  logout: vi.fn(),
  toast: vi.fn(),
}));
vi.mock('@/hooks/useCurrentUser', () => ({ useCurrentUser }));
vi.mock('@/hooks/useToast', () => ({ useToast: () => ({ toast }) }));

let isResolving = false;
vi.mock('@/hooks/useDivineSession', () => ({
  useDivineSession: () => ({ startLogin, logout, isResolving }),
}));

import { DivineLoginButton } from './DivineLoginButton';

const PUBKEY = 'c'.repeat(64);

beforeEach(() => {
  vi.clearAllMocks();
  isResolving = false;
  startLogin.mockResolvedValue(undefined);
  Object.defineProperty(window, 'location', {
    value: { ...window.location, pathname: '/age-review', search: '?case=1' },
    writable: true,
  });
});

describe('DivineLoginButton', () => {
  it('shows a sign-in button when signed out and starts login with the current path', () => {
    useCurrentUser.mockReturnValue({ user: undefined });
    render(<DivineLoginButton />);
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    expect(startLogin).toHaveBeenCalledWith('/age-review?case=1');
  });

  it('toasts when starting sign-in fails', async () => {
    useCurrentUser.mockReturnValue({ user: undefined });
    startLogin.mockRejectedValue(new Error('network down'));
    render(<DivineLoginButton />);
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({ variant: 'destructive', description: 'network down' }),
      ),
    );
  });

  it('shows the signed-in moderator and a sign-out control', () => {
    useCurrentUser.mockReturnValue({ user: { pubkey: PUBKEY }, metadata: { name: 'Mod Squad' } });
    render(<DivineLoginButton />);
    expect(screen.getByText('Mod Squad')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /sign out/i }));
    expect(logout).toHaveBeenCalled();
  });

  it('renders a skeleton (no sign-in/out) while the session is resolving', () => {
    isResolving = true;
    useCurrentUser.mockReturnValue({ user: undefined });
    render(<DivineLoginButton />);
    expect(screen.queryByRole('button', { name: /sign in/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /sign out/i })).not.toBeInTheDocument();
  });
});
