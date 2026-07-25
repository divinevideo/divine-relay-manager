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
  | 'loading';

export interface ContentVisibilityInput {
  // Count of the target's recent relay-visible content (undefined until the read resolves).
  postCount: number | undefined;
  contentLoading: boolean;
  contentError: boolean;
  // Keycast account status — the verified source for suspended/banned.
  accountStatus: AccountStatusResponse | undefined;
}

export interface ContentVisibilityResult {
  state: ContentVisibility;
  message: string; // '' for has_content; the "why not visible" reason otherwise
}

export function deriveContentVisibility(input: ContentVisibilityInput): ContentVisibilityResult {
  const { postCount, contentLoading, contentError, accountStatus } = input;

  if (contentLoading && postCount === undefined) {
    return { state: 'loading', message: 'Checking for content…' };
  }
  if ((postCount ?? 0) > 0) {
    return { state: 'has_content', message: '' };
  }

  // No visible content. Attribute the invisibility to a *verified* cause, in order:
  // a confirmed suspend/ban explains it definitively (content is hidden/removed
  // regardless of the read result); otherwise a failed read is surfaced as an
  // error (never claimed as "absent"); only a clean, empty read is "absent".
  if (accountStatus?.status === 'suspended') {
    return { state: 'suspended', message: 'Content hidden by suspension (reversible; visible again if cleared).' };
  }
  if (accountStatus?.status === 'banned') {
    return { state: 'banned', message: 'Content removed (account banned).' };
  }
  if (contentError) {
    return { state: 'error', message: "Couldn't load this account's content (relay error) — retry." };
  }
  return { state: 'absent', message: 'No content found on the relay — not attributable to suspension.' };
}
