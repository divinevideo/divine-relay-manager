// ABOUTME: Cache keys for getbannedevent reads, and what a Suspend or an Unsuspend does to the cached ones.
// ABOUTME: Scoped to the worker URL so pending actions only refresh their own environment.

import { useContext } from 'react';
import type { Query, QueryClient } from '@tanstack/react-query';
import type { NostrEvent } from '@nostrify/nostrify';
import { AppContext } from '@/contexts/AppContext';

export const bannedEventQueryPrefix = (apiUrl: string) => ['banned-event', apiUrl] as const;
export const bannedEventQueryKey = (apiUrl: string, eventId: string | undefined) =>
  [...bannedEventQueryPrefix(apiUrl), eventId] as const;

// A Suspend taints the banned-event reads that hold the suspended author's
// post. The worker refuses getbannedevent for a suspended author, so a post
// cached before the Suspend must not render outside the audited viewer once the
// pane that suspended has moved on. A taint belongs to one cached read at one
// data version: the read's next answer (the refusal, or anything else) clears
// it without a clock.
const tainted = new WeakMap<Query, number>();

// The read holds this author's post, or has no answer yet (its author is not
// known, and a read still out may be about to land with the post).
const authorOrUnread = (pubkey: string) => (query: Query): boolean => {
  const event = query.state.data as NostrEvent | null | undefined;
  return event == null || event.pubkey?.toLowerCase() === pubkey.toLowerCase();
};

/** The tab's current environment, for hosts that may render without an app context (some tests). */
export function useBannedEventApiUrl(): string | undefined {
  return useContext(AppContext)?.config.apiUrl;
}

export function isBannedEventReadTainted(client: QueryClient, apiUrl: string, eventId: string | undefined): boolean {
  const query = client.getQueryCache().find({ queryKey: bannedEventQueryKey(apiUrl, eventId), exact: true });
  return !!query && tainted.get(query) === query.state.dataUpdateCount;
}

/**
 * Every host of a Suspend calls this (the report pane, UserActions, age
 * review), so a read cached before it cannot show the author's post outside the
 * audited viewer. Taints the author's cached posts, marks their reads stale
 * now (a reopen straight away must find them stale), cancels the author's reads still
 * out (they started before the Suspend and could land with the post), and reads
 * again the observed reads that are the author's or have no answer, except
 * `keepEventId`: the pane that suspended keeps its post on screen.
 */
export function suspendBannedEventReads(
  client: QueryClient,
  apiUrl: string,
  pubkey: string,
  keepEventId?: string,
): void {
  const queryKey = bannedEventQueryPrefix(apiUrl);
  const forAuthor = authorOrUnread(pubkey);
  for (const query of client.getQueryCache().findAll({ queryKey })) {
    if (query.state.data != null && forAuthor(query)) tainted.set(query, query.state.dataUpdateCount);
  }
  void client.invalidateQueries({ queryKey, predicate: forAuthor, refetchType: 'none' });
  // Only the author's: another author's refresh is not re-run, so cancelling it
  // would leave its answer lost.
  void client.cancelQueries({ queryKey, predicate: forAuthor }).then(() => {
    void client.invalidateQueries({ queryKey, predicate: forAuthor, refetchType: 'none' });
    return client.refetchQueries({
      queryKey,
      type: 'active',
      predicate: query => forAuthor(query) && query.queryKey[2] !== keepEventId,
    });
  });
}

/** After an Unsuspend the live read works again: read the author's posts, and those unread, again. */
export function refreshBannedEventReadsAfterUnsuspend(client: QueryClient, apiUrl: string, pubkey: string): void {
  void client.invalidateQueries({ queryKey: bannedEventQueryPrefix(apiUrl), predicate: authorOrUnread(pubkey) });
}
