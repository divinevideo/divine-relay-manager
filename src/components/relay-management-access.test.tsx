// ABOUTME: The NIP-86 relay-management surfaces must render and fetch for any
// ABOUTME: moderator CF Access lets in, with no divine-login session required.
//
// Since #181 moved `useCurrentUser` onto divine-login, `user` means "we know who
// the moderator is" (attribution), NOT "this moderator may act". CF Access is the
// access gate, and every call below goes to the worker, which signs NIP-86 with
// the shared admin key (see useAdminApi: callRelayRpc takes only apiUrl, no
// signer). Gating these reads on `user` locks a fully-authorized moderator out of
// Settings and blanks the relay stats. These tests render SIGNED OUT and assert
// the management surfaces still work.
//
// Live surfaces: SettingsDashboard (Settings tab) and EventsList (Events tab).
// RelaySettings and RelayStats carry the identical defect but are currently
// rendered nowhere in the app; covered here so it can't come back if they are
// ever wired up.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

import { TestApp } from '@/test/TestApp';
import { RelaySettings } from './RelaySettings';
import { RelayStats } from './RelayStats';
import { SettingsDashboard } from './SettingsDashboard';
import { EventsList } from './EventsList';

// Signed out: no divine-login session. This is the real state for a moderator
// who has never completed the OAuth flow (and for everyone whose legacy
// `nostr:login` localStorage entry stopped counting when #181 landed).
vi.mock('@/lib/divineLogin', () => ({
  getSession: vi.fn().mockResolvedValue(null),
  startLogin: vi.fn(),
  logout: vi.fn(),
  completeLogin: vi.fn(),
  DIVINE_LOGIN_SERVER_URL: 'https://login.example.test',
  DIVINE_LOGIN_CLIENT_ID: 'divine-relay-admin',
}));

const rpc = vi.hoisted(() => ({ fn: vi.fn() }));
const workerInfo = vi.hoisted(() => ({ fn: vi.fn() }));

vi.mock('@/hooks/useAdminApi', () => ({
  useAdminApi: () => ({
    callRelayRpc: rpc.fn,
    getWorkerInfo: workerInfo.fn,
    banEvent: vi.fn(),
    allowEvent: vi.fn(),
    verifyEventDeleted: vi.fn(),
  }),
  useApiUrl: () => 'https://api.example.test',
}));

vi.mock('@/hooks/useAuthor', () => ({
  useAuthor: () => ({ data: undefined, isLoading: false }),
}));

const relayQuery = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock('@/hooks/useNostr', () => ({
  useNostr: () => ({ nostr: { query: relayQuery.fn } }),
}));

/** Every NIP-86 method the signed-out surfaces should still be allowed to call. */
function rpcMethodsCalled(): string[] {
  return rpc.fn.mock.calls.map((c) => c[0] as string);
}

beforeEach(() => {
  rpc.fn.mockReset();
  rpc.fn.mockResolvedValue([]);
  workerInfo.fn.mockReset();
  workerInfo.fn.mockResolvedValue({});
  relayQuery.fn.mockReset();
  relayQuery.fn.mockResolvedValue([]);
  localStorage.clear();
});

describe('relay management surfaces, signed out (CF Access is the gate)', () => {
  it('RelaySettings renders the settings UI instead of a login wall', async () => {
    render(
      <TestApp>
        <RelaySettings relayUrl='wss://relay.example.test' />
      </TestApp>,
    );

    await waitFor(() => {
      expect(screen.getByText('Relay Settings')).toBeInTheDocument();
    });
    expect(screen.queryByText(/Please log in to manage relay settings/i)).toBeNull();
  });

  it('RelaySettings fetches allowed kinds and blocked IPs', async () => {
    render(
      <TestApp>
        <RelaySettings relayUrl='wss://relay.example.test' />
      </TestApp>,
    );

    await waitFor(() => {
      expect(rpcMethodsCalled()).toEqual(
        expect.arrayContaining(['listallowedkinds', 'listblockedips']),
      );
    });
  });

  it('RelayStats fetches the banned/allowed counts', async () => {
    render(
      <TestApp>
        <RelayStats relayUrl='wss://relay.example.test' />
      </TestApp>,
    );

    await waitFor(() => {
      expect(rpcMethodsCalled()).toEqual(
        expect.arrayContaining(['listbannedpubkeys', 'listallowedpubkeys']),
      );
    });
  });

  it('SettingsDashboard renders the NIP-86 sections instead of a login wall', async () => {
    render(
      <TestApp>
        <SettingsDashboard />
      </TestApp>,
    );

    await waitFor(() => {
      expect(screen.queryByText(/Log in to view relay management data/i)).toBeNull();
    });
    expect(
      await screen.findByText(/Event Kind Configuration/i),
    ).toBeInTheDocument();
  });

  it('SettingsDashboard fetches its NIP-86 data', async () => {
    render(
      <TestApp>
        <SettingsDashboard />
      </TestApp>,
    );

    await waitFor(() => {
      expect(rpcMethodsCalled()).toEqual(
        expect.arrayContaining(['listallowedkinds', 'listbannedpubkeys']),
      );
    });
  });

  it('SettingsDashboard renders funnelcake object-shaped kinds without crashing', async () => {
    rpc.fn.mockImplementation(async (method: string) => {
      if (method === 'listallowedkinds') {
        return [{ added_at: '2026-01-27T04:25:39.690Z', kind: 0 }];
      }
      return [];
    });

    render(
      <TestApp>
        <SettingsDashboard />
      </TestApp>,
    );

    expect(await screen.findByText(/Kind 0 — Metadata/)).toBeInTheDocument();
  });

  it('EventsList fetches the banned/needs-moderation markers', async () => {
    render(
      <TestApp>
        <EventsList relayUrl='wss://relay.example.test' />
      </TestApp>,
    );

    await waitFor(() => {
      expect(rpcMethodsCalled()).toEqual(
        expect.arrayContaining(['listbannedevents', 'listeventsneedingmoderation']),
      );
    });
  });
});
