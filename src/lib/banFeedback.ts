// ABOUTME: Toast copy shared by every account-ban button
// ABOUTME: Keeps "may have landed" distinct from "failed" so moderators don't retry a ban

import type { QueryClient } from '@tanstack/react-query';
import { BanNotConfirmedError, type BanOutcome } from './adminApi';

// "Ban not confirmed" tells the moderator to re-check the account, so drop the
// cached ban lists that would otherwise still show the state from before the click.
export function refreshAfterUnconfirmedBan(error: Error, queryClient: QueryClient): void {
  if (!(error instanceof BanNotConfirmedError)) return;
  queryClient.invalidateQueries({ queryKey: ['banned-pubkeys'] });
  queryClient.invalidateQueries({ queryKey: ['banned-users'] });
}

// Each note states what is certain (the ban is on the relay's list) and why the
// rest is not. Nothing here promises that unfinished work will finish: once the
// request ends, Cloudflare may cancel the worker's remaining steps. Cases that
// may still resolve point at a later check; cases that will not route to a person.
const NOTES: Record<NonNullable<BanOutcome['unconfirmed']>, string> = {
  // Neutral on purpose: several failures land here (a purge error, a gateway or
  // network error, an unreadable response), not only a failed deletion.
  removal_error:
    "The ban is in effect, but the relay returned an error, so we couldn't confirm their content was removed.",
  // At our 15s bound the relay may still have been snapshotting, not deleting.
  removal_running:
    "The ban is in effect. The relay hadn't finished removing their content when we stopped waiting, so " +
    'some may remain. You may want to check their content again in a few minutes.',
  follow_ups:
    "The ban is in effect, but the server didn't finish its follow-up steps (login block, notice to the user, " +
    'ticket closure) before we stopped waiting, so they may not have happened. You may want to check the ' +
    'account in a few minutes.',
  follow_ups_skipped:
    "The ban is in effect, but the server couldn't confirm it in time, so its follow-up steps (login block, " +
    'notice to the user, ticket closure) did not run. Let T&S Engineering know so they can be applied.',
};

/** Extra description for a successful ban, or undefined when everything was confirmed. */
export function banSuccessNote(outcome: BanOutcome): string | undefined {
  return outcome.unconfirmed ? NOTES[outcome.unconfirmed] : undefined;
}

// A retry is not a no-op at the relay (it re-enforces under a new id), so a ban
// that may have applied gets a non-destructive "not confirmed" instead of "failed".
export function banFailureToast(
  error: Error,
  titles: { failure?: string; notConfirmed?: string } = {},
): {
  title: string;
  description: string;
  variant?: 'destructive';
} {
  if (error instanceof BanNotConfirmedError) {
    return { title: titles.notConfirmed ?? 'Ban not confirmed', description: error.message };
  }
  return { title: titles.failure ?? 'Failed to ban user', description: error.message, variant: 'destructive' };
}
