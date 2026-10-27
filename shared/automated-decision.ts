// ABOUTME: The moderator_pubkey the worker writes on decisions it makes by itself,
// ABOUTME: and the test for a decision row that no person made.

import { AUTO_HIDE_ACTIONS } from './autohide';

// ReportWatcher writes this when no moderator pubkey comes with a decision:
// on its own decisions (logDecision, today when it opens an age-review case),
// and as a fallback when it records a person's confirm or restore of an
// auto-hide. Rows already in D1 carry it, so it cannot change.
export const AUTOMATED_MODERATOR = 'auto';

// A decision no person made. Auto-hide actions never count, whoever wrote
// them: the fallback above puts this marker on a person's auto-hide decisions
// too, and every reader of auto-hide rows goes by their state, not their author.
export function isAutomatedDecision(row: { action: string; moderator_pubkey?: string | null }): boolean {
  return row.moderator_pubkey === AUTOMATED_MODERATOR
    && !(AUTO_HIDE_ACTIONS as readonly string[]).includes(row.action);
}
