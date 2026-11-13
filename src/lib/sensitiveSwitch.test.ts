// ABOUTME: Pins who sits behind the sensitive pending-review switch: auto-hidden targets,
// ABOUTME: plus targets with an unanswered CSAM-signal report that nothing has hidden.

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
  arrivals: Map<string, number> = new Map(),
  extra: { bannedEvents?: Set<string>; confirmedAutoHide?: Map<string, number | null> } = {},
): QueueResolution {
  return queueResolution({
    dated: datedHandling(rows.map(r => ({ moderator_pubkey: 'd'.repeat(64), ...r })), labels),
    arrivals,
    bannedPubkeys: new Set(),
    bannedEvents: extra.bannedEvents ?? new Set(),
    resolvedTargets: new Set(),
    confirmedAutoHide: extra.confirmedAutoHide,
  });
}

function build(overrides: Partial<Parameters<typeof buildSwitchMembership>[0]> = {}) {
  return buildSwitchMembership({
    consolidated: [],
    pendingReview: new Map(),
    humanHandled: new Map(),
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

  // A worker from before #324 sends no dates, so any human auto-hide row
  // answers every report, as the switch always read it.
  it('leaves a CSAM target a person already handled through auto-hide out', () => {
    const m = build({
      consolidated: [profileTarget([CSAM_REPORT])],
      humanHandled: new Map([[`pubkey:${PROFILE}`, 100]]),
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

    // A person restoring an auto-hide answers the reports that arrived before
    // it, not the ones that came after. A restore leaves the target unbanned,
    // as these fixtures are; the confirmed, still-banned post is below.
    it('keeps a CSAM report that came after a person restored its auto-hide behind the switch', () => {
      const m = build({
        consolidated: [profileTarget([CSAM_REPORT])],
        humanHandled: new Map([[`pubkey:${PROFILE}`, 100]]),
        resolution: dated([]),
      });
      expect(m.get(`pubkey:${PROFILE}`)).toBe('not-hidden');
    });

    it('leaves a CSAM report out when a person restored its auto-hide after it', () => {
      const m = build({
        consolidated: [profileTarget([CSAM_REPORT])],
        humanHandled: new Map([[`pubkey:${PROFILE}`, 200]]),
        resolution: dated([]),
      });
      expect(m.has(`pubkey:${PROFILE}`)).toBe(false);
    });

    it('keeps a CSAM report in the same second as the auto-hide restore behind the switch', () => {
      const m = build({
        consolidated: [profileTarget([CSAM_REPORT])],
        humanHandled: new Map([[`pubkey:${PROFILE}`, CSAM_REPORT.created_at]]),
        resolution: dated([]),
      });
      expect(m.get(`pubkey:${PROFILE}`)).toBe('not-hidden');
    });

    it('dates a report by its arrival, not its created_at, against the auto-hide restore', () => {
      const m = build({
        consolidated: [profileTarget([{ ...CSAM_REPORT, created_at: 50 }])],
        humanHandled: new Map([[`pubkey:${PROFILE}`, 100]]),
        resolution: dated([], [], new Map([[CSAM_REPORT.id, 150]])),
      });
      expect(m.get(`pubkey:${PROFILE}`)).toBe('not-hidden');
    });

    it('leaves a CSAM target out when its only human auto-hide row is undated', () => {
      const m = build({
        consolidated: [profileTarget([CSAM_REPORT])],
        humanHandled: new Map([[`pubkey:${PROFILE}`, null]]),
        resolution: dated([]),
      });
      expect(m.has(`pubkey:${PROFILE}`)).toBe(false);
    });

    // Each report needs an answer from one or the other: the auto-hide
    // confirmation answers the earlier report, the decision the later one.
    it('leaves a CSAM target out when the auto-hide answers one report and a decision the other', () => {
      const early = { ...CSAM_REPORT, id: '4'.repeat(64), created_at: 50 };
      const late = { ...CSAM_REPORT, id: '5'.repeat(64), created_at: 150 };
      const answered = build({
        consolidated: [profileTarget([early, late])],
        humanHandled: new Map([[`pubkey:${PROFILE}`, 100]]),
        resolution: dated([{ target_type: 'pubkey', target_id: PROFILE, action: 'reviewed', at: 200 }]),
      });
      expect(answered.has(`pubkey:${PROFILE}`)).toBe(false);
      // Control: without the decision, the later report is unanswered.
      const open = build({
        consolidated: [profileTarget([early, late])],
        humanHandled: new Map([[`pubkey:${PROFILE}`, 100]]),
        resolution: dated([]),
      });
      expect(open.get(`pubkey:${PROFILE}`)).toBe('not-hidden');
    });

    // What production produces: auto-hide bans the post, and Confirm hide
    // leaves the ban with only an auto_hide_confirmed row. The confirm dates
    // the ban, so it answers the reports before it and not later ones.
    describe('a post whose auto-hide a person confirmed, still banned on the relay', () => {
      const postTarget = (created_at: number) => ({
        target: { type: 'event' as const, value: EVENT },
        authorPubkey: AUTHOR,
        reports: [{ ...eventTarget.reports[0], created_at }],
      });
      const confirmedAt = (at: number) => ({
        humanHandled: new Map([[`event:${EVENT}`, at]]),
        resolution: dated([], [], new Map(), {
          bannedEvents: new Set([EVENT]),
          confirmedAutoHide: new Map([[`event:${EVENT}`, at]]),
        }),
      });

      it('keeps a CSAM report that came after the confirm behind the switch', () => {
        const m = build({ consolidated: [postTarget(150)], ...confirmedAt(100) });
        expect(m.get(`event:${EVENT}`)).toBe('not-hidden');
      });

      it('leaves a CSAM report from before the confirm out', () => {
        const m = build({ consolidated: [postTarget(50)], ...confirmedAt(100) });
        expect(m.has(`event:${EVENT}`)).toBe(false);
      });
    });

    // Only an unanswered report's CSAM signal keeps a target here. A person
    // answered the CSAM report; the report that came after carries no signal,
    // so the target goes where the queue puts it (the handled-before section,
    // when a decision answered it). The answer must not depend on whether the
    // feed sent the answered report: it drops it, and a deep link's full read
    // brings it back.
    describe('a CSAM report a person answered, then a report with no signal', () => {
      const answeredCsam = { ...CSAM_REPORT, id: '6'.repeat(64), created_at: 50 };
      const spam: Report = { id: '7'.repeat(64), created_at: 150, tags: [['p', PROFILE, 'spam']], content: '' };

      it('leaves the target out when a decision answered the CSAM report', () => {
        const m = build({
          consolidated: [profileTarget([answeredCsam, spam])],
          resolution: dated([{ target_type: 'pubkey', target_id: PROFILE, action: 'reviewed', at: 100 }]),
        });
        expect(m.has(`pubkey:${PROFILE}`)).toBe(false);
      });

      it('leaves the target out when an auto-hide choice answered the CSAM report', () => {
        const m = build({
          consolidated: [profileTarget([answeredCsam, spam])],
          humanHandled: new Map([[`pubkey:${PROFILE}`, 100]]),
          resolution: dated([]),
        });
        expect(m.has(`pubkey:${PROFILE}`)).toBe(false);
      });

      // The signal must sit in an unanswered report: an answered report with
      // no signal beside an unanswered CSAM report keeps the target here.
      it('keeps the target when the answered report has no signal and the CSAM report came after', () => {
        const answeredSpam = { ...spam, created_at: 50 };
        const laterCsam = { ...answeredCsam, created_at: 150 };
        const m = build({
          consolidated: [profileTarget([answeredSpam, laterCsam])],
          resolution: dated([{ target_type: 'pubkey', target_id: PROFILE, action: 'reviewed', at: 100 }]),
        });
        expect(m.get(`pubkey:${PROFILE}`)).toBe('not-hidden');
      });

      // Control: the same spam report beside a CSAM report no one answered.
      it('keeps the target when the CSAM report is unanswered too', () => {
        const m = build({
          consolidated: [profileTarget([answeredCsam, spam])],
          resolution: dated([{ target_type: 'pubkey', target_id: PROFILE, action: 'reviewed', at: 40 }]),
        });
        expect(m.get(`pubkey:${PROFILE}`)).toBe('not-hidden');
      });
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
      { target_type: 'event', target_id: '1'.repeat(64), action: 'auto_hide_confirmed', at: 100 },
      { target_type: 'event', target_id: '2'.repeat(64), action: 'auto_hide_restored', at: 100 },
      { target_type: 'pubkey', target_id: '3'.repeat(64), action: 'auto_hide_reversed', at: 100 },
      // A later machine hide does not undo the earlier human handling.
      { target_type: 'event', target_id: '4'.repeat(64), action: 'auto_hidden', at: 200 },
      { target_type: 'event', target_id: '4'.repeat(64), action: 'auto_hide_restored', at: 100 },
      { target_type: 'event', target_id: '5'.repeat(64), action: 'auto_hidden', at: 100 },
      { target_type: 'event', target_id: '6'.repeat(64), action: 'auto_hide_unresolved', at: 100 },
      { target_type: 'event', target_id: '7'.repeat(64), action: 'auto_hide_restore_failed', at: 100 },
    ];
    expect([...humanHandledAutoHideTargets(rows).keys()].sort()).toEqual([
      `event:${'1'.repeat(64)}`,
      `event:${'2'.repeat(64)}`,
      `event:${'4'.repeat(64)}`,
      `pubkey:${'3'.repeat(64)}`,
    ]);
  });

  it('keys a human row as stored, as every stored decision is keyed', () => {
    const id = 'ab'.repeat(32);
    const rows = [{ target_type: 'event', target_id: id.toUpperCase(), action: 'auto_hide_confirmed', at: 100 }];
    expect([...humanHandledAutoHideTargets(rows).keys()]).toEqual([`event:${id.toUpperCase()}`]);
  });

  it("dates a target by its latest human auto-hide row, whatever the rows' order", () => {
    const key = `event:${EVENT}`;
    const rows = [
      { target_type: 'event', target_id: EVENT, action: 'auto_hide_restored', at: 200 },
      { target_type: 'event', target_id: EVENT, action: 'auto_hide_confirmed', at: 300 },
    ];
    expect(humanHandledAutoHideTargets(rows).get(key)).toBe(300);
    expect(humanHandledAutoHideTargets([...rows].reverse()).get(key)).toBe(300);
  });

  // An undated row predates every dated one, as in handlingByTarget.
  it('dates a target null only when every human row is undated', () => {
    const key = `event:${EVENT}`;
    const undated = { target_type: 'event', target_id: EVENT, action: 'auto_hide_confirmed', at: null };
    expect(humanHandledAutoHideTargets([undated]).get(key)).toBeNull();
    expect(humanHandledAutoHideTargets([
      undated,
      { target_type: 'event', target_id: EVENT, action: 'auto_hide_restored', at: 100 },
    ]).get(key)).toBe(100);
  });

  // A worker from before #324 sends rows with no `at`: the target is still
  // handled, with no date, as the switch always read it.
  it('dates a target null when its rows carry no date at all', () => {
    const rows = [{ target_type: 'event', target_id: EVENT, action: 'auto_hide_confirmed' }];
    const handled = humanHandledAutoHideTargets(rows);
    expect(handled.has(`event:${EVENT}`)).toBe(true);
    expect(handled.get(`event:${EVENT}`)).toBeNull();
  });

  it('skips a row with a malformed date rather than reading it as undated', () => {
    const rows = [{ target_type: 'event', target_id: EVENT, action: 'auto_hide_confirmed', at: 'soon' as unknown as number }];
    expect(humanHandledAutoHideTargets(rows).has(`event:${EVENT}`)).toBe(false);
  });

  describe('with the decision log a reopen is read from (#324)', () => {
    const key = `event:${EVENT}`;
    const reopen = (at: number | null) => [{ target_type: 'event', target_id: EVENT, action: 'reopened', at }];

    it('drops a human auto-hide row a later reopen cancelled', () => {
      const rows = [{ target_type: 'event', target_id: EVENT, action: 'auto_hide_confirmed', at: 200 }];
      expect(humanHandledAutoHideTargets(rows, reopen(250)).has(key)).toBe(false);
      // The same second as the reopen does not survive it either.
      expect(humanHandledAutoHideTargets(rows, reopen(200)).has(key)).toBe(false);
    });

    it('keeps a human auto-hide row that came after the reopen', () => {
      const rows = [
        { target_type: 'event', target_id: EVENT, action: 'auto_hide_confirmed', at: 300 },
        { target_type: 'event', target_id: EVENT, action: 'auto_hide_confirmed', at: 100 },
      ];
      expect(humanHandledAutoHideTargets(rows, reopen(250)).get(key)).toBe(300);
    });

    it('drops an undated human auto-hide row once the target was reopened', () => {
      const rows = [{ target_type: 'event', target_id: EVENT, action: 'auto_hide_confirmed', at: null }];
      expect(humanHandledAutoHideTargets(rows, reopen(250)).has(key)).toBe(false);
      expect(humanHandledAutoHideTargets(rows, reopen(null)).has(key)).toBe(false);
    });

    it("leaves another target's rows alone", () => {
      const other = 'e'.repeat(64);
      const rows = [{ target_type: 'event', target_id: other, action: 'auto_hide_confirmed', at: 200 }];
      expect(humanHandledAutoHideTargets(rows, reopen(250)).get(`event:${other}`)).toBe(200);
    });
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
