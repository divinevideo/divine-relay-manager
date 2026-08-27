// ABOUTME: Derives the /api/tickets lookup target for a report's linked-ticket panel.
// ABOUTME: Event-scoped reports look up ONLY their event; pubkey-scoped look up the author.

export interface ReportTarget {
  type: 'event' | 'pubkey';
  value: string;
}

export interface LinkedTicketTarget {
  eventId?: string;
  pubkey?: string;
}

// An event-scoped report looks up only that event's tickets. Passing the author too
// would union in tickets filed about the author's OTHER posts (getLinkedTickets ORs
// the two lookups), which render identically in the panel and let a moderator close a
// ticket about a different video. Only a pubkey-scoped report — about the account
// itself — looks up by author.
export function linkedTicketTarget(
  target: ReportTarget | null | undefined,
  reportedPubkey: string | null | undefined,
): LinkedTicketTarget {
  return {
    eventId: target?.type === 'event' ? target.value : undefined,
    pubkey: target?.type === 'pubkey' ? (reportedPubkey ?? undefined) : undefined,
  };
}
