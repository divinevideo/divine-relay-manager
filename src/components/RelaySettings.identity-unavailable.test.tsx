// ABOUTME: A session whose moderator identity never resolved must still reach
// ABOUTME: relay management, which the worker authorizes without that identity.
//
// The header banner this PR adds tells the moderator "Moderation itself still
// works". That has to be true. Relay management authenticates through
// useAdminApi -> adminApi.callRelayRpc, which sends only CF Access service-token
// / X-Admin-Key headers and never uses the moderator pubkey or signer, so gating
// it on `useCurrentUser().user` (which requires the pubkey) locked out exactly
// the session identityUnavailable describes -- telling a signed-in moderator to
// "log in" while the header above said they were signed in.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

import { TestApp } from '@/test/TestApp';
import { RelaySettings } from './RelaySettings';

const PUBKEY = 'a'.repeat(64);

const session = vi.hoisted(() => ({
  getSession: vi.fn(),
  logout: vi.fn(),
  startLogin: vi.fn(),
}));
vi.mock('@/lib/divineLogin', () => ({
  getSession: session.getSession,
  logout: session.logout,
  startLogin: session.startLogin,
  completeLogin: vi.fn(),
  DIVINE_LOGIN_SERVER_URL: 'https://login.example.test',
  DIVINE_LOGIN_CLIENT_ID: 'divine-relay-admin',
}));

const getPublicKey = vi.hoisted(() => vi.fn());
vi.mock('@/lib/divineSigner', () => ({
  DivineRpcSigner: class {
    getPublicKey = getPublicKey;
    signEvent = vi.fn();
    getRelays = vi.fn();
  },
}));

// The relay RPC itself is the worker's concern; record that it is reached.
const callRelayRpc = vi.hoisted(() => vi.fn());
vi.mock('@/hooks/useAdminApi', () => ({
  useAdminApi: () => ({ callRelayRpc }),
}));

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  session.getSession.mockReset();
  getPublicKey.mockReset();
  callRelayRpc.mockReset();
  callRelayRpc.mockResolvedValue([]);
  // The provider warns by design whenever the identity fails to resolve.
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
});

function renderSettings() {
  return render(
    <TestApp>
      <RelaySettings relayUrl='wss://relay.example.test' />
    </TestApp>,
  );
}

describe('RelaySettings with an unresolved moderator identity', () => {
  beforeEach(() => {
    session.getSession.mockResolvedValue({ accessToken: 'tok-abc' });
    getPublicKey.mockRejectedValue(new Error('no keycast key for this account'));
  });

  it('does not tell an already signed-in moderator to log in', async () => {
    renderSettings();
    await waitFor(() => expect(screen.getByRole('heading', { name: /relay settings/i })).toBeInTheDocument());
    expect(screen.queryByText(/please log in/i)).toBeNull();
  });

  it('still loads relay management data, which needs no moderator identity', async () => {
    renderSettings();
    await waitFor(() => expect(callRelayRpc).toHaveBeenCalledWith('listallowedkinds'));
  });
});

describe('RelaySettings gate regressions', () => {
  it('a fully resolved moderator still gets relay settings', async () => {
    session.getSession.mockResolvedValue({ accessToken: 'tok-abc' });
    getPublicKey.mockResolvedValue(PUBKEY);

    renderSettings();

    await waitFor(() => expect(screen.getByRole('heading', { name: /relay settings/i })).toBeInTheDocument());
    await waitFor(() => expect(callRelayRpc).toHaveBeenCalledWith('listallowedkinds'));
  });

  it('a signed-out visitor still gets relay management data (CF Access is the gate)', async () => {
    session.getSession.mockResolvedValue(null);

    renderSettings();

    // Relay management is not gated on a divine-login session at all (#218): the
    // worker authorizes these calls via CF Access, so a signed-out visitor whom
    // CF Access admitted still gets the data and is never walled behind "log in".
    await waitFor(() => expect(callRelayRpc).toHaveBeenCalledWith('listallowedkinds'));
    expect(screen.queryByText(/please log in/i)).toBeNull();
  });
});
