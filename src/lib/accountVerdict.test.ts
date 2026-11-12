import { describe, it, expect } from 'vitest';
import { deriveAccountVerdict } from './accountVerdict';
import type { AccountStatusResponse } from './adminApi';

const divineActive: AccountStatusResponse = { success: true, status: 'active' };
const divineSuspended: AccountStatusResponse = { success: true, status: 'suspended' };
const divineBanned: AccountStatusResponse = { success: true, status: 'banned' };
const selfCustody: AccountStatusResponse = { success: false, not_found: true };
const unavailable: AccountStatusResponse = { success: false, error: '500: boom' };

const legState = (v: ReturnType<typeof deriveAccountVerdict>, key: string) =>
  v.legs.find((l) => l.key === key)!.state;

describe('deriveAccountVerdict — account type', () => {
  it('divine when keycast lookup succeeds', () => {
    expect(deriveAccountVerdict({ accountStatus: divineActive, accountStatusError: false, contentPresenceKnown: true, postCount: 3, ticketLinked: false }).accountType).toBe('divine');
  });
  it('self_custody on keycast not_found', () => {
    expect(deriveAccountVerdict({ accountStatus: selfCustody, accountStatusError: false, contentPresenceKnown: true, postCount: 0, ticketLinked: false }).accountType).toBe('self_custody');
  });
  it('unknown on keycast error', () => {
    expect(deriveAccountVerdict({ accountStatus: unavailable, accountStatusError: false, contentPresenceKnown: true, postCount: 0, ticketLinked: false }).accountType).toBe('unknown');
  });
  it('unknown when the query itself errored', () => {
    expect(deriveAccountVerdict({ accountStatus: undefined, accountStatusError: true, contentPresenceKnown: true, postCount: 0, ticketLinked: false }).accountType).toBe('unknown');
  });
  it('keeps cached successful data authoritative after a background refetch error', () => {
    expect(deriveAccountVerdict({ accountStatus: divineActive, accountStatusError: true, contentPresenceKnown: true, postCount: 0, ticketLinked: false }).accountType).toBe('divine');
  });
});

describe('deriveAccountVerdict — legs', () => {
  it('keycast leg done when divine + suspended', () => {
    expect(legState(deriveAccountVerdict({ accountStatus: divineSuspended, accountStatusError: false, contentPresenceKnown: true, postCount: 2, ticketLinked: true }), 'keycast')).toBe('done');
  });
  it('keycast leg missing when divine + active, and offered as a Keycast suspend', () => {
    const v = deriveAccountVerdict({ accountStatus: divineActive, accountStatusError: false, contentPresenceKnown: true, postCount: 2, ticketLinked: false });
    expect(legState(v, 'keycast')).toBe('missing');
    expect(v.verdict).toContain('suspend Keycast account');
  });
  // Keycast does not block sign-in for a suspended or banned account (#417), so
  // neither the leg nor the verdict may describe the Keycast lever as sign-in.
  it.each([
    ['active', divineActive],
    ['suspended', divineSuspended],
    ['banned', divineBanned],
    ['self-custody', selfCustody],
    ['unavailable', unavailable],
  ])('never describes the Keycast lever as sign-in (%s)', (_name, accountStatus) => {
    const v = deriveAccountVerdict({ accountStatus, accountStatusError: false, contentPresenceKnown: true, postCount: 2, ticketLinked: false });
    expect(v.legs.find((l) => l.key === 'keycast')!.label).toBe('Keycast account suspend');
    expect(v.verdict).not.toMatch(/sign-in/i);
  });
  it('keycast leg not_tracked when keycast omits status', () => {
    const v = deriveAccountVerdict({ accountStatus: { success: true }, accountStatusError: false, contentPresenceKnown: true, postCount: 0, ticketLinked: true });
    expect(v.accountType).toBe('divine');
    expect(v.keycastStatus).toBe('unknown');
    expect(legState(v, 'keycast')).toBe('not_tracked');
    expect(v.verdict.toLowerCase()).not.toContain('suspend keycast account');
    expect(v.verdict.toLowerCase()).not.toContain('fully enforced');
    expect(v.verdict.toLowerCase()).toContain('keycast status unavailable');
  });
  it('keycast leg na when self-custody', () => {
    expect(legState(deriveAccountVerdict({ accountStatus: selfCustody, accountStatusError: false, contentPresenceKnown: true, postCount: 2, ticketLinked: false }), 'keycast')).toBe('na');
  });
  it('ticket done when linked, missing otherwise', () => {
    expect(legState(deriveAccountVerdict({ accountStatus: divineActive, accountStatusError: false, contentPresenceKnown: true, postCount: 2, ticketLinked: true }), 'ticket')).toBe('done');
    expect(legState(deriveAccountVerdict({ accountStatus: divineActive, accountStatusError: false, contentPresenceKnown: true, postCount: 2, ticketLinked: false }), 'ticket')).toBe('missing');
  });
  it('content legs not_tracked when content present (deps #123), na when no content', () => {
    const withContent = deriveAccountVerdict({ accountStatus: divineActive, accountStatusError: false, contentPresenceKnown: true, postCount: 5, ticketLinked: false });
    expect(legState(withContent, 'content_restrict')).toBe('not_tracked');
    const noContent = deriveAccountVerdict({ accountStatus: divineActive, accountStatusError: false, contentPresenceKnown: true, postCount: 0, ticketLinked: false });
    expect(legState(noContent, 'content_restrict')).toBe('na');
  });
});

describe('deriveAccountVerdict — content presence + verdict', () => {
  it('hidden_suspended when no visible content but suspended', () => {
    expect(deriveAccountVerdict({ accountStatus: divineSuspended, accountStatusError: false, contentPresenceKnown: true, postCount: 0, ticketLinked: false }).contentPresence).toBe('hidden_suspended');
  });
  it('verdict flags N/A for self-custody', () => {
    expect(deriveAccountVerdict({ accountStatus: selfCustody, accountStatusError: false, contentPresenceKnown: true, postCount: 0, ticketLinked: false }).verdict.toLowerCase()).toContain('n/a');
  });
  it('verdict says unavailable for unknown', () => {
    expect(deriveAccountVerdict({ accountStatus: unavailable, accountStatusError: false, contentPresenceKnown: true, postCount: 0, ticketLinked: false }).verdict.toLowerCase()).toContain('unavailable');
  });

  it('contentPresence is unknown (not none) when a non-suspended read has not resolved', () => {
    const v = deriveAccountVerdict({ accountStatus: divineActive, accountStatusError: false, contentPresenceKnown: false, postCount: undefined, ticketLinked: false });
    expect(v.contentPresence).toBe('unknown');
    // Applicable-but-unconfirmed, NOT n/a — never under-state the content lever.
    expect(legState(v, 'content_restrict')).toBe('not_tracked');
  });

  it('treats banned as Keycast-restricted (done), never offers "suspend Keycast account" (review)', () => {
    const v = deriveAccountVerdict({ accountStatus: divineBanned, accountStatusError: false, contentPresenceKnown: true, postCount: 2, ticketLinked: true });
    expect(legState(v, 'keycast')).toBe('done');
    expect(v.verdict.toLowerCase()).not.toContain('suspend keycast account');
  });

  it('keycast-unavailable still surfaces content/ticket actions, not just "retry" (review)', () => {
    const v = deriveAccountVerdict({ accountStatus: unavailable, accountStatusError: false, contentPresenceKnown: true, postCount: 5, ticketLinked: false });
    expect(v.accountType).toBe('unknown');
    expect(v.verdict.toLowerCase()).toContain('keycast lever unconfirmed'); // Keycast note preserved
    expect(v.verdict.toLowerCase()).toContain('age-restrict'); // content action still shown
    expect(v.verdict.toLowerCase()).toContain('open ticket'); // ticket action still shown
  });

  it('an unresolved read never concludes "no effective enforcement" (Finding #1 regression)', () => {
    // self-custody + relay read failed/loading + ticket already linked: previously
    // this collapsed to "no relay content — record/ticket only".
    const v = deriveAccountVerdict({ accountStatus: selfCustody, accountStatusError: false, contentPresenceKnown: false, postCount: undefined, ticketLinked: true });
    expect(v.verdict.toLowerCase()).not.toContain('no effective enforcement');
    expect(v.verdict.toLowerCase()).toContain('verify content directly');
  });
});
