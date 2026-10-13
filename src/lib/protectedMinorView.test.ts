import { describe, it, expect } from 'vitest';
import { deriveProtectedMinorView } from './protectedMinorView';
import type { AccountStatusResponse } from './adminApi';

const view = (accountStatus: AccountStatusResponse | undefined, accountType: 'divine' | 'self_custody' | 'unknown') =>
  deriveProtectedMinorView({ accountStatus, accountType });

describe('deriveProtectedMinorView: protected', () => {
  it('is protected when keycast flags the account', () => {
    const v = view({ success: true, verified_minor: true, protected_minor: false }, 'divine');
    expect(v.protected).toBe(true);
    expect(v.note).toBeNull();
  });

  it('adds no note when keycast and the registry agree, the normal approved Divine login account', () => {
    const v = view({ success: true, verified_minor: true, protected_minor: true }, 'divine');
    expect(v.protected).toBe(true);
    expect(v.note).toBeNull();
  });

  it('is protected from the registry alone for an account that holds its own key', () => {
    const v = view({ success: false, not_found: true, protected_minor: true }, 'self_custody');
    expect(v.protected).toBe(true);
    expect(v.note).toBe('holds own key: only report auto-clear applies');
  });

  it('notes a Divine login account whose keycast flag is not set yet', () => {
    const v = view({ success: true, verified_minor: false, protected_minor: true }, 'divine');
    expect(v.protected).toBe(true);
    expect(v.note).toBe('app protections not active: keycast flag not set');
  });

  it('notes unknown app protections when keycast is unavailable but the registry is protected', () => {
    const v = view({ success: false, error: '500', protected_minor: true }, 'unknown');
    expect(v.protected).toBe(true);
    expect(v.statusUnavailable).toBe(false);
    expect(v.note).toBe('app protections unknown: keycast unavailable');
  });

  it('is not protected when neither source says so', () => {
    const v = view({ success: true, verified_minor: false, protected_minor: false }, 'divine');
    expect(v.protected).toBe(false);
    expect(v.statusUnavailable).toBe(false);
  });
});

describe('deriveProtectedMinorView: status unavailable', () => {
  it('is unavailable when keycast is unknown and the registry does not say protected', () => {
    expect(view({ success: false, error: '500', protected_minor: false }, 'unknown').statusUnavailable).toBe(true);
  });

  it('is unavailable for a self-custody account when the registry read failed', () => {
    expect(view({ success: false, not_found: true, protected_minor: null }, 'self_custody').statusUnavailable).toBe(true);
  });

  it('is available for a self-custody account the registry says is not protected', () => {
    expect(view({ success: false, not_found: true, protected_minor: false }, 'self_custody').statusUnavailable).toBe(false);
  });
});

describe('deriveProtectedMinorView: approve confirm copy', () => {
  it('promises app protections for a Divine login account', () => {
    expect(view({ success: true }, 'divine').approveSummary).toBe(
      'This account is restored and marked as an approved 13-15 minor. Minor DM limits and the adult content lock apply, key export is blocked, and future under-16 reports clear automatically.',
    );
  });

  it('says only auto-clear applies for an account that holds its own key', () => {
    expect(view({ success: false, not_found: true }, 'self_custody').approveSummary).toBe(
      "This account holds its own key, so Divine can't apply minor DM limits, the adult content lock or a key-export block. Approving restores it and makes future under-16 reports clear automatically.",
    );
  });

  it('qualifies app protections when the account type is unknown', () => {
    expect(view(undefined, 'unknown').approveSummary).toBe(
      'This account is restored and marked as an approved 13-15 minor, and future under-16 reports clear automatically. For Divine login accounts, minor DM limits and the adult content lock also apply and key export is blocked.',
    );
  });
});
