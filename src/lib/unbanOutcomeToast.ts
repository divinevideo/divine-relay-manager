// ABOUTME: The toast for an unban, worded from what the worker said became of the timed
// ABOUTME: suspension. Never says it ended or resumed when the outcome says otherwise.
import type { UnbanOutcome } from '@/lib/adminApi';
import { SUSPENSION_END_UNAVAILABLE } from '@/lib/suspensionEndText';
import { formatSuspensionEnd } from '../../shared/suspension';

// Apart from the dialog because the repo's lint (react-refresh) keeps a
// component file to component exports.

export interface UnbanToast { title: string; description?: string; variant?: 'destructive' }

const AUDIT_NOT_RECORDED = 'Action applied; audit log not recorded';
const CHECK_ACCOUNT = 'Check the account before acting again.';
const STILL_NO_END = 'User unbanned. Still suspended, no end date';

/** The suspension stayed on (resumed): say until when, honestly. */
function resumedToast(endsAt: string | null | undefined, now: Date): UnbanToast {
  if (!endsAt) return { title: STILL_NO_END };
  const end = new Date(endsAt);
  // An end the UI cannot read is unknown: never a formatted "NaN", never "no end date".
  if (Number.isNaN(end.getTime())) return { title: 'User unbanned', description: SUSPENSION_END_UNAVAILABLE };
  // A past end is lifted by the next check, so "still suspended until" it would be untrue.
  if (end.getTime() <= now.getTime()) {
    return { title: 'User unbanned. The end date has passed, so the suspension lifts at the next check' };
  }
  return { title: `User unbanned. Still suspended until ${formatSuspensionEnd(endsAt)}` };
}

/**
 * First match wins. A skipped choice comes before the state: the worker then
 * omits the suspension (state 'none'), and a plain "User unbanned" would hide
 * that the moderator's choice was not applied. A missing decision row is said
 * only over an outcome that went as asked; a failure or an unknown outranks it.
 */
export function unbanOutcomeToast(o: UnbanOutcome, now: Date = new Date()): UnbanToast {
  if (o.choiceSkipped) {
    return { title: 'User unbanned, but the suspension choice was not applied', description: CHECK_ACCOUNT };
  }
  const { state, endsAt, decisionRecorded } = o.suspension;
  let done: UnbanToast;
  switch (state) {
    case 'end_failed':
      return {
        title: 'User unbanned, but the suspension could not be lifted',
        description: 'It is still suspended. Try Unsuspend.',
        variant: 'destructive',
      };
    case 'unknown':
      return { title: 'User unbanned, but the suspension status could not be checked', description: CHECK_ACCOUNT };
    // The timer moved during the unban, so the worker applied no choice (ask again if it changed).
    case 'changed':
      return {
        title: 'User unbanned, but the suspension changed before your choice was saved',
        description: `The suspension was left as it was. ${CHECK_ACCOUNT}`,
      };
    case 'not_suspended':
    case 'none':
      return { title: 'User unbanned' };
    case 'ended':
      done = { title: 'User unbanned and unsuspended' };
      break;
    case 'open_ended':
      done = { title: STILL_NO_END };
      break;
    case 'resumed':
      done = resumedToast(endsAt, now);
      break;
  }
  return decisionRecorded === false ? { title: AUDIT_NOT_RECORDED, description: unbanOutcomeNote(done) } : done;
}

/** The outcome as one line, for a later audit warning that replaces the toast (one shows at a time). */
export function unbanOutcomeNote(t: Pick<UnbanToast, 'title' | 'description'>): string {
  return t.description ? `${t.title}. ${t.description}` : t.title;
}

const AUDIT_NOTE = 'Audit log not recorded.';

/** What the moderator must see first: a missing audit row never takes its place. */
function outranksAudit(o: UnbanOutcome): boolean {
  return !!o.choiceSkipped || o.suspension.state === 'end_failed' || o.suspension.state === 'unknown'
    || o.suspension.state === 'changed';
}

/**
 * The toast when the browser's own audit write failed after the unban landed. It
 * replaces the outcome's toast (one shows at a time), so it follows the same ranking
 * as unbanOutcomeToast: a failure or an unknown keeps its title and its destructive
 * variant, with the audit note added; anything else leads with the warning and
 * carries the outcome, saying the warning once when the outcome already does.
 */
export function unbanAuditFailedToast(o: UnbanOutcome, now: Date = new Date()): UnbanToast {
  const t = unbanOutcomeToast(o, now);
  if (outranksAudit(o)) return { ...t, description: t.description ? `${t.description} ${AUDIT_NOTE}` : AUDIT_NOTE };
  if (t.title === AUDIT_NOT_RECORDED) return t;
  return { title: AUDIT_NOT_RECORDED, description: unbanOutcomeNote(t), ...(t.variant && { variant: t.variant }) };
}
