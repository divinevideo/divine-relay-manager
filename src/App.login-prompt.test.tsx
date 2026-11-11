// ABOUTME: The sign-in prompt for a write refused for want of a login is mounted
// ABOUTME: once at the app root, so it covers every screen.
//
// The router and the Nostr provider are stubbed: the real ones would connect to
// the app's default relay, and this test is only about what App mounts.
import { describe, it, expect, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

import { announceModeratorLoginRequired } from '@/lib/moderatorLoginRequired';

vi.mock('./AppRouter', () => ({ default: () => <div data-testid='router' /> }));
vi.mock('@/components/NostrProvider', () => ({ default: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/lib/divineLogin', () => ({
  getSession: vi.fn(async () => null),
  startLogin: vi.fn(async () => undefined),
  logout: vi.fn(),
  acceptSignOutFromOtherTab: vi.fn(() => false),
  completeLogin: vi.fn(),
}));

import App from './App';

describe('App', () => {
  it('shows the sign-in prompt when a write is refused for want of a login', async () => {
    render(<App />);
    await screen.findByTestId('router');

    act(() => announceModeratorLoginRequired());

    expect(screen.getByText('You need to be signed in with Divine to do this.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^sign in$/i })).toBeInTheDocument();
  });
});
