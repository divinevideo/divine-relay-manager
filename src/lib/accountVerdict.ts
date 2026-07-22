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

export interface AccountVerdict {
  accountType: AccountType;
  suspended: boolean;
  contentPresence: 'visible' | 'hidden_suspended' | 'none';
  legs: ComplianceLeg[];
  verdict: string;
}

export interface DeriveInput {
  accountStatus: AccountStatusResponse | undefined;
  accountStatusError: boolean;
  postCount: number | undefined;
  ticketLinked: boolean;
}

export function deriveAccountVerdict(input: DeriveInput): AccountVerdict {
  const { accountStatus, accountStatusError, postCount, ticketLinked } = input;

  // Account type: a query error, OR success:false without not_found, is "unknown"
  // (keycast unavailable). not_found is self-custody; success is a Divine account.
  let accountType: AccountType;
  if (accountStatusError || (accountStatus?.success === false && !accountStatus.not_found)) {
    accountType = 'unknown';
  } else if (accountStatus?.not_found) {
    accountType = 'self_custody';
  } else if (accountStatus?.success) {
    accountType = 'divine';
  } else {
    accountType = 'unknown';
  }

  const suspended = accountStatus?.status === 'suspended';
  const hasContent = (postCount ?? 0) > 0;
  const contentPresence: AccountVerdict['contentPresence'] =
    hasContent ? 'visible' : suspended ? 'hidden_suspended' : 'none';

  // Content legs are applicable when content is present OR possibly hidden by
  // suspension; their done-state is not durably recorded yet (deps #123).
  const contentApplicable = contentPresence !== 'none';
  const contentLegState: LegState = contentApplicable ? 'not_tracked' : 'na';

  const signinState: LegState =
    accountType === 'self_custody' ? 'na'
    : accountType === 'unknown' ? 'not_tracked'
    : suspended ? 'done'
    : 'missing';

  const legs: ComplianceLeg[] = [
    { key: 'signin', label: 'Sign-in (keycast) suspend', state: signinState },
    { key: 'content_restrict', label: 'Content age-restrict', state: contentLegState },
    { key: 'relay_suspend', label: 'Relay content suspend', state: contentLegState },
    { key: 'ticket', label: 'Age-review ticket', state: ticketLinked ? 'done' : 'missing' },
  ];

  return {
    accountType,
    suspended,
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
  if (accountType === 'unknown') {
    return 'Sign-in lever unconfirmed (account status unavailable) — retry before relying on it.';
  }
  const available: string[] = [];
  if (signinState === 'missing') available.push('suspend sign-in');
  if (contentPresence !== 'none') available.push('age-restrict/remove content');
  if (!ticketLinked) available.push('open ticket');

  const prefix = accountType === 'self_custody' ? 'Sign-in suspend N/A (self-custody). ' : '';
  if (available.length === 0) {
    return accountType === 'self_custody' && contentPresence === 'none'
      ? 'No effective enforcement available (self-custody, no relay content) — record/ticket only.'
      : `${prefix}Fully enforced — no further action needed.`;
  }
  return `${prefix}Available: ${available.join(', ')}.`;
}
