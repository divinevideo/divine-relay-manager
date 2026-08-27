// ABOUTME: Always-present panel showing the Zendesk ticket(s) linked to a report.
// ABOUTME: Open tickets get an active Close button; closed ones show an affirmative badge.

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/useToast';
import { useAdminApi } from '@/hooks/useAdminApi';
import { useCurrentUser } from '@/hooks/useCurrentUser';

interface LinkedTicketPanelProps {
  eventId?: string;
  pubkey?: string;
}

// Status source is D1 (our own record), so an auto-closing action flips a ticket
// to "Closed ✓" as soon as the panel refetches. There is deliberately never a
// disabled "Close" button: closed shows as a done badge, open shows an active
// button, and no-link shows informational text — so a moderator is never left
// staring at a greyed-out control wondering whether closing is possible.
export function LinkedTicketPanel({ eventId, pubkey }: LinkedTicketPanelProps) {
  const api = useAdminApi();
  const { toast } = useToast();
  const { getModeratorPubkey } = useCurrentUser();
  const queryClient = useQueryClient();

  const queryKey = ['linked-tickets', eventId ?? null, pubkey ?? null];

  const { data: tickets, isLoading, isError } = useQuery({
    queryKey,
    queryFn: () => api.getLinkedTickets({ eventId, pubkey }),
    enabled: !!(eventId || pubkey),
    staleTime: 15_000,
  });

  // One mutation instance holds ONE `variables`, so it cannot answer "is THIS
  // ticket closing?" once two closes overlap — the second click overwrites the
  // first, and the first row silently reverts to an active Close button while its
  // request is still in flight. Worse on failure: the toast fires for the ticket
  // that failed while the row still marked "Closing…" is the other one, so the
  // moderator reads the failure against the wrong ticket and the one that did
  // fail looks finished. Track the in-flight ids instead.
  const [closingIds, setClosingIds] = useState<ReadonlySet<number>>(new Set());

  const closeMutation = useMutation({
    mutationFn: async (ticketId: number) => {
      const moderator = await getModeratorPubkey();
      await api.closeTicket(ticketId, moderator);
    },
    onMutate: (ticketId: number) => {
      setClosingIds(prev => new Set(prev).add(ticketId));
    },
    onSettled: (_data, _error, ticketId: number) => {
      setClosingIds(prev => {
        const next = new Set(prev);
        next.delete(ticketId);
        return next;
      });
    },
    onSuccess: () => {
      toast({ title: 'Ticket closed' });
      // Invalidate the whole family so this report — and any other open on the
      // same target — reflect the closure.
      queryClient.invalidateQueries({ queryKey: ['linked-tickets'] });
    },
    onError: (error: Error) => {
      toast({ title: 'Failed to close ticket', description: error.message, variant: 'destructive' });
    },
  });

  if (!eventId && !pubkey) return null;
  if (isLoading) {
    return <p className="text-sm text-muted-foreground">Checking linked tickets…</p>;
  }
  // A failed read must not render as "no ticket". The lookup is only trustworthy
  // once it resolves without error, and the two states are indistinguishable to a
  // moderator otherwise -- including the interim where this ships ahead of the
  // worker endpoints and every lookup 404s. Same rule as AgeReviewDetail's
  // contentPresenceKnown. The query refetches on window focus, so this clears
  // itself once the endpoint answers.
  if (isError) {
    return <p className="text-sm text-muted-foreground">Couldn&apos;t check linked tickets</p>;
  }
  if (!tickets || tickets.length === 0) {
    return <p className="text-sm text-muted-foreground">No linked Zendesk ticket found</p>;
  }

  return (
    <div className="space-y-1">
      {tickets.map((ticket) => {
        const isOpen = ticket.status === 'open';
        const isResolved = ticket.status === 'resolved';
        // Scope pending state to THIS ticket, so closing one open ticket never
        // greys out or mislabels a sibling open ticket on the same report — and so
        // two overlapping closes each report their own state.
        const isClosingThis = closingIds.has(ticket.ticket_id);
        return (
          <div key={ticket.ticket_id} className="flex items-center gap-2 text-sm">
            <a href={ticket.url} target="_blank" rel="noreferrer" className="underline">
              Zendesk #{ticket.ticket_id}
            </a>
            {isOpen ? (
              <>
                <Badge variant="outline">Open</Badge>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={isClosingThis}
                  onClick={() => closeMutation.mutate(ticket.ticket_id)}
                >
                  {isClosingThis ? 'Closing…' : 'Close ticket'}
                </Button>
              </>
            ) : isResolved ? (
              <Badge variant="outline" className="border-green-500 text-green-600">Closed ✓</Badge>
            ) : (
              <Badge variant="outline">Status unavailable</Badge>
            )}
          </div>
        );
      })}
    </div>
  );
}
