import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const { getSession, logout, startLogin } = vi.hoisted(() => ({
  getSession: vi.fn(),
  logout: vi.fn(),
  startLogin: vi.fn(),
}));
vi.mock('@/lib/divineLogin', () => ({ getSession, logout, startLogin }));

import { DivineSessionProvider } from '@/contexts/DivineSessionContext';
import { useDivineSession } from '@/hooks/useDivineSession';

function Probe() {
  const { credentials, isResolving, logout } = useDivineSession();
  return (
    <div>
      <span data-testid="state">
        {isResolving ? 'resolving' : credentials ? credentials.accessToken : 'none'}
      </span>
      <button onClick={logout}>logout</button>
    </div>
  );
}

beforeEach(() => vi.clearAllMocks());

describe('useDivineSession', () => {
  it('resolves the session on mount', async () => {
    getSession.mockResolvedValue({ bunkerUrl: 'bunker://x', accessToken: 'tok' });
    render(
      <DivineSessionProvider>
        <Probe />
      </DivineSessionProvider>,
    );
    expect(screen.getByTestId('state')).toHaveTextContent('resolving');
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('tok'));
  });

  it('logout clears credentials and calls the SDK', async () => {
    getSession.mockResolvedValue({ bunkerUrl: 'bunker://x', accessToken: 'tok' });
    render(
      <DivineSessionProvider>
        <Probe />
      </DivineSessionProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('tok'));
    fireEvent.click(screen.getByText('logout'));
    expect(logout).toHaveBeenCalled();
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('none'));
  });

  it('defaults to signed-out with no provider', () => {
    render(<Probe />);
    expect(screen.getByTestId('state')).toHaveTextContent('none');
  });
});
