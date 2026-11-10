import { describe, it, expect } from 'vitest';
import {
  consolidatedStatus,
  datedHandling,
  groupResolutionStatus,
  isConsolidatedReportResolved,
  queueResolution,
  reportHandlingStatus,
  reportResolutionStatus,
  type HandlingContext,
} from './reportResolution';
import { REOPENED_ACTION, type HandlingEntry, type HandlingRow } from '../../shared/handling';

const AUTHOR = 'a'.repeat(64);
const EVENT = 'e'.repeat(64);
const banned = new Set([AUTHOR]);

describe('isConsolidatedReportResolved', () => {
  it('resolves an event report when its author is in the banned set', () => {
    const report = { target: { type: 'event' as const, value: EVENT }, authorPubkey: AUTHOR };
    expect(isConsolidatedReportResolved(report, new Set(), banned)).toBe(true);
  });

  it('cross-resolves case-insensitively when the p-tag author is uppercase', () => {
    const report = { target: { type: 'event' as const, value: EVENT }, authorPubkey: AUTHOR.toUpperCase() };
    expect(isConsolidatedReportResolved(report, new Set(), banned)).toBe(true);
  });

  it('does not resolve an event report whose author is not banned', () => {
    const report = { target: { type: 'event' as const, value: EVENT }, authorPubkey: 'c'.repeat(64) };
    expect(isConsolidatedReportResolved(report, new Set(), banned)).toBe(false);
  });

  it('does not cross-resolve when the event report has no known author', () => {
    const report = { target: { type: 'event' as const, value: EVENT }, authorPubkey: undefined };
    expect(isConsolidatedReportResolved(report, new Set(), banned)).toBe(false);
  });

  it('still resolves via an exact target-key match', () => {
    const report = { target: { type: 'event' as const, value: EVENT }, authorPubkey: undefined };
    expect(isConsolidatedReportResolved(report, new Set([`event:${EVENT}`]), new Set())).toBe(true);
  });

  it('does not cross-resolve a pubkey-target report by ban (that is the exact-key path)', () => {
    const report = { target: { type: 'pubkey' as const, value: AUTHOR }, authorPubkey: AUTHOR };
    // Cross-resolution is event-only; a pubkey target resolves solely via
    // resolvedTargets (which the caller populates from bans/decisions/labels).
    expect(isConsolidatedReportResolved(report, new Set(), banned)).toBe(false);
    expect(isConsolidatedReportResolved(report, new Set([`pubkey:${AUTHOR}`]), new Set())).toBe(true);
  });
});

// The dated rule (#324): a report counts as handled only when a person handled
// its target after it arrived. Times are unix seconds.
const PROFILE = 'b'.repeat(64);
const REPORT_ID = 'f'.repeat(64);
const MODERATOR = 'c'.repeat(64);

function entry(handledAt: number | null): HandlingEntry {
  return { handledAt, history: [{ action: 'ban_user', at: handledAt }] };
}

function ctxWith(overrides: Partial<HandlingContext> = {}): HandlingContext {
  return {
    handling: new Map(),
    arrivals: new Map(),
    bannedPubkeys: new Set(),
    bannedEvents: new Set(),
    logged: new Set(),
    ...overrides,
  };
}

const eventReport = (created_at: number, authorPubkey?: string) => ({
  id: REPORT_ID,
  created_at,
  target: { type: 'event' as const, value: EVENT },
  authorPubkey,
});
const profileReport = (created_at: number) => ({
  id: REPORT_ID,
  created_at,
  target: { type: 'pubkey' as const, value: PROFILE },
});

describe('reportHandlingStatus', () => {
  it('is new when nothing handled the target', () => {
    expect(reportHandlingStatus(profileReport(150), ctxWith())).toBe('new');
  });

  it('compares the report with its target handling, strictly before', () => {
    const ctx = ctxWith({ handling: new Map([[`pubkey:${PROFILE}`, entry(100)]]) });
    expect(reportHandlingStatus(profileReport(50), ctx)).toBe('handled');
    expect(reportHandlingStatus(profileReport(150), ctx)).toBe('handled_before');
    // Same second: shown, not presumed covered.
    expect(reportHandlingStatus(profileReport(100), ctx)).toBe('handled_before');
  });

  it('keeps an undated handling handled for good', () => {
    const ctx = ctxWith({ handling: new Map([[`pubkey:${PROFILE}`, entry(null)]]) });
    expect(reportHandlingStatus(profileReport(10_000), ctx)).toBe('handled');
  });

  it('compares by arrival time when the watcher saw the report arrive', () => {
    const ctx = ctxWith({
      handling: new Map([[`pubkey:${PROFILE}`, entry(100)]]),
      arrivals: new Map([[REPORT_ID, 150]]),
    });
    // Backdated to 50, but it arrived at 150, after the handling.
    expect(reportHandlingStatus(profileReport(50), ctx)).toBe('handled_before');
  });

  it('counts a relay-banned account with no dated handling as handled', () => {
    const ctx = ctxWith({ bannedPubkeys: new Set([PROFILE]) });
    expect(reportHandlingStatus(profileReport(10_000), ctx)).toBe('handled');
  });

  it('counts a relay-banned post with no dated handling as handled', () => {
    const ctx = ctxWith({ bannedEvents: new Set([EVENT]) });
    expect(reportHandlingStatus(eventReport(10_000), ctx)).toBe('handled');
  });

  it('compares a relay-banned target with its dated handling when it has one', () => {
    const ctx = ctxWith({
      bannedPubkeys: new Set([PROFILE]),
      handling: new Map([[`pubkey:${PROFILE}`, entry(100)]]),
    });
    expect(reportHandlingStatus(profileReport(150), ctx)).toBe('handled_before');
    expect(reportHandlingStatus(profileReport(50), ctx)).toBe('handled');
  });

  it('matches a relay ban only as the relay lists it', () => {
    const ctx = ctxWith({ bannedPubkeys: new Set([PROFILE.toUpperCase()]) });
    expect(reportHandlingStatus(profileReport(150), ctx)).toBe('new');
  });

  describe('a post whose author is relay-banned (spec decision 3)', () => {
    it("compares with the author's dated ban", () => {
      const ctx = ctxWith({
        bannedPubkeys: new Set([AUTHOR]),
        handling: new Map([[`pubkey:${AUTHOR}`, entry(100)]]),
      });
      expect(reportHandlingStatus(eventReport(150, AUTHOR), ctx)).toBe('handled_before');
      expect(reportHandlingStatus(eventReport(50, AUTHOR), ctx)).toBe('handled');
    });

    it('is handled when the ban has no date', () => {
      const ctx = ctxWith({ bannedPubkeys: new Set([AUTHOR]) });
      expect(reportHandlingStatus(eventReport(150, AUTHOR), ctx)).toBe('handled');
    });

    it('lowercases the author the report names', () => {
      const ctx = ctxWith({
        bannedPubkeys: new Set([AUTHOR]),
        handling: new Map([[`pubkey:${AUTHOR}`, entry(100)]]),
      });
      expect(reportHandlingStatus(eventReport(150, AUTHOR.toUpperCase()), ctx)).toBe('handled_before');
      expect(reportHandlingStatus(eventReport(50, AUTHOR.toUpperCase()), ctx)).toBe('handled');
    });

    it("is handled when the author's ban came after the report, though the post's own handling did not", () => {
      const ctx = ctxWith({
        bannedPubkeys: new Set([AUTHOR]),
        handling: new Map([[`event:${EVENT}`, entry(100)], [`pubkey:${AUTHOR}`, entry(200)]]),
      });
      expect(reportHandlingStatus(eventReport(150, AUTHOR), ctx)).toBe('handled');
    });

    it("is handled when the post's own handling came after the report", () => {
      const ctx = ctxWith({
        bannedPubkeys: new Set([AUTHOR]),
        handling: new Map([[`event:${EVENT}`, entry(200)], [`pubkey:${AUTHOR}`, entry(100)]]),
      });
      expect(reportHandlingStatus(eventReport(150, AUTHOR), ctx)).toBe('handled');
    });

    it('is handled before when both handlings predate the report', () => {
      const ctx = ctxWith({
        bannedPubkeys: new Set([AUTHOR]),
        handling: new Map([[`event:${EVENT}`, entry(100)], [`pubkey:${AUTHOR}`, entry(120)]]),
      });
      expect(reportHandlingStatus(eventReport(150, AUTHOR), ctx)).toBe('handled_before');
    });

    it('does not consult the author when the author is not relay-banned', () => {
      const ctx = ctxWith({ handling: new Map([[`pubkey:${AUTHOR}`, entry(200)]]) });
      expect(reportHandlingStatus(eventReport(150, AUTHOR), ctx)).toBe('new');
    });

    it('does not cross-resolve an account report: its own entry decides', () => {
      const ctx = ctxWith({ bannedPubkeys: new Set([AUTHOR]), handling: new Map([[`pubkey:${AUTHOR}`, entry(100)]]) });
      expect(reportHandlingStatus(
        { id: REPORT_ID, created_at: 150, target: { type: 'pubkey', value: AUTHOR }, authorPubkey: AUTHOR },
        ctx,
      )).toBe('handled_before');
    });
  });
});

describe('consolidatedStatus', () => {
  const group = (times: number[]) => ({
    target: { type: 'pubkey' as const, value: PROFILE },
    reports: times.map((created_at, i) => ({ id: String(i).repeat(64), created_at })),
  });
  const ctx = ctxWith({ handling: new Map([[`pubkey:${PROFILE}`, entry(100)]]) });

  it('is handled_before when any report is', () => {
    expect(consolidatedStatus(group([50, 150]), ctx)).toBe('handled_before');
  });

  it('is handled when every report is', () => {
    expect(consolidatedStatus(group([20, 50]), ctx)).toBe('handled');
  });

  it('is new when the target has no handling', () => {
    expect(consolidatedStatus(group([20, 50]), ctxWith())).toBe('new');
  });
});

describe('queueResolution', () => {
  const base = {
    arrivals: new Map<string, number>(),
    bannedPubkeys: new Set<string>(),
    bannedEvents: new Set<string>(),
    resolvedTargets: new Set([`pubkey:${PROFILE}`]),
  };
  const report = { id: REPORT_ID, created_at: 150, target: { type: 'pubkey' as const, value: PROFILE } };
  // The screen's two steps in one: the handling map, then the rule.
  const resolve = ({ handlingRows, labelTargets, ...rest }: typeof base & {
    handlingRows: HandlingRow[] | undefined;
    labelTargets: { type: 'event' | 'pubkey'; value: string; at?: number }[] | undefined;
  }) => queueResolution({ ...rest, dated: datedHandling(handlingRows, labelTargets) });

  it("keeps today's membership rule against a worker that sends no handling rows", () => {
    const resolution = resolve({ ...base, handlingRows: undefined, labelTargets: [] });
    expect(resolution.rule).toBe('membership');
    expect(reportResolutionStatus(report, resolution)).toBe('handled');
    expect(groupResolutionStatus({ ...report, reports: [report] }, resolution)).toBe('handled');
  });

  it("keeps today's membership rule when the label targets carry no dates", () => {
    const resolution = resolve({
      ...base,
      handlingRows: [],
      labelTargets: [{ type: 'pubkey', value: PROFILE }],
    });
    expect(resolution.rule).toBe('membership');
  });

  it('never calls a report handled before under the membership rule', () => {
    const resolution = resolve({
      ...base, resolvedTargets: new Set(), handlingRows: undefined, labelTargets: undefined,
    });
    expect(reportResolutionStatus(report, resolution)).toBe('new');
  });

  it('applies the dated rule when the worker sends handling rows and dated labels', () => {
    const resolution = resolve({
      ...base,
      handlingRows: [{ target_type: 'pubkey', target_id: PROFILE, action: 'ban_user', moderator_pubkey: MODERATOR, at: 100 }],
      labelTargets: [],
    });
    expect(resolution.rule).toBe('dated');
    expect(reportResolutionStatus(report, resolution)).toBe('handled_before');
    expect(reportResolutionStatus({ ...report, created_at: 50 }, resolution)).toBe('handled');
    expect(groupResolutionStatus({ ...report, reports: [{ ...report, created_at: 50 }, report] }, resolution))
      .toBe('handled_before');
  });

  it('lets a later reopen cancel a resolution label', () => {
    const resolution = resolve({
      ...base,
      handlingRows: [{ target_type: 'pubkey', target_id: PROFILE, action: REOPENED_ACTION, moderator_pubkey: MODERATOR, at: 200 }],
      labelTargets: [{ type: 'pubkey', value: PROFILE, at: 100 }],
    });
    expect(reportResolutionStatus(report, resolution)).toBe('new');
  });

  it('does not count a target only automation touched (#332)', () => {
    const resolution = resolve({
      ...base,
      handlingRows: [{ target_type: 'pubkey', target_id: PROFILE, action: 'age_review_case_created', moderator_pubkey: 'auto', at: 100 }],
      labelTargets: [],
    });
    expect(reportResolutionStatus(report, resolution)).toBe('new');
    expect(reportResolutionStatus({ ...report, created_at: 50 }, resolution)).toBe('new');
  });

  it('compares by the arrivals it is given', () => {
    const resolution = resolve({
      ...base,
      arrivals: new Map([[REPORT_ID, 150]]),
      handlingRows: [{ target_type: 'pubkey', target_id: PROFILE, action: 'ban_user', moderator_pubkey: MODERATOR, at: 100 }],
      labelTargets: [],
    });
    expect(reportResolutionStatus({ ...report, created_at: 50 }, resolution)).toBe('handled_before');
  });

  it('passes the relay ban lists to the dated rule', () => {
    const resolution = resolve({
      ...base,
      bannedPubkeys: new Set([PROFILE]),
      handlingRows: [],
      labelTargets: [],
    });
    expect(reportResolutionStatus(report, resolution)).toBe('handled');
  });

  // A relay ban counts as undated only when the decision log has no dated row
  // for it (spec: "until a dated human decision exists"). After a Reopen, the
  // ban's own dated row is superseded, so the ban no longer hides anything:
  // Reopen must never make a report less visible.
  describe('a relay ban the decision log dates, then a reopen', () => {
    const banThenReopen = (pubkey: string): HandlingRow[] => [
      { target_type: 'pubkey', target_id: pubkey, action: 'ban_user', moderator_pubkey: MODERATOR, at: 100 },
      { target_type: 'pubkey', target_id: pubkey, action: REOPENED_ACTION, moderator_pubkey: MODERATOR, at: 200 },
    ];

    it('shows a report on the reopened account as new, though the relay still lists the ban', () => {
      const resolution = resolve({
        ...base,
        bannedPubkeys: new Set([PROFILE]),
        handlingRows: banThenReopen(PROFILE),
        labelTargets: [],
      });
      expect(reportResolutionStatus(report, resolution)).toBe('new');
      // Before the reopen, the same report was handled before the ban.
      const beforeReopen = resolve({
        ...base,
        bannedPubkeys: new Set([PROFILE]),
        handlingRows: banThenReopen(PROFILE).slice(0, 1),
        labelTargets: [],
      });
      expect(reportResolutionStatus(report, beforeReopen)).toBe('handled_before');
    });

    it("shows a report on a post by the reopened, relay-banned author as new", () => {
      const resolution = resolve({
        ...base,
        bannedPubkeys: new Set([AUTHOR]),
        handlingRows: banThenReopen(AUTHOR),
        labelTargets: [],
      });
      expect(reportResolutionStatus(eventReport(150, AUTHOR), resolution)).toBe('new');
    });

    it('still hides a report under a ban the decision log has no row for', () => {
      const resolution = resolve({
        ...base,
        bannedPubkeys: new Set([PROFILE, AUTHOR]),
        // Rows for other targets only.
        handlingRows: banThenReopen('9'.repeat(64)),
        labelTargets: [],
      });
      expect(reportResolutionStatus(report, resolution)).toBe('handled');
      expect(reportResolutionStatus(eventReport(150, AUTHOR), resolution)).toBe('handled');
    });

    it('lets a reopened post report still be answered by its own later handling', () => {
      const resolution = resolve({
        ...base,
        bannedPubkeys: new Set([AUTHOR]),
        handlingRows: [
          ...banThenReopen(AUTHOR),
          { target_type: 'event', target_id: EVENT, action: 'delete_event', moderator_pubkey: MODERATOR, at: 300 },
        ],
        labelTargets: [],
      });
      expect(reportResolutionStatus(eventReport(150, AUTHOR), resolution)).toBe('handled');
    });
  });
});

describe('datedHandling', () => {
  it('is null against a worker that sends no handling rows', () => {
    expect(datedHandling(undefined, [])).toBeNull();
  });

  it('is null when any label target has no date', () => {
    expect(datedHandling([], [{ type: 'pubkey', value: PROFILE, at: 1 }, { type: 'pubkey', value: AUTHOR }])).toBeNull();
  });

  it('logs every target with a reopen or a dated human row, and no other', () => {
    const dated = datedHandling([
      { target_type: 'pubkey', target_id: PROFILE, action: REOPENED_ACTION, moderator_pubkey: MODERATOR, at: 200 },
      { target_type: 'event', target_id: EVENT, action: 'delete_event', moderator_pubkey: MODERATOR, at: 100 },
      // Undated: the ban predates the log's dates, so it stays undated.
      { target_type: 'pubkey', target_id: AUTHOR, action: 'ban_user', moderator_pubkey: MODERATOR, at: null },
      // Automation is not a person's decision.
      { target_type: 'pubkey', target_id: 'c'.repeat(64), action: 'age_review_case_created', moderator_pubkey: 'auto', at: 100 },
    ], []);
    expect([...dated!.logged].sort()).toEqual([`event:${EVENT}`, `pubkey:${PROFILE}`].sort());
  });
});
