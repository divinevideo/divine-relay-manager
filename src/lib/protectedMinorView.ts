// ABOUTME: What the age-review view says about an account's protected-minor state,
// ABOUTME: combining keycast's verified_minor with the D1 registry (#192).
import type { AccountStatusResponse } from './adminApi';
import type { AccountType } from './accountVerdict';

export interface ProtectedMinorView {
  /** Either source says the account is an approved protected minor. */
  protected: boolean;
  /** Qualifier beside the badge when keycast's app protections are not in force. */
  note: string | null;
  /** Neither source can answer, so the view must not read as "not a minor". */
  statusUnavailable: boolean;
  /** Approve-confirm copy that claims only the protections this account gets. */
  approveSummary: string;
}

// The app's minor protections (DM limits, adult content lock) and the key-export
// block all key on keycast's verified_minor, so they reach only Divine login
// accounts. An account holding its own key gets the registry's report auto-clear.
const APPROVE_SUMMARY: Record<AccountType, string> = {
  divine: 'This account is restored and marked as an approved 13-15 minor. Minor DM limits and the adult content lock apply, key export is blocked, and future under-16 reports clear automatically.',
  self_custody: "This account holds its own key, so Divine can't apply minor DM limits, the adult content lock or a key-export block. Approving restores it and makes future under-16 reports clear automatically.",
  unknown: 'This account is restored and marked as an approved 13-15 minor, and future under-16 reports clear automatically. For Divine login accounts, minor DM limits and the adult content lock also apply and key export is blocked.',
};

export function deriveProtectedMinorView(input: {
  accountStatus: AccountStatusResponse | undefined;
  accountType: AccountType;
}): ProtectedMinorView {
  const { accountStatus, accountType } = input;
  const keycastFlagged = accountStatus?.verified_minor === true;
  const registryProtected = accountStatus?.protected_minor === true;
  const isProtected = keycastFlagged || registryProtected;

  let note: string | null = null;
  if (!keycastFlagged && registryProtected) {
    note = accountType === 'self_custody' ? 'holds own key: only report auto-clear applies'
      : accountType === 'divine' ? 'app protections not active: keycast flag not set'
      : 'app protections unknown: keycast unavailable';
  }

  // A self-custody account's protection lives only in the registry, so an
  // unreadable registry leaves it unknown, exactly like a keycast outage does.
  const statusUnavailable = !isProtected && (
    accountType === 'unknown'
    || (accountType === 'self_custody' && accountStatus?.protected_minor == null)
  );

  return { protected: isProtected, note, statusUnavailable, approveSummary: APPROVE_SUMMARY[accountType] };
}
