// ABOUTME: Pure synthesis of an age-review target's account type, enforcement
// ABOUTME: compliance legs, and a one-line "what's effective" verdict. No I/O.
import type { AccountStatusResponse } from './adminApi';

export type AccountType = 'divine' | 'self_custody' | 'unknown';
export type LegState = 'done' | 'missing' | 'na' | 'not_tracked';

export interface ComplianceLeg {
  key: 'signin' | 'ticket' | 'content_restrict' | 'relay_suspend';
  label: string;
  state: LegState;
}

export type SignInStatus = 'active' | 'blocked' | 'unknown' | 'not_applicable';

export interface AccountVerdict {
  accountType: AccountType;
  signInStatus: SignInStatus;
  contentPresence: 'visible' | 'hidden_suspended' | 'none' | 'unknown';
  legs: ComplianceLeg[];
  verdict: string;
}

export interface DeriveInput {
  accountStatus: AccountStatusResponse | undefined;
  accountStatusError: boolean;
  postCount: number | undefined;
  // Whether the relay content read has resolved. A failed/in-flight read leaves
  // postCount undefined, which must NOT be read as "no content" — that would
  // under-state available enforcement (the content lever silently dropped).
  contentPresenceKnown: boolean;
  ticketLinked: boolean;
}

export function deriveAccountVerdict(input: DeriveInput): AccountVerdict {
  const { accountStatus, accountStatusError, postCount, contentPresenceKnown, ticketLinked } = input;

  // Account type is data-first: if TanStack keeps cached success data after a
  // failed background refetch, the UI should not contradict that cached status.
  let accountType: AccountType;
  if (accountStatus?.not_found) {
    accountType = 'self_custody';
  } else if (accountStatus?.success) {
    accountType = 'divine';
  } else if (accountStatusError || accountStatus?.success === false) {
    accountType = 'unknown';
  } else {
    accountType = 'unknown';
  }

  const suspended = accountStatus?.status === 'suspended';
  // Both suspended and banned block sign-in. Kept separate from `suspended`
  // because only *suspend* hides content reversibly — ban purges it.
  const signInBlocked = suspended || accountStatus?.status === 'banned';
  const hasContent = (postCount ?? 0) > 0;
  // Suspension hides content, so 'hidden_suspended' is the honest read there
  // regardless of the relay result. Otherwise, an unresolved read is 'unknown'
  // (not 'none') so we never assert an empty account we haven't confirmed.
  const contentPresence: AccountVerdict['contentPresence'] =
    hasContent ? 'visible'
    : suspended ? 'hidden_suspended'
    : contentPresenceKnown ? 'none'
    : 'unknown';

  // Content legs are applicable when content is present, possibly hidden by
  // suspension, or not-yet-confirmed; their done-state is not durably recorded
  // yet (deps #123). Only a confirmed-empty account marks them n/a.
  const contentApplicable = contentPresence !== 'none';
  const contentLegState: LegState = contentApplicable ? 'not_tracked' : 'na';

  const signInStatus: SignInStatus =
    accountType === 'self_custody' ? 'not_applicable'
    : accountType === 'unknown' ? 'unknown'
    : signInBlocked ? 'blocked'
    : accountStatus?.status === 'active' ? 'active'
    : 'unknown';

  const signinState: LegState =
    signInStatus === 'not_applicable' ? 'na'
    : signInStatus === 'unknown' ? 'not_tracked'
    : signInStatus === 'blocked' ? 'done'
    : 'missing';

  const legs: ComplianceLeg[] = [
    { key: 'signin', label: 'Sign-in (keycast) suspend', state: signinState },
    { key: 'content_restrict', label: 'Content age-restrict', state: contentLegState },
    { key: 'relay_suspend', label: 'Relay content suspend', state: contentLegState },
    { key: 'ticket', label: 'Age-review ticket', state: ticketLinked ? 'done' : 'missing' },
  ];

  return {
    accountType,
    signInStatus,
    contentPresence,
    legs,
    verdict: buildVerdict(accountType, contentPresence, signinState, ticketLinked),
  };
}

function buildVerdict(
  accountType: AccountType,
  contentPresence: AccountVerdict['contentPresence'],
  signinState: LegState,
  ticketLinked: boolean,
): string {
  const contentUnknownNote =
    'Relay content status unavailable — verify content directly before ruling out a content action.';

  const available: string[] = [];
  if (signinState === 'missing') available.push('suspend sign-in');
  // Only offer a content action when content is present or likely-hidden. When
  // the read is 'unknown' we do NOT auto-list it (we can't confirm content) and
  // do NOT conclude "no content" — the note below tells the moderator to verify.
  if (contentPresence === 'visible' || contentPresence === 'hidden_suspended') {
    available.push('age-restrict/remove content');
  }
  if (!ticketLinked) available.push('open ticket');

  // Keycast unavailable: only the SIGN-IN leg is unconfirmed. Content-presence
  // and ticket don't depend on keycast, so still surface those actions instead
  // of collapsing the whole verdict to "retry". (signinState is 'not_tracked'
  // here, so 'suspend sign-in' is never in `available`.)
  if (accountType === 'unknown') {
    const note = 'Sign-in lever unconfirmed (account status unavailable) — retry before relying on it.';
    const tail = contentPresence === 'unknown' ? ` ${contentUnknownNote}` : '';
    return available.length > 0
      ? `${note} Content/ticket actions still apply: ${available.join(', ')}.${tail}`
      : `${note}${tail}`;
  }

  if (signinState === 'not_tracked') {
    const note = 'Sign-in status unavailable — retry before relying on it.';
    const tail = contentPresence === 'unknown' ? ` ${contentUnknownNote}` : '';
    return available.length > 0
      ? `${note} Available: ${available.join(', ')}.${tail}`
      : `${note}${tail}`;
  }

  const prefix = accountType === 'self_custody' ? 'Sign-in suspend N/A (self-custody). ' : '';

  if (available.length > 0) {
    const tail = contentPresence === 'unknown' ? ` ${contentUnknownNote}` : '';
    return `${prefix}Available: ${available.join(', ')}.${tail}`;
  }
  // available is empty
  if (contentPresence === 'unknown') {
    // Never conclude unactionable on an unconfirmed content read (Story B).
    return `${prefix}${contentUnknownNote}`;
  }
  if (accountType === 'self_custody' && contentPresence === 'none') {
    return 'No effective enforcement available (self-custody, no relay content) — record/ticket only.';
  }
  // Only reachable once content-leg done-tracking lands (#123): all applicable
  // legs done. Until then content legs are 'not_tracked', so this never fires
  // and the verdict can never wrongly claim full enforcement.
  return `${prefix}Fully enforced — no further action needed.`;
}
