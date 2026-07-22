import { describe, it, expect } from 'vitest';
import { deriveAccountVerdict } from './accountVerdict';
import type { AccountStatusResponse } from './adminApi';

const divineActive: AccountStatusResponse = { success: true, status: 'active' };
const divineSuspended: AccountStatusResponse = { success: true, status: 'suspended' };
const selfCustody: AccountStatusResponse = { success: false, not_found: true };
const unavailable: AccountStatusResponse = { success: false, error: '500: boom' };

const legState = (v: ReturnType<typeof deriveAccountVerdict>, key: string) =>
  v.legs.find((l) => l.key === key)!.state;

describe('deriveAccountVerdict — account type', () => {
  it('divine when keycast lookup succeeds', () => {
    expect(deriveAccountVerdict({ accountStatus: divineActive, accountStatusError: false, postCount: 3, ticketLinked: false }).accountType).toBe('divine');
  });
  it('self_custody on keycast not_found', () => {
    expect(deriveAccountVerdict({ accountStatus: selfCustody, accountStatusError: false, postCount: 0, ticketLinked: false }).accountType).toBe('self_custody');
  });
  it('unknown on keycast error', () => {
    expect(deriveAccountVerdict({ accountStatus: unavailable, accountStatusError: false, postCount: 0, ticketLinked: false }).accountType).toBe('unknown');
  });
  it('unknown when the query itself errored', () => {
    expect(deriveAccountVerdict({ accountStatus: undefined, accountStatusError: true, postCount: 0, ticketLinked: false }).accountType).toBe('unknown');
  });
});

describe('deriveAccountVerdict — legs', () => {
  it('sign-in done when divine + suspended', () => {
    expect(legState(deriveAccountVerdict({ accountStatus: divineSuspended, accountStatusError: false, postCount: 2, ticketLinked: true }), 'signin')).toBe('done');
  });
  it('sign-in missing when divine + active', () => {
    expect(legState(deriveAccountVerdict({ accountStatus: divineActive, accountStatusError: false, postCount: 2, ticketLinked: false }), 'signin')).toBe('missing');
  });
  it('sign-in na when self-custody', () => {
    expect(legState(deriveAccountVerdict({ accountStatus: selfCustody, accountStatusError: false, postCount: 2, ticketLinked: false }), 'signin')).toBe('na');
  });
  it('ticket done when linked, missing otherwise', () => {
    expect(legState(deriveAccountVerdict({ accountStatus: divineActive, accountStatusError: false, postCount: 2, ticketLinked: true }), 'ticket')).toBe('done');
    expect(legState(deriveAccountVerdict({ accountStatus: divineActive, accountStatusError: false, postCount: 2, ticketLinked: false }), 'ticket')).toBe('missing');
  });
  it('content legs not_tracked when content present (deps #123), na when no content', () => {
    const withContent = deriveAccountVerdict({ accountStatus: divineActive, accountStatusError: false, postCount: 5, ticketLinked: false });
    expect(legState(withContent, 'content_restrict')).toBe('not_tracked');
    const noContent = deriveAccountVerdict({ accountStatus: divineActive, accountStatusError: false, postCount: 0, ticketLinked: false });
    expect(legState(noContent, 'content_restrict')).toBe('na');
  });
});

describe('deriveAccountVerdict — content presence + verdict', () => {
  it('hidden_suspended when no visible content but suspended', () => {
    expect(deriveAccountVerdict({ accountStatus: divineSuspended, accountStatusError: false, postCount: 0, ticketLinked: false }).contentPresence).toBe('hidden_suspended');
  });
  it('verdict flags N/A for self-custody', () => {
    expect(deriveAccountVerdict({ accountStatus: selfCustody, accountStatusError: false, postCount: 0, ticketLinked: false }).verdict.toLowerCase()).toContain('n/a');
  });
  it('verdict says unavailable for unknown', () => {
    expect(deriveAccountVerdict({ accountStatus: unavailable, accountStatusError: false, postCount: 0, ticketLinked: false }).verdict.toLowerCase()).toContain('unavailable');
  });
});
