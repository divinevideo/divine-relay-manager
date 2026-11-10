// ABOUTME: Pins who sits behind the sensitive pending-review switch: auto-hidden targets,
// ABOUTME: plus unhandled CSAM-signal targets that nothing has hidden.

import { describe, expect, it } from 'vitest';
import {
  buildSwitchMembership,
  humanHandledAutoHideTargets,
  SWITCH_STATE_LABELS,
} from './sensitiveSwitch';
import { datedHandling, queueResolution, type QueueResolution } from './reportResolution';

const EVENT = 'a'.repeat(64);
const AUTHOR = 'b'.repeat(64);
const PROFILE = 'c'.repeat(64);

type Report = { id: string; created_at: number; tags: string[][]; content?: string };

const CSAM_REPORT: Report = {
  id: '1'.repeat(64),
  created_at: 150,
  tags: [['p', PROFILE, 'illegal'], ['l', 'NS-csam', 'social.nos.ontology']],
  content: '',
};
const BARE_ILLEGAL: Report = { id: '2'.repeat(64), created_at: 150, tags: [['p', PROFILE, 'illegal']], content: 'bad stuff' };

const profileTarget = (reports: Report[]) => ({
  target: { type: 'pubkey' as const, value: PROFILE },
  reports,
});
const eventTarget = {
  target: { type: 'event' as const, value: EVENT },
  authorPubkey: AUTHOR,
  reports: [{ id: '3'.repeat(64), created_at: 150, tags: [['e', EVENT, 'illegal'], ['p', AUTHOR, 'illegal']], content: 'Reason: csam' }],
};

// A worker from before #324: target membership, as the switch always read it.
function membership(handledTargets: string[] = [], bannedPubkeys: string[] = []): QueueResolution {
  return { rule: 'membership', resolvedTargets: new Set(handledTargets), bannedPubkeys: new Set(bannedPubkeys) };
}

// A worker with the handled-before rule: dated decision rows and labels.
function dated(
  rows: { target_type: string; target_id: string; action: string; at: number | null; moderator_pubkey?: string }[],
  labels: { type: 'event' | 'pubkey'; value: string; at: number }[] = [],
): QueueResolution {
  return queueResolution({
    dated: datedHandling(rows.map(r => ({ moderator_pubkey: 'd'.repeat(64), ...r })), labels),
    arrivals: new Map(),
    bannedPubkeys: new Set(),
    bannedEvents: new Set(),
    resolvedTargets: new Set(),
  });
}

function build(overrides: Partial<Parameters<typeof buildSwitchMembership>[0]> = {}) {
  return buildSwitchMembership({
    consolidated: [],
    pendingReview: new Map(),
    humanHandled: new Set(),
    resolution: membership(),
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
      resolution: membership([`pubkey:${PROFILE}`]),
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
    const m = build({ consolidated: [eventTarget], resolution: membership([], [AUTHOR]) });
    expect(m.has(`event:${EVENT}`)).toBe(false);
  });

  describe('by the handled-before rule (#324)', () => {
    it('keeps a CSAM report that came after its target was handled behind the switch', () => {
      const m = build({
        consolidated: [profileTarget([CSAM_REPORT])],
        resolution: dated([{ target_type: 'pubkey', target_id: PROFILE, action: 'reviewed', at: 100 }]),
      });
      expect(m.get(`pubkey:${PROFILE}`)).toBe('not-hidden');
    });

    it('leaves a CSAM report out once a person handled its target after it', () => {
      const m = build({
        consolidated: [profileTarget([CSAM_REPORT])],
        resolution: dated([{ target_type: 'pubkey', target_id: PROFILE, action: 'reviewed', at: 200 }]),
      });
      expect(m.has(`pubkey:${PROFILE}`)).toBe(false);
    });

    // The label still names the target, but the reopen after it cancelled it:
    // the report is unanswered and stays out of the default view.
    it('keeps a CSAM target behind the switch when a reopen cancelled its label', () => {
      const m = build({
        consolidated: [profileTarget([{ ...CSAM_REPORT, created_at: 50 }])],
        resolution: dated(
          [{ target_type: 'pubkey', target_id: PROFILE, action: 'reopened', at: 120 }],
          [{ type: 'pubkey', value: PROFILE, at: 100 }],
        ),
      });
      expect(m.get(`pubkey:${PROFILE}`)).toBe('not-hidden');
    });

    it('keeps a CSAM target behind the switch when only the worker decided on it', () => {
      const m = build({
        consolidated: [profileTarget([CSAM_REPORT])],
        resolution: dated([{ target_type: 'pubkey', target_id: PROFILE, action: 'age_review_case_created', at: 100, moderator_pubkey: 'auto' }]),
      });
      expect(m.get(`pubkey:${PROFILE}`)).toBe('not-hidden');
    });
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

  it('marks an auto-hidden target that needs a check after an unresolved or failed restore', () => {
    const m = build({
      pendingReview: new Map([
        [`event:${'1'.repeat(64)}`, 'auto_hidden'],
        [`event:${'2'.repeat(64)}`, 'auto_hide_unresolved'],
        [`event:${'3'.repeat(64)}`, 'auto_hide_restore_failed'],
      ]),
    });
    expect(m.get(`event:${'1'.repeat(64)}`)).toBe('auto-hidden');
    expect(m.get(`event:${'2'.repeat(64)}`)).toBe('hidden-needs-check');
    expect(m.get(`event:${'3'.repeat(64)}`)).toBe('hidden-needs-check');
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

  it('keys a human row as stored, as every stored decision is keyed', () => {
    const id = 'ab'.repeat(32);
    const rows = [{ target_type: 'event', target_id: id.toUpperCase(), action: 'auto_hide_confirmed' }];
    expect([...humanHandledAutoHideTargets(rows)]).toEqual([`event:${id.toUpperCase()}`]);
  });
});

describe('SWITCH_STATE_LABELS', () => {
  it('calls a hide that needs a check hidden, since its ban landed', () => {
    expect(SWITCH_STATE_LABELS).toEqual({
      'auto-hidden': 'Hidden automatically',
      'hidden-needs-check': 'Hidden, needs a check',
      'not-hidden': 'Not hidden, needs review',
    });
  });
});
