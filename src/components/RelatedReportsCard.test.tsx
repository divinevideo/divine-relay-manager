// ABOUTME: Pins that the Related Reports card counts the account's complete report read,
// ABOUTME: and never shows a failed, pending or stopped-early read as a total.

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NostrEvent } from '@nostrify/nostrify';
import { RelatedReportsCard } from './RelatedReportsCard';

const USER = 'd'.repeat(64);
const CURRENT_EVENT = '1'.repeat(64);

const fetchReportsByTarget = vi.hoisted(() => vi.fn());
const config = vi.hoisted(() => ({ apiUrl: 'https://api-a.example' }));

vi.mock('@/hooks/useAdminApi', () => ({
  useAdminApi: () => ({
    fetchReportsByTarget: (target: { pubkey: string }) => fetchReportsByTarget(config.apiUrl, target),
  }),
}));
vi.mock('@/hooks/useAppContext', () => ({
  useAppContext: () => ({ config: { apiUrl: config.apiUrl } }),
}));

function userReport(n: number): NostrEvent {
  return {
    id: n.toString(16).padStart(64, 'a'),
    pubkey: 'b'.repeat(64),
    created_at: 1751000000 + n,
    kind: 1984,
    tags: [['p', USER, 'spam']],
    content: `user report ${n}`,
    sig: 'c'.repeat(128),
  };
}

function eventReport(n: number, eventId: string): NostrEvent {
  return {
    ...userReport(n),
    id: n.toString(16).padStart(64, 'e'),
    tags: [['e', eventId, 'spam'], ['p', USER]],
    content: `event report ${n}`,
  };
}

const currentTarget = { type: 'event' as const, value: CURRENT_EVENT };

function renderCard(pubkey: string = USER, qc?: QueryClient) {
  const client = qc ?? new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui = (key: string) => (
    <QueryClientProvider client={client}>
      <RelatedReportsCard pubkey={pubkey} currentTarget={currentTarget} key={key} />
    </QueryClientProvider>
  );
  const view = render(ui('a'));
  return { ...view, client, rerenderCard: () => view.rerender(ui('a')) };
}

describe('RelatedReportsCard', () => {
  beforeEach(() => {
    fetchReportsByTarget.mockReset();
    config.apiUrl = 'https://api-a.example';
  });

  it('counts the complete read, not whatever the queue has loaded', async () => {
    fetchReportsByTarget.mockResolvedValue({
      events: [userReport(1), userReport(2), eventReport(3, '2'.repeat(64))],
      truncated: false,
    });
    renderCard();

    expect(await screen.findByText(/Related Reports \(3 on same user\)/)).toBeInTheDocument();
    expect(screen.getByText(/Reports on this User \(2\)/)).toBeInTheDocument();
    expect(screen.getByText(/Reports on their Events \(1\)/)).toBeInTheDocument();
  });

  it('reads with the lowercase pubkey', async () => {
    fetchReportsByTarget.mockResolvedValue({ events: [userReport(1)], truncated: false });
    renderCard(USER.toUpperCase());

    await screen.findByText(/Related Reports/);
    expect(fetchReportsByTarget).toHaveBeenCalledWith('https://api-a.example', { pubkey: USER });
  });

  it("excludes the current report's own target", async () => {
    fetchReportsByTarget.mockResolvedValue({
      events: [eventReport(1, CURRENT_EVENT), eventReport(2, '2'.repeat(64))],
      truncated: false,
    });
    renderCard();

    expect(await screen.findByText(/Related Reports \(1 on same user\)/)).toBeInTheDocument();
  });

  it('shows a floor when the read stopped early', async () => {
    fetchReportsByTarget.mockResolvedValue({
      events: [userReport(1), userReport(2)],
      truncated: true,
    });
    renderCard();

    expect(await screen.findByText(/Related Reports \(2\+ on same user\)/)).toBeInTheDocument();
    expect(screen.getByText(/Reports on this User \(2\+\)/)).toBeInTheDocument();
  });

  it('keeps the card, as a floor, when a read that stopped early found nothing related', async () => {
    fetchReportsByTarget.mockResolvedValue({ events: [eventReport(1, CURRENT_EVENT)], truncated: true });
    renderCard();

    expect(await screen.findByText(/Related Reports \(0\+ on same user\)/)).toBeInTheDocument();
  });

  it('says the read failed, offers Try again, and does not read as zero', async () => {
    fetchReportsByTarget.mockRejectedValueOnce(new Error('boom'));
    fetchReportsByTarget.mockResolvedValueOnce({ events: [userReport(1)], truncated: false });
    renderCard();

    expect(await screen.findByText(/related reports could not be loaded/i)).toBeInTheDocument();
    expect(screen.queryByText(/on same user/)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByText(/Related Reports \(1 on same user\)/)).toBeInTheDocument();
  });

  it('shows no number while the read is pending', async () => {
    fetchReportsByTarget.mockReturnValue(new Promise(() => {}));
    renderCard();

    expect(await screen.findByText(/checking/i)).toBeInTheDocument();
    expect(screen.queryByText(/\d+ on same user/)).not.toBeInTheDocument();
  });

  it('hides the card after a complete read finds nothing related', async () => {
    fetchReportsByTarget.mockResolvedValue({ events: [eventReport(1, CURRENT_EVENT)], truncated: false });
    renderCard();

    await waitFor(() => expect(fetchReportsByTarget).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText(/checking/i)).not.toBeInTheDocument());
    expect(screen.queryByText(/Related Reports/)).not.toBeInTheDocument();
  });

  it("does not show another environment's reports after the API URL changes", async () => {
    fetchReportsByTarget.mockImplementation(async (apiUrl: string) => ({
      events: apiUrl === 'https://api-a.example' ? [userReport(1), userReport(2)] : [userReport(3)],
      truncated: false,
    }));
    const { rerenderCard } = renderCard();
    expect(await screen.findByText(/Related Reports \(2 on same user\)/)).toBeInTheDocument();

    config.apiUrl = 'https://api-b.example';
    rerenderCard();

    expect(await screen.findByText(/Related Reports \(1 on same user\)/)).toBeInTheDocument();
    expect(fetchReportsByTarget).toHaveBeenCalledWith('https://api-b.example', { pubkey: USER });
  });
});
