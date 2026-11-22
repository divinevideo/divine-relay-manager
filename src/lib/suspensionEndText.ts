// ABOUTME: Words a suspended account's end date for the line under it, first match wins,
// ABOUTME: and never claims "no end date" when the end could not be read.
import { formatSuspensionEnd, type TimedSuspensionView } from '../../shared/suspension';

// Apart from SuspensionEndLine.tsx because the repo's lint (react-refresh, no
// inline overrides) keeps a component file to component exports.
/** The end is unknown (unreadable list or unreadable end). Shared with the dialog's Currently line. */
export const SUSPENSION_END_UNAVAILABLE = 'Suspended. End date unavailable';
const UNAVAILABLE = SUSPENSION_END_UNAVAILABLE;
const PAUSED_BY_BAN = 'Timer paused by a ban, so it will not lift on its own. Use Change end date to restart it';

/**
 * First match wins. `record` follows useTimedSuspension: undefined while the
 * list has not answered, null when it answered without this account. An
 * unreadable list (`isError`) is never "no end date": that would tell the
 * moderator the suspension is open-ended when nobody knows.
 */
export function suspensionEndText(a: {
  record: TimedSuspensionView | null | undefined;
  isError: boolean;
  banned: boolean;
  now: Date;
  /** Whether the scheduler lifts a passed end on its own. False when unknown (fail closed). */
  autoLift: boolean;
}): string {
  const { record, isError, banned, now, autoLift } = a;
  // A failed read also leaves the record undefined, so loading is "undefined
  // and no error"; the error case comes next.
  if (record === undefined && !isError) return 'Checking suspension end date';
  if (isError) return UNAVAILABLE;
  const endsAt = record?.endsAt;
  if (banned && endsAt) return 'Banned. The timed suspension will not lift while the ban stands';
  // The tick lifts only active rows, so a timer a ban paused never lifts on its own, even
  // when this screen does not see the ban (list loading or failed, a record an unban left
  // behind, a Keycast-only ban). Change end date makes it active again.
  if (record?.status === 'cancelled_ban') return PAUSED_BY_BAN;
  if (endsAt) {
    const end = new Date(endsAt);
    // An end the UI cannot read is not one it can show.
    if (Number.isNaN(end.getTime())) return UNAVAILABLE;
    const formatted = formatSuspensionEnd(endsAt);
    if (end.getTime() > now.getTime()) return `Suspended until ${formatted}`;
    // With automatic lifting off, nothing lifts it but a moderator's Unsuspend.
    return autoLift ? `End time passed (${formatted}). Lifts at the next check` : 'End time passed. Unsuspend to lift it.';
  }
  return 'Suspended, no end date';
}
