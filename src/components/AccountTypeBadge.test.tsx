// ABOUTME: Pins the account-type badge's wording: what a Keycast account lookup
// ABOUTME: can and can't say about an account, and its sign-in state (#132).

import { act, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountTypeBadge, AccountTypeLabel } from './AccountTypeBadge';
import type { AccountStatusResponse } from '@/lib/adminApi';

const getAccountStatus = vi.fn();
vi.mock('@/hooks/useAdminApi', () => ({
  useAdminApi: () => ({ getAccountStatus }),
  useApiUrl: () => 'https://api.test',
}));

function renderBadge(accountStatus: AccountStatusResponse | undefined, { error = false, loading = false } = {}) {
  render(<AccountTypeBadge accountStatus={accountStatus} accountStatusError={error} accountStatusLoading={loading} />);
}

describe('AccountTypeBadge', () => {
  it('names a Keycast account a Divine login account, with sign-in active', () => {
    renderBadge({ success: true, status: 'active' });
    expect(screen.getByText('Divine login account')).toBeInTheDocument();
    expect(screen.getByText('sign-in active')).toBeInTheDocument();
  });

  it.each([
    ['suspended', 'sign-in blocked (suspended)'],
    ['banned', 'sign-in blocked (banned)'],
  ])('says sign-in is blocked, and why, for a %s account', (status, text) => {
    renderBadge({ success: true, status });
    expect(screen.getByText(text)).toBeInTheDocument();
    expect(screen.queryByText('sign-in active')).not.toBeInTheDocument();
  });

  it('does not claim sign-in is active when Keycast omits the status', () => {
    renderBadge({ success: true });
    expect(screen.getByText('sign-in status unavailable')).toBeInTheDocument();
  });

  it('says only that there is no Divine login account when Keycast has none, not that it is not Divine', () => {
    renderBadge({ success: false, not_found: true });
    // Self-custody Divine users hold their own key and aren't in Keycast either.
    // The caveat opens on keyboard focus, not only on mouse hover.
    act(() => { fireEvent.focus(screen.getByText('No Divine login account').closest('[tabindex="0"]')!); });
    expect(screen.getAllByText(/holds their own key/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/sign-in/)).not.toBeInTheDocument();
  });

  it('says the account type is unavailable when the lookup failed', () => {
    renderBadge({ success: false, error: 'unavailable' });
    expect(screen.getByText('Account type unavailable')).toBeInTheDocument();
    expect(screen.queryByText(/sign-in/)).not.toBeInTheDocument();
  });

  it('says the account type is unavailable when the request errored with nothing cached', () => {
    renderBadge(undefined, { error: true });
    expect(screen.getByText('Account type unavailable')).toBeInTheDocument();
  });

  it('keeps showing the last good answer when a background refetch fails', () => {
    renderBadge({ success: true, status: 'active' }, { error: true });
    expect(screen.getByText('Divine login account')).toBeInTheDocument();
  });

  it('shows a checking state on a cold load, never "unavailable" first', () => {
    renderBadge(undefined, { loading: true });
    expect(screen.getByText('Checking account type…')).toBeInTheDocument();
    expect(screen.queryByText(/unavailable/)).not.toBeInTheDocument();
  });
});

describe('AccountTypeLabel', () => {
  const PUBKEY = 'ab'.repeat(32);

  function renderLabel(pubkey: string | null | undefined) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={qc}>
        <AccountTypeLabel pubkey={pubkey} />
      </QueryClientProvider>,
    );
  }

  beforeEach(() => getAccountStatus.mockReset());

  it('looks the pubkey up in lowercase, sharing age review\'s cached answer', async () => {
    getAccountStatus.mockResolvedValue({ success: false, not_found: true });
    renderLabel(PUBKEY.toUpperCase());
    expect(await screen.findByText('No Divine login account')).toBeInTheDocument();
    expect(getAccountStatus).toHaveBeenCalledWith(PUBKEY);
  });

  it('says unavailable when the worker reports the Keycast lookup failed', async () => {
    // The worker answers a failed or timed-out Keycast lookup with 200 and success: false.
    getAccountStatus.mockResolvedValue({ success: false, error: 'unavailable' });
    renderLabel(PUBKEY);
    expect(await screen.findByText('Account type unavailable')).toBeInTheDocument();
  });

  it('renders nothing without a pubkey', () => {
    const { container } = renderLabel(null);
    expect(container).toBeEmptyDOMElement();
    expect(getAccountStatus).not.toHaveBeenCalled();
  });

  // A report's p tag is written by whoever filed it. Anything but a 64-hex pubkey
  // is never sent, so it can't be pointed at another route that answers success.
  it.each([['a path', '../info'], ['a short hex string', 'a'.repeat(63)]])(
    'never looks up %s, and says the account type is unavailable', (_label, pubkey) => {
      renderLabel(pubkey);
      expect(screen.getByText('Account type unavailable')).toBeInTheDocument();
      expect(getAccountStatus).not.toHaveBeenCalled();
    },
  );
});
