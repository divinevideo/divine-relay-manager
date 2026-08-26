// ABOUTME: Always-present panel showing the Zendesk ticket(s) linked to a report.
// ABOUTME: Open tickets get an active Close button; closed ones show an affirmative badge.

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

  const { data: tickets, isLoading } = useQuery({
    queryKey,
    queryFn: () => api.getLinkedTickets({ eventId, pubkey }),
    enabled: !!(eventId || pubkey),
    staleTime: 15_000,
  });

  const closeMutation = useMutation({
    mutationFn: async (ticketId: number) => {
      const moderator = await getModeratorPubkey();
      await api.closeTicket(ticketId, moderator);
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
  if (!tickets || tickets.length === 0) {
    return <p className="text-sm text-muted-foreground">No linked Zendesk ticket found</p>;
  }

  return (
    <div className="space-y-1">
      {tickets.map((ticket) => {
        const isOpen = ticket.status === 'open';
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
                  disabled={closeMutation.isPending}
                  onClick={() => closeMutation.mutate(ticket.ticket_id)}
                >
                  {closeMutation.isPending ? 'Closing…' : 'Close ticket'}
                </Button>
              </>
            ) : (
              <Badge variant="outline" className="border-green-500 text-green-600">Closed ✓</Badge>
            )}
          </div>
        );
      })}
    </div>
  );
}
