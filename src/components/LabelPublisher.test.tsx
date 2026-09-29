// ABOUTME: Covers the ban half of "label + ban" in the quick label form
// ABOUTME: A ban that may have landed must not read as a destructive failure

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LabelPublisher, LabelPublisherInline } from './LabelPublisher';
import { BanNotConfirmedError } from '@/lib/adminApi';
import { banSuccessNote } from '@/lib/banFeedback';

const api = vi.hoisted(() => ({
  publishLabel: vi.fn(),
  publishLabelAndBan: vi.fn(),
}));
const toast = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/useAdminApi', () => ({ useAdminApi: () => api }));
vi.mock('@/hooks/useToast', () => ({ useToast: () => ({ toast }) }));

function labelAndBan() {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <LabelPublisherInline targetType="pubkey" targetValue={'a'.repeat(64)} />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByText('CSAM'));
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Label' }));
}

describe('LabelPublisherInline label + ban', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  // The label was already published when the ban ran, so this is purely about
  // the ban: "not confirmed", never a destructive "Failed" inviting a retry.
  it('reports an unconfirmed ban as not confirmed, not as a failure', async () => {
    api.publishLabelAndBan.mockRejectedValue(new BanNotConfirmedError('timed out'));

    labelAndBan();

    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Label published; ban not confirmed' })),
    );
    expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({ variant: 'destructive' }));
  });

  it('explains what the ban left unconfirmed', async () => {
    api.publishLabelAndBan.mockResolvedValue({
      labelPublished: true,
      banned: true,
      banOutcome: { unconfirmed: 'removal_error' },
    });

    labelAndBan();

    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(expect.objectContaining({
        title: 'Label published and user banned',
        description: banSuccessNote({ unconfirmed: 'removal_error' }),
      })),
    );
  });
});

describe('LabelPublisher dialog label + ban', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('reports an unconfirmed ban as not confirmed, not as a failure to publish', async () => {
    api.publishLabelAndBan.mockRejectedValue(new BanNotConfirmedError('timed out'));
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <LabelPublisher defaultTarget={{ type: 'pubkey', value: 'a'.repeat(64) }} defaultLabels={['csam']} banOnPublish />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Create Label/i }));
    fireEvent.click(await screen.findByRole('button', { name: /Publish Label/i }));

    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Label published; ban not confirmed' })),
    );
    expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({ variant: 'destructive' }));
  });
});
