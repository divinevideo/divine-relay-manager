import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { StoredCredentials } from '@divinevideo/login';
import { useState } from 'react';

const { oauth, getPublicKey } = vi.hoisted(() => ({
  oauth: { getSessionWithRefresh: vi.fn(), logout: vi.fn() },
  getPublicKey: vi.fn(),
}));
vi.mock('@divinevideo/login', () => ({ createDivineClient: () => ({ oauth }) }));
vi.mock('@/lib/divineSigner', () => ({
  DivineRpcSigner: vi.fn().mockImplementation(() => ({ getPublicKey })),
}));

// Keep the real login wrapper: its single-flight promise is the other half of
// the provider's logout generation guard, so mocking it hides this race.
import { DivineSessionProvider } from './DivineSessionProvider';
import { useDivineSession } from '@/hooks/useDivineSession';

function Probe() {
  const session = useDivineSession();
  const [snapshot, setSnapshot] = useState('');
  return <>
    <span data-testid="signed-in">{String(session.isSignedIn)}</span>
    <button onClick={session.logout}>Sign out</button>
    <button onClick={() => setSnapshot(session.getModeratorToken() ?? 'none')}>Snapshot</button>
    <span data-testid="snapshot">{snapshot}</span>
  </>;
}

afterEach(() => vi.clearAllMocks());

it.each(['focus', 'visibilitychange'])('does not rejoin a pre-logout refresh on %s', async (event) => {
  const credentials = { accessToken: 'old-login', bunkerUrl: 'bunker://test' };
  let stored: StoredCredentials | null = credentials;
  let release!: () => void;
  oauth.getSessionWithRefresh
    .mockImplementationOnce(() => new Promise<StoredCredentials>((resolve) => {
      release = () => {
        stored = credentials; // The SDK can persist a refresh after logout.
        resolve(credentials);
      };
    }))
    .mockImplementation(async () => stored);
  oauth.logout.mockImplementation(() => { stored = null; });
  getPublicKey.mockResolvedValue('a'.repeat(64));
  render(<DivineSessionProvider><Probe /></DivineSessionProvider>);
  expect(oauth.getSessionWithRefresh).toHaveBeenCalledTimes(1);

  fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
  await act(async () => {
    if (event === 'focus') window.dispatchEvent(new Event(event));
    else document.dispatchEvent(new Event(event));
  });
  await act(async () => { release(); });

  await waitFor(() => expect(screen.getByTestId('signed-in')).toHaveTextContent('false'));
  fireEvent.click(screen.getByRole('button', { name: 'Snapshot' }));
  expect(screen.getByTestId('snapshot')).toHaveTextContent('none');
  expect(stored).toBeNull();
  expect(oauth.getSessionWithRefresh).toHaveBeenCalledTimes(2);
});
