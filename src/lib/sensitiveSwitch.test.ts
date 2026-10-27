// ABOUTME: Pins who sits behind the sensitive pending-review switch: auto-hidden targets,
// ABOUTME: plus unhandled CSAM-signal targets that nothing has hidden.

import { describe, expect, it } from 'vitest';
import {
  buildSwitchMembership,
  humanHandledAutoHideTargets,
  SWITCH_STATE_LABELS,
} from './sensitiveSwitch';

const EVENT = 'a'.repeat(64);
const AUTHOR = 'b'.repeat(64);
const PROFILE = 'c'.repeat(64);

const CSAM_REPORT = { tags: [['p', PROFILE, 'illegal'], ['l', 'NS-csam', 'social.nos.ontology']], content: '' };
const BARE_ILLEGAL = { tags: [['p', PROFILE, 'illegal']], content: 'bad stuff' };

const profileTarget = (reports: { tags: string[][]; content?: string }[]) => ({
  target: { type: 'pubkey' as const, value: PROFILE },
  reports,
});
const eventTarget = {
  target: { type: 'event' as const, value: EVENT },
  authorPubkey: AUTHOR,
  reports: [{ tags: [['e', EVENT, 'illegal'], ['p', AUTHOR, 'illegal']], content: 'Reason: csam' }],
};

function build(overrides: Partial<Parameters<typeof buildSwitchMembership>[0]> = {}) {
  return buildSwitchMembership({
    consolidated: [],
    pendingReview: new Map(),
    humanHandled: new Set(),
    resolvedTargets: new Set(),
    bannedPubkeys: new Set(),
    ...overrides,
  });
}

describe('buildSwitchMembership', () => {
  it('puts a profile target with a CSAM report behind the switch as not hidden', () => {
    const m = build({ consolidated: [profileTarget([CSAM_REPORT])] });
    expect([...m]).toEqual([[`pubkey:${PROFILE}`, 'not-hidden']]);
  });

  it('leaves a bare illegal target out', () => {
    const m = build({ consolidated: [profileTarget([BARE_ILLEGAL])] });
    expect(m.size).toBe(0);
  });

  it('leaves a resolved CSAM target out', () => {
    const m = build({
      consolidated: [profileTarget([CSAM_REPORT])],
      resolvedTargets: new Set([`pubkey:${PROFILE}`]),
    });
    expect(m.has(`pubkey:${PROFILE}`)).toBe(false);
  });

  it('leaves a CSAM target a person already handled through auto-hide out', () => {
    const m = build({
      consolidated: [profileTarget([CSAM_REPORT])],
      humanHandled: new Set([`pubkey:${PROFILE}`]),
    });
    expect(m.has(`pubkey:${PROFILE}`)).toBe(false);
  });

  it('leaves a CSAM event out once its author is banned', () => {
    // Control: the same target is in when the author is not banned.
    expect(build({ consolidated: [eventTarget] }).get(`event:${EVENT}`)).toBe('not-hidden');
    const m = build({ consolidated: [eventTarget], bannedPubkeys: new Set([AUTHOR]) });
    expect(m.has(`event:${EVENT}`)).toBe(false);
  });

  it('lists an auto-hidden target that also has a CSAM report once, as auto-hidden', () => {
    const m = build({
      consolidated: [profileTarget([CSAM_REPORT])],
      pendingReview: new Map([[`pubkey:${PROFILE}`, 'auto_hidden']]),
    });
    expect([...m]).toEqual([[`pubkey:${PROFILE}`, 'auto-hidden']]);
  });

  it('keeps an auto-hidden target with no loaded reports', () => {
    const m = build({ pendingReview: new Map([[`event:${EVENT}`, 'auto_hidden']]) });
    expect([...m]).toEqual([[`event:${EVENT}`, 'auto-hidden']]);
  });

  it('marks an auto-hidden target whose hide or restore is unconfirmed', () => {
    const m = build({
      pendingReview: new Map([
        [`event:${'1'.repeat(64)}`, 'auto_hidden'],
        [`event:${'2'.repeat(64)}`, 'auto_hide_unresolved'],
        [`event:${'3'.repeat(64)}`, 'auto_hide_restore_failed'],
      ]),
    });
    expect(m.get(`event:${'1'.repeat(64)}`)).toBe('auto-hidden');
    expect(m.get(`event:${'2'.repeat(64)}`)).toBe('hide-unconfirmed');
    expect(m.get(`event:${'3'.repeat(64)}`)).toBe('hide-unconfirmed');
  });
});

describe('humanHandledAutoHideTargets', () => {
  it('returns only targets with a confirmed, restored or reversed row', () => {
    const rows = [
      { target_type: 'event', target_id: '1'.repeat(64), action: 'auto_hide_confirmed' },
      { target_type: 'event', target_id: '2'.repeat(64), action: 'auto_hide_restored' },
      { target_type: 'pubkey', target_id: '3'.repeat(64), action: 'auto_hide_reversed' },
      // A later machine hide does not undo the earlier human handling.
      { target_type: 'event', target_id: '4'.repeat(64), action: 'auto_hidden' },
      { target_type: 'event', target_id: '4'.repeat(64), action: 'auto_hide_restored' },
      { target_type: 'event', target_id: '5'.repeat(64), action: 'auto_hidden' },
      { target_type: 'event', target_id: '6'.repeat(64), action: 'auto_hide_unresolved' },
      { target_type: 'event', target_id: '7'.repeat(64), action: 'auto_hide_restore_failed' },
    ];
    expect([...humanHandledAutoHideTargets(rows)].sort()).toEqual([
      `event:${'1'.repeat(64)}`,
      `event:${'2'.repeat(64)}`,
      `event:${'4'.repeat(64)}`,
      `pubkey:${'3'.repeat(64)}`,
    ]);
  });
});

describe('SWITCH_STATE_LABELS', () => {
  it('names each state without claiming an unconfirmed hide landed', () => {
    expect(SWITCH_STATE_LABELS).toEqual({
      'auto-hidden': 'Hidden automatically',
      'hide-unconfirmed': 'Hide not confirmed',
      'not-hidden': 'Not hidden, needs review',
    });
  });
});
