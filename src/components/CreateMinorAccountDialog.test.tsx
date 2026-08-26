// ABOUTME: Creating a minor account writes a `cleared` case row, so it must
// ABOUTME: refresh the queue's per-state chip counts, not just the case list.

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { CreateMinorAccountDialog } from './CreateMinorAccountDialog';

const createMinorAccount = vi.fn();

vi.mock('@/hooks/useAdminApi', () => ({
  useAdminApi: () => ({ createMinorAccount }),
}));
vi.mock('@/hooks/useToast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

beforeEach(() => {
  createMinorAccount.mockReset();
  createMinorAccount.mockResolvedValue({
    success: true,
    pubkey: 'a'.repeat(64),
    claim_url: 'https://claim.example.test/token',
    expires_at: '2026-09-30T00:00:00Z',
    account_state: 'unclaimed',
  });
});

describe('CreateMinorAccountDialog', () => {
  it('invalidates the queue chip counts alongside the case list', async () => {
    const user = userEvent.setup();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(client, 'invalidateQueries');

    render(
      <QueryClientProvider client={client}>
        <CreateMinorAccountDialog />
      </QueryClientProvider>
    );

    await user.click(screen.getByRole('button', { name: /New Minor Account/ }));
    await user.type(screen.getByPlaceholderText('username'), 'testminor');
    await user.click(screen.getByRole('button', { name: /Create Account & Generate Claim Link/ }));

    await waitFor(() => expect(createMinorAccount).toHaveBeenCalledTimes(1));

    const keys = () => invalidate.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey));
    await waitFor(() => expect(keys()).toContain(JSON.stringify(['age-review-cases'])));
    // The created case is a row in age_review_cases, so the per-state counts
    // behind the queue's chips changed too. Without this the Cleared chip lags
    // the list it sits above for up to its 30s refetch interval.
    expect(keys()).toContain(JSON.stringify(['age-review-counts']));
  });
});
