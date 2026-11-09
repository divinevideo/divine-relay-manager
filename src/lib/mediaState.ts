// ABOUTME: The moderation state a media action expects, and plain words for a refusal
// ABOUTME: Shared by the single-post media buttons and the bulk notes panel

import { ApiError, type ExpectedMediaState } from './adminApi';

// A recorded state in plain words (moderation-service's names).
const STATE_WORDS: Record<string, string> = {
  SAFE: 'public',
  QUARANTINE: 'hidden',
  PERMANENT_BAN: 'blocked',
  AGE_RESTRICTED: 'behind the 18+ gate',
  REVIEW: 'waiting for review',
  DELETE: 'deleted',
};
export const stateInWords = (state: string) => STATE_WORDS[state] ?? state.toLowerCase().replace(/_/g, ' ');

// The `from` a media write sends: the state the screen showed for the file, so
// the worker refuses the write if the file has changed since (#336). The worker
// compares it with check-result's `status`, which moderation-service sets to the
// stored action, or 'unknown' when there is no record. A file whose status could
// not be read, or has not arrived, has no state to name, so nothing is sent and
// the write goes ahead unchecked, as it did before.
export function expectedStateOf(
  status: { action?: string | null; unreadable?: boolean } | undefined,
): ExpectedMediaState | undefined {
  if (!status || status.unreadable) return undefined;
  return (status.action ?? 'UNKNOWN') as ExpectedMediaState;
}

// The worker's refusals of a write whose `from` no longer holds, in words for a
// moderator, or undefined for any other error. They speak of the record, which
// is what the worker compares: the media server can still hide a file whose
// record says public. And of the one file refused, since on a post with several
// videos the files before it may have changed.
export function describeStateRefusal(error: unknown): string | undefined {
  if (!(error instanceof ApiError)) return undefined;
  if (error.code === 'state_unreadable') {
    return "The file's moderation record could not be checked just now, so it was left as it is";
  }
  if (error.code !== 'state_mismatch') return undefined;
  const now = error.currentState;
  if (!now) return "The file's moderation record changed after this screen loaded";
  if (now === 'UNKNOWN') return "The file's moderation record was removed after this screen loaded";
  return `The file's moderation record changed after this screen loaded and now shows it ${stateInWords(now)}`;
}
