// ABOUTME: Relay config changes are writes, so they go out with the moderator's login.
// ABOUTME: With REQUIRE_MODERATOR_LOGIN on, the worker refuses a relay write that has none.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { TestApp } from '@/test/TestApp';
import { RelaySettings } from './RelaySettings';

const read = vi.hoisted(() => vi.fn());
const write = vi.hoisted(() => vi.fn());
const asModerator = vi.hoisted(() => vi.fn());
vi.mock('@/hooks/useAdminApi', () => ({
  useAdminApi: () => ({ callRelayRpc: read, asModerator }),
}));
vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ getModeratorToken: () => 'login-tok' }),
}));

beforeEach(() => {
  read.mockReset();
  read.mockResolvedValue([]);
  write.mockReset();
  write.mockResolvedValue({ success: true });
  asModerator.mockReset();
  asModerator.mockReturnValue({ callRelayRpc: write });
});

describe('RelaySettings relay writes', () => {
  it('sends a relay name change through the login, not the plain read call', async () => {
    const user = userEvent.setup();
    render(<TestApp><RelaySettings /></TestApp>);

    await user.type(await screen.findByPlaceholderText('My Awesome Relay'), 'Divine');
    await user.click(screen.getByRole('button', { name: /update name/i }));

    await waitFor(() => expect(write).toHaveBeenCalledWith('changerelayname', ['Divine']));
    expect(asModerator).toHaveBeenCalledWith('login-tok');
    expect(read).not.toHaveBeenCalledWith('changerelayname', expect.anything());
  });
});
