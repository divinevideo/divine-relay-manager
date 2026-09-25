// ABOUTME: Typed stand-in for useModerationStatus's return value in component tests.
// ABOUTME: A field added to the hook fails the type check here, not silently in each mock.

import { vi } from 'vitest';
import type { ModerationStatus } from '@/hooks/useModerationStatus';

/**
 * A settled status with nothing to show: the account is confirmed neither
 * banned nor suspended, the post is neither banned nor gone, nothing is
 * loading or stale, and no check has run. Pass only the fields a test is
 * about.
 */
export function moderationStatusMock(overrides: Partial<ModerationStatus> = {}): ModerationStatus {
  return {
    isUserBanned: false,
    isUserSuspended: false,
    isUserBannedStale: false,
    isUserSuspendedStale: false,
    isEventBanned: false,
    isEventGone: false,
    isLoading: false,
    isAccountStatusLoading: false,
    isUserBanChecking: false,
    isChecking: false,
    checkedAt: null,
    recheck: vi.fn(),
    recheckAfterAction: vi.fn(),
    ...overrides,
  };
}
