// ABOUTME: Covers the ban half of "label + ban" in both label forms
// ABOUTME: Once the label is published, a ban problem must not read as a failed publish

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LabelPublisher, LabelPublisherInline } from './LabelPublisher';
import { ApiError, BanNotConfirmedError } from '@/lib/adminApi';
import { banSuccessNote } from '@/lib/banFeedback';

const api = vi.hoisted(() => ({
  publishLabel: vi.fn(),
  publishLabelAndBan: vi.fn(),
}));
const toast = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/useAdminApi', () => ({ useAdminApi: () => api }));
vi.mock('@/hooks/useToast', () => ({ useToast: () => ({ toast }) }));

function renderWith(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
  return { invalidate };
}

async function labelAndBanInline() {
  const rendered = renderWith(<LabelPublisherInline targetType="pubkey" targetValue={'a'.repeat(64)} />);
  fireEvent.click(screen.getByText('CSAM'));
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Label' }));
  return rendered;
}

async function labelAndBanDialog() {
  const rendered = renderWith(
    <LabelPublisher defaultTarget={{ type: 'pubkey', value: 'a'.repeat(64) }} defaultLabels={['csam']} banOnPublish />,
  );
  fireEvent.click(screen.getByRole('button', { name: /Create Label/i }));
  fireEvent.click(await screen.findByRole('button', { name: /Publish Label/i }));
  return rendered;
}

const published = (extra: object) => ({ labelPublished: true, banned: false, ...extra });

describe.each([
  ['inline form', labelAndBanInline],
  ['dialog', labelAndBanDialog],
] as const)('LabelPublisher %s, label + ban', (_name, labelAndBan) => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('reports an unconfirmed ban after the label published, not a failed publish', async () => {
    api.publishLabelAndBan.mockResolvedValue(published({ banError: new BanNotConfirmedError('timed out') }));

    const { invalidate } = await labelAndBan();

    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Label published; ban not confirmed' })),
    );
    expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({ variant: 'destructive' }));
    // The toast asks for a re-check; the ban lists must not be the stale ones.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['banned-pubkeys'] });
  });

  it('reports a refused ban after the label published as a failed ban, not a failed publish', async () => {
    api.publishLabelAndBan.mockResolvedValue(published({ banError: new ApiError('Invalid pubkey', 400) }));

    await labelAndBan();

    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(expect.objectContaining({
        title: 'Label published; ban failed',
        description: 'Invalid pubkey',
        variant: 'destructive',
      })),
    );
  });

  it('keeps a failure to publish the label a failed publish', async () => {
    api.publishLabelAndBan.mockRejectedValue(new Error('relay down'));

    await labelAndBan();

    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(expect.objectContaining({ description: 'relay down', variant: 'destructive' })),
    );
    expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({ title: expect.stringMatching(/^Label published/) }));
  });

  it('explains what the ban left unconfirmed', async () => {
    api.publishLabelAndBan.mockResolvedValue({
      labelPublished: true,
      banned: true,
      banOutcome: { unconfirmed: 'removal_error' },
    });

    await labelAndBan();

    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(expect.objectContaining({
        title: 'Label published and user banned',
        description: banSuccessNote({ unconfirmed: 'removal_error' }),
      })),
    );
  });
});
