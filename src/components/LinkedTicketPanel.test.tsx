// ABOUTME: The panel states a moderator acts on, including the one that must not
// ABOUTME: be confused with "no ticket": a lookup that failed.

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import TestApp from '@/test/TestApp';
import { LinkedTicketPanel } from './LinkedTicketPanel';

const getLinkedTickets = vi.fn();
const closeTicket = vi.fn();
const toast = vi.fn();

vi.mock('@/hooks/useAdminApi', () => ({
  useApiUrl: () => 'https://api.test',
  useAdminApi: () => ({
    getLinkedTickets: (...args: unknown[]) => getLinkedTickets(...args),
    closeTicket: (...args: unknown[]) => closeTicket(...args),
  }),
}));
vi.mock('@/hooks/useToast', () => ({ useToast: () => ({ toast }) }));
vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ getModeratorPubkey: async () => 'b'.repeat(64) }),
}));

const EVENT = 'e'.repeat(64);

beforeEach(() => {
  getLinkedTickets.mockReset();
  closeTicket.mockReset();
  toast.mockReset();
});

function renderPanel() {
  return render(
    <TestApp>
      <LinkedTicketPanel eventId={EVENT} />
    </TestApp>,
  );
}

describe('LinkedTicketPanel', () => {
  it('offers Close on an open ticket', async () => {
    getLinkedTickets.mockResolvedValue([{ ticket_id: 1001, status: 'open', url: 'https://z.test/1001' }]);
    renderPanel();

    expect(await screen.findByRole('button', { name: /close ticket/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Zendesk #1001/ })).toHaveAttribute('href', 'https://z.test/1001');
  });

  it('shows a resolved ticket as done, with no Close control', async () => {
    getLinkedTickets.mockResolvedValue([{ ticket_id: 1002, status: 'resolved', url: 'https://z.test/1002' }]);
    renderPanel();

    expect(await screen.findByText(/Closed/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /close ticket/i })).not.toBeInTheDocument();
  });

  it('does not claim an unexpected status is closed', async () => {
    getLinkedTickets.mockResolvedValue([{ ticket_id: 1004, status: 'pending', url: 'https://z.test/1004' }]);
    renderPanel();

    expect(await screen.findByText(/Status unavailable/)).toBeInTheDocument();
    expect(screen.queryByText(/Closed/)).not.toBeInTheDocument();
  });

  it('says no ticket is linked only when the lookup actually returned none', async () => {
    getLinkedTickets.mockResolvedValue([]);
    renderPanel();

    expect(await screen.findByText(/No linked Zendesk ticket found/i)).toBeInTheDocument();
  });

  // The regression this file exists for. A failed lookup leaves `data` undefined,
  // which is the same shape as an empty result -- so without an explicit error
  // branch the panel tells the moderator, affirmatively, that no ticket is
  // linked. That is exactly the interim state the worker endpoints not being
  // deployed yet produces, and it is the opposite of what is true.
  it('does not claim "no ticket" when the lookup failed', async () => {
    getLinkedTickets.mockRejectedValue(new Error('HTTP 404: Not Found'));
    renderPanel();

    expect(await screen.findByText(/Couldn't check linked tickets/i)).toBeInTheDocument();
    expect(screen.queryByText(/No linked Zendesk ticket found/i)).not.toBeInTheDocument();
  });

  it('closes only the ticket that was clicked, leaving a sibling actionable', async () => {
    getLinkedTickets.mockResolvedValue([
      { ticket_id: 1001, status: 'open', url: 'https://z.test/1001' },
      { ticket_id: 1003, status: 'open', url: 'https://z.test/1003' },
    ]);
    let resolveClose: () => void = () => {};
    closeTicket.mockImplementation(() => new Promise<void>((res) => { resolveClose = res; }));
    renderPanel();

    const buttons = await screen.findAllByRole('button', { name: /close ticket/i });
    await userEvent.click(buttons[0]);

    await waitFor(() => expect(screen.getByText(/Closing…/)).toBeInTheDocument());
    // The sibling keeps its own active button rather than being greyed out too.
    expect(screen.getByRole('button', { name: /close ticket/i })).toBeEnabled();
    expect(closeTicket).toHaveBeenCalledWith(1001, 'b'.repeat(64));
    resolveClose();
  });

  // Two open tickets on one report is exactly what the multi-row rendering exists
  // for, so two closes overlapping is a real sequence, not a contrived one. With
  // pending state read off the mutation's single `variables`, the second click
  // overwrote the first: only one row said "Closing…", and when the FIRST close
  // failed the row still saying it was the other ticket -- so the failure toast
  // read against a ticket that had not failed, while the one that did looked done.
  it('marks both tickets as closing when two closes overlap', async () => {
    getLinkedTickets.mockResolvedValue([
      { ticket_id: 1001, status: 'open', url: 'https://z.test/1001' },
      { ticket_id: 1003, status: 'open', url: 'https://z.test/1003' },
    ]);
    const settle: Record<number, () => void> = {};
    closeTicket.mockImplementation((id: number) => new Promise<void>((res) => { settle[id] = res; }));
    renderPanel();

    const buttons = await screen.findAllByRole('button', { name: /close ticket/i });
    await userEvent.click(buttons[0]);
    await waitFor(() => expect(screen.getByText(/Closing…/)).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /close ticket/i }));

    expect(screen.getAllByText(/Closing…/)).toHaveLength(2);
    expect(screen.queryByRole('button', { name: /close ticket/i })).not.toBeInTheDocument();
    settle[1001](); settle[1003]();
  });

  it('leaves the ticket that failed as the one still offering Close', async () => {
    getLinkedTickets.mockResolvedValue([
      { ticket_id: 1001, status: 'open', url: 'https://z.test/1001' },
      { ticket_id: 1003, status: 'open', url: 'https://z.test/1003' },
    ]);
    const settle: Record<number, () => void> = {};
    const reject: Record<number, (e: Error) => void> = {};
    closeTicket.mockImplementation((id: number) => new Promise<void>((res, rej) => {
      settle[id] = res; reject[id] = rej;
    }));
    renderPanel();

    const buttons = await screen.findAllByRole('button', { name: /close ticket/i });
    await userEvent.click(buttons[0]);                                        // 1001
    await waitFor(() => expect(screen.getByText(/Closing…/)).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /close ticket/i })); // 1003

    reject[1001](new Error('Zendesk solve did not succeed'));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Failed to close ticket', variant: 'destructive' }),
    ));

    // The failed ticket is the one a moderator can retry; the other is still going.
    const retry = await screen.findByRole('button', { name: /close ticket/i });
    expect(retry.closest('div')).toHaveTextContent('Zendesk #1001');
    expect(screen.getByText(/Closing…/).closest('div')).toHaveTextContent('Zendesk #1003');
    settle[1003]();
  });

  it('surfaces a close failure instead of reporting success', async () => {
    getLinkedTickets.mockResolvedValue([{ ticket_id: 1001, status: 'open', url: 'https://z.test/1001' }]);
    closeTicket.mockRejectedValue(new Error('Zendesk solve did not succeed'));
    renderPanel();

    await userEvent.click(await screen.findByRole('button', { name: /close ticket/i }));

    await waitFor(() => expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Failed to close ticket', variant: 'destructive' }),
    ));
  });
});
