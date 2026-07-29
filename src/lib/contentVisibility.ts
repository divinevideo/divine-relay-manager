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
  // Whether that status is actually known yet. Without these, an in-flight or
  // failed status read silently becomes "not suspended", which is how "not
  // attributable to suspension" gets asserted about an account we never checked.
  accountStatusLoading?: boolean;
  accountStatusFailed?: boolean;
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
    accountStatusLoading,
    accountStatusFailed,
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
  const statusKnown =
    !accountStatusLoading && !accountStatusFailed && accountStatus?.success === true;
  if (!statusKnown) {
    return {
      state: 'unknown',
      message: 'No content found on the relay. Account status is unavailable, so suspension cannot be ruled out.',
    };
  }

  return { state: 'absent', message: 'No content found on the relay, and the account is not suspended.' };
}
