import { describe, it, expect, vi } from 'vitest';
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { AgeReviewFunnel } from './AgeReviewFunnel';

vi.mock('@/hooks/useAdminApi', () => ({
  useAdminApi: () => ({
    getAgeReviewFunnel: vi.fn().mockResolvedValue({
      success: true,
      age_band: 'age_13_15',
      helpdesk: { source: 'zendesk', band_scope: 'all_bands', reports_in: 12, requests_in: 8, video_received: 5 },
      moderation: { source: 'd1', band_scope: 'age_13_15', in_progress: 4, approved: { total: 3, restored: 2, new_minor: 1 }, denied_expired: 1 },
      generated_at: '2026-06-29T00:00:00Z',
    }),
  }),
}));

function renderWithClient(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe('AgeReviewFunnel', () => {
  it('renders stage labels and counts from the payload', async () => {
    renderWithClient(<AgeReviewFunnel />);
    expect(await screen.findByText('Requests in')).toBeInTheDocument();
    expect(await screen.findByText('8')).toBeInTheDocument();
    expect(await screen.findByText('Video received')).toBeInTheDocument();
    expect(await screen.findByText('Approved')).toBeInTheDocument();
  });
});
