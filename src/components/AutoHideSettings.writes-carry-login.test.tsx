// ABOUTME: Saving the auto-hide config is a write, so it goes out with the moderator's login.
// ABOUTME: It uses fetch directly, so neither tsc nor the useAdminApi table can catch a missing header.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { TestApp } from '@/test/TestApp';
import { Toaster } from '@/components/ui/toaster';
import { subscribeModeratorLoginRequired } from '@/lib/moderatorLoginRequired';
import { AutoHideSettings } from './AutoHideSettings';

vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ getModeratorToken: () => 'login-tok' }),
}));

const CONFIG = { enabled: false, trustedClients: [], tiers: [] };
const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
    const config = init?.method === 'PUT' ? JSON.parse(String(init.body)) : CONFIG;
    return new Response(JSON.stringify({ success: true, config }), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('AutoHideSettings save', () => {
  it('sends the login with the config PUT', async () => {
    const user = userEvent.setup();
    render(<TestApp><AutoHideSettings /></TestApp>);

    await user.click(await screen.findByRole('switch', { name: /enabled/i }));
    await user.click(screen.getByRole('button', { name: /save configuration/i }));

    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(true));
    const [, put] = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT')!;
    expect((put.headers as Record<string, string>)['X-Divine-Login-Token']).toBe('login-tok');
  });
});

// It reads the error itself rather than through adminApi, so it has to make the
// same login check: a save refused for want of a Divine login says so and
// raises the app's sign-in prompt.
describe('AutoHideSettings save refused for want of a login', () => {
  it('shows the plain message and raises the sign-in prompt', async () => {
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => init?.method === 'PUT'
      ? new Response(JSON.stringify({ success: false, error: 'Sign in with Divine to continue', code: 'moderator_login_required' }), { status: 401 })
      : new Response(JSON.stringify({ success: true, config: CONFIG }), { status: 200 }));
    const prompted = vi.fn();
    const unsubscribe = subscribeModeratorLoginRequired(prompted);
    const user = userEvent.setup();
    render(<TestApp><AutoHideSettings /><Toaster /></TestApp>);

    await user.click(await screen.findByRole('switch', { name: /enabled/i }));
    await user.click(screen.getByRole('button', { name: /save configuration/i }));

    expect(await screen.findByText('You need to be signed in with Divine to do this.')).toBeInTheDocument();
    expect(prompted).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('keeps any other refusal as the worker worded it, with no prompt', async () => {
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => init?.method === 'PUT'
      ? new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), { status: 401 })
      : new Response(JSON.stringify({ success: true, config: CONFIG }), { status: 200 }));
    const prompted = vi.fn();
    const unsubscribe = subscribeModeratorLoginRequired(prompted);
    const user = userEvent.setup();
    render(<TestApp><AutoHideSettings /><Toaster /></TestApp>);

    await user.click(await screen.findByRole('switch', { name: /enabled/i }));
    await user.click(screen.getByRole('button', { name: /save configuration/i }));

    expect(await screen.findByText('Unauthorized')).toBeInTheDocument();
    expect(prompted).not.toHaveBeenCalled();
    unsubscribe();
  });
});
