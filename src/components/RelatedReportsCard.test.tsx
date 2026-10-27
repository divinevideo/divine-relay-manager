// ABOUTME: Pins that the Related Reports card counts the account's complete report read,
// ABOUTME: and never shows a failed, pending or stopped-early read as a total.

import { render, screen, waitFor, act } from '@testing-library/react';
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

    expect(await screen.findByText(/Related Reports \(3 more on this account\)/)).toBeInTheDocument();
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

    expect(await screen.findByText(/Related Reports \(1 more on this account\)/)).toBeInTheDocument();
  });

  it('shows a floor, on every count, when the read stopped early', async () => {
    fetchReportsByTarget.mockResolvedValue({
      events: [
        userReport(1), userReport(2), userReport(3), userReport(4), userReport(5),
        eventReport(6, '2'.repeat(64)), eventReport(7, '3'.repeat(64)),
        eventReport(8, '4'.repeat(64)), eventReport(9, '5'.repeat(64)),
      ],
      truncated: true,
    });
    renderCard();

    expect(await screen.findByText(/Related Reports \(9\+ more on this account\)/)).toBeInTheDocument();
    expect(screen.getByText(/Reports on this User \(5\+\)/)).toBeInTheDocument();
    expect(screen.getByText(/Reports on their Events \(4\+\)/)).toBeInTheDocument();
    // No leading "+" next to a trailing one: "2+ more", not "+2+ more".
    expect(screen.getByText('2+ more user reports')).toBeInTheDocument();
    expect(screen.getByText('1+ more event report')).toBeInTheDocument();
  });

  it('shows an exact "+N more" for the rest of a complete read', async () => {
    fetchReportsByTarget.mockResolvedValue({
      events: [
        userReport(1), userReport(2), userReport(3), userReport(4), userReport(5),
        eventReport(6, '2'.repeat(64)), eventReport(7, '3'.repeat(64)),
        eventReport(8, '4'.repeat(64)), eventReport(9, '5'.repeat(64)),
      ],
      truncated: false,
    });
    renderCard();

    expect(await screen.findByText('+2 more user reports')).toBeInTheDocument();
    expect(screen.getByText('+1 more event report')).toBeInTheDocument();
  });

  it.each([
    [false, '+1 more user report', '+1 more event report'],
    [true, '1+ more user report', '1+ more event report'],
  ])('says "report", not "reports", for one more (stopped early: %s)', async (truncated, userLine, eventLine) => {
    fetchReportsByTarget.mockResolvedValue({
      events: [
        userReport(1), userReport(2), userReport(3), userReport(4),
        eventReport(5, '2'.repeat(64)), eventReport(6, '3'.repeat(64)),
        eventReport(7, '4'.repeat(64)), eventReport(8, '5'.repeat(64)),
      ],
      truncated,
    });
    renderCard();

    expect(await screen.findByText(userLine)).toBeInTheDocument();
    expect(screen.getByText(eventLine)).toBeInTheDocument();
  });

  it('says so, not "0+", when a read that stopped early found nothing else', async () => {
    fetchReportsByTarget.mockResolvedValue({ events: [eventReport(1, CURRENT_EVENT)], truncated: true });
    renderCard();

    expect(await screen.findByText(
      /none found in the part of this account's history that could be read/i,
    )).toBeInTheDocument();
    expect(screen.queryByText(/0\+/)).not.toBeInTheDocument();
  });

  it('does not crash on a report with a valueless p tag, and does not count it', async () => {
    // getReportTarget keeps a malformed report visible (a bare ["p"] gives a
    // pubkey target with no value), and the read still returns it because its
    // second p tag names the account.
    const malformed: NostrEvent = { ...userReport(1), tags: [['p'], ['p', USER]] };
    fetchReportsByTarget.mockResolvedValue({ events: [malformed, userReport(2)], truncated: false });
    renderCard();

    expect(await screen.findByText(/Related Reports \(1 more on this account\)/)).toBeInTheDocument();
  });

  it('does not count a report whose first p tag is another account', async () => {
    // The target is the first p tag; the read returns the report only because
    // a later p tag names this account.
    const other: NostrEvent = { ...userReport(1), tags: [['p', 'f'.repeat(64)], ['p', USER]] };
    fetchReportsByTarget.mockResolvedValue({ events: [other, userReport(2)], truncated: false });
    renderCard();

    expect(await screen.findByText(/Reports on this User \(1\)/)).toBeInTheDocument();
  });

  it('does not count an event report that does not name the account', async () => {
    const unrelated: NostrEvent = { ...eventReport(1, '2'.repeat(64)), tags: [['e', '2'.repeat(64)], ['p', 'f'.repeat(64)]] };
    fetchReportsByTarget.mockResolvedValue({ events: [unrelated, userReport(2)], truncated: false });
    renderCard();

    expect(await screen.findByText(/Related Reports \(1 more on this account\)/)).toBeInTheDocument();
    expect(screen.queryByText(/Reports on their Events/)).not.toBeInTheDocument();
  });

  it('does not read when there is no pubkey', async () => {
    renderCard('');

    await act(async () => {});
    expect(fetchReportsByTarget).not.toHaveBeenCalled();
    expect(screen.queryByText(/Related Reports/)).not.toBeInTheDocument();
  });

  it('asks for one retry and a five-minute cache lifetime', async () => {
    fetchReportsByTarget.mockResolvedValue({ events: [userReport(1)], truncated: false });
    const { client } = renderCard();
    await screen.findByText(/Related Reports/);

    const query = client.getQueryCache().find({ queryKey: ['account-reports', 'https://api-a.example', USER] });
    expect(query?.options.retry).toBe(1);
    expect(query?.options.gcTime).toBe(5 * 60_000);
  });

  it('shows the failure, not the earlier count, when a refetch fails with data on hand', async () => {
    fetchReportsByTarget.mockResolvedValueOnce({ events: [userReport(1)], truncated: false });
    const { client } = renderCard();
    expect(await screen.findByText(/Related Reports \(1 more on this account\)/)).toBeInTheDocument();

    fetchReportsByTarget.mockRejectedValue(new Error('boom'));
    void client.refetchQueries({ queryKey: ['account-reports'] });

    expect(await screen.findByText(/related reports could not be loaded/i, {}, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.queryByText(/more on this account/)).not.toBeInTheDocument();
  });

  it('disables Try again while the retry is in flight', async () => {
    fetchReportsByTarget.mockResolvedValueOnce({ events: [userReport(1)], truncated: false });
    const { client } = renderCard();
    await screen.findByText(/Related Reports \(1 more on this account\)/);

    fetchReportsByTarget.mockRejectedValue(new Error('boom'));
    void client.refetchQueries({ queryKey: ['account-reports'] });
    const button = await screen.findByRole('button', { name: /try again/i }, { timeout: 4000 });
    expect(button).toBeEnabled();

    fetchReportsByTarget.mockReturnValue(new Promise(() => {}));
    await userEvent.click(button);

    await waitFor(() => expect(screen.getByRole('button', { name: /try again/i })).toBeDisabled());
  });

  it('says the read failed, offers Try again, and does not read as zero', async () => {
    fetchReportsByTarget.mockRejectedValueOnce(new Error('boom'));
    fetchReportsByTarget.mockRejectedValueOnce(new Error('boom'));
    fetchReportsByTarget.mockResolvedValueOnce({ events: [userReport(1)], truncated: false });
    renderCard();

    // One retry (1 s backoff) before the failure shows.
    expect(await screen.findByText(/related reports could not be loaded/i, {}, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.queryByText(/more on this account/)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByText(/Related Reports \(1 more on this account\)/)).toBeInTheDocument();
  });

  it('shows no number while the read is pending', async () => {
    fetchReportsByTarget.mockReturnValue(new Promise(() => {}));
    renderCard();

    expect(await screen.findByText(/checking/i)).toBeInTheDocument();
    expect(screen.queryByText(/\d+ more on this account/)).not.toBeInTheDocument();
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
    expect(await screen.findByText(/Related Reports \(2 more on this account\)/)).toBeInTheDocument();

    config.apiUrl = 'https://api-b.example';
    rerenderCard();

    expect(await screen.findByText(/Related Reports \(1 more on this account\)/)).toBeInTheDocument();
    expect(fetchReportsByTarget).toHaveBeenCalledWith('https://api-b.example', { pubkey: USER });
  });
});
