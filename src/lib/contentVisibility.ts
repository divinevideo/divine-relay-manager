// ABOUTME: Pure derivation of why an age-review target's content is or isn't
// ABOUTME: visible, attributing invisibility only to a verified cause (never a
// ABOUTME: guess, never masking an error as absent). No I/O.
import type { AccountStatusResponse } from './adminApi';

export type ContentVisibility =
  | 'has_content'
  | 'suspended'
  | 'banned'
  | 'absent'
  | 'error'
  | 'unknown'
  | 'loading';

export interface ContentVisibilityInput {
  // Count of the target's recent relay-visible content (undefined until the read resolves).
  postCount: number | undefined;
  contentLoading: boolean;
  contentError: boolean;
  // The relay read resolved but was cut short, so postCount understates and a
  // zero count proves nothing (NPool.query returns partial results on failure).
  contentIncomplete?: boolean;
  // Keycast account status — the verified source for suspended/banned.
  accountStatus: AccountStatusResponse | undefined;
}

export interface ContentVisibilityResult {
  state: ContentVisibility;
  message: string; // '' for has_content; the "why not visible" reason otherwise
}

export function deriveContentVisibility(input: ContentVisibilityInput): ContentVisibilityResult {
  const {
    postCount,
    contentLoading,
    contentError,
    contentIncomplete,
    accountStatus,
  } = input;

  if (contentLoading && postCount === undefined) {
    return { state: 'loading', message: 'Checking for content…' };
  }
  if ((postCount ?? 0) > 0) {
    return { state: 'has_content', message: '' };
  }

  // No visible content. Attribute the invisibility to a *verified* cause, in order:
  // a confirmed suspend/ban explains it definitively (content is hidden/removed
  // regardless of the read result); otherwise a failed read is surfaced as an
  // error (never claimed as "absent"); only a clean, complete, empty read against
  // a known-unsuspended account is "absent".
  // Data-first, matching deriveAccountVerdict, which renders directly above this
  // and states the same enforcement. A cached success that a later refetch failed
  // to renew is still the last thing keycast actually told us, and having one
  // panel assert a suspension while the card beneath it says the status is
  // unavailable is worse than either answer alone. The two must agree, so this
  // follows the policy already shipped rather than inventing a second one.
  if (accountStatus?.status === 'suspended') {
    return { state: 'suspended', message: 'Content hidden by suspension (reversible; visible again if cleared).' };
  }
  if (accountStatus?.status === 'banned') {
    return { state: 'banned', message: 'Content removed (account banned).' };
  }
  if (contentError || contentIncomplete) {
    return { state: 'error', message: "Couldn't load this account's content (relay error). Retry." };
  }

  // The read was clean and empty, but "absent" is only honest if we also know the
  // account is not suspended. If that status is unknown, say so rather than
  // ruling out a cause we never checked.
  //
  // `not_found` is a definitive answer, not a failure: keycast has no such
  // account, so it is self-custody and no keycast suspension can be hiding
  // anything. The rest of this screen already treats it that way, and calling it
  // "unavailable" here would contradict the account-type indicator beside it.
  // Data-first here too: a definitive answer stays definitive even if a later
  // refetch failed. A read that has never succeeded leaves accountStatus
  // undefined, which falls through to unknown without needing a separate flag.
  const statusKnown =
    accountStatus?.success === true || accountStatus?.not_found === true;
  if (!statusKnown) {
    return {
      state: 'unknown',
      message: 'No content found on the relay. Account status is unavailable, so suspension cannot be ruled out.',
    };
  }

  if (accountStatus?.not_found === true) {
    return {
      state: 'absent',
      message: 'No content found on the relay. This is a self-custody account, so it cannot be suspended in keycast.',
    };
  }

  return { state: 'absent', message: 'No content found on the relay, and the account is not suspended.' };
}
