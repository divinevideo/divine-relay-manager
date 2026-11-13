import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  getReportsForTarget, handledBeforeByLastAction, isResolvedForReview, resolvedKeysFrom, selectReportsNeedingAttention,
  type RelayReport,
} from './reports-needing-attention';
import { handlingByTarget, type HandlingEntry, type HandlingRow } from '../../shared/handling';

const report = (id: string, tags: string[][], createdAt = 1): RelayReport => ({ id, created_at: createdAt, tags });
const E1 = '1'.repeat(64);
const E2 = '2'.repeat(64);
const P1 = 'a'.repeat(64);

describe('resolvedKeysFrom', () => {
  it('takes every label target and the event and pubkey decisions', () => {
    const keys = resolvedKeysFrom(
      [{ target_type: 'event', target_id: E1 }, { target_type: 'pubkey', target_id: P1 }, { target_type: 'media', target_id: 'x' }],
      [{ type: 'event', value: E2 }],
    );
    expect([...keys.resolved].sort()).toEqual([`event:${E1}`, `event:${E2}`, `pubkey:${P1}`]);
    expect(keys.automated.size).toBe(0);
  });

  it('keys stored decisions and labels as written', () => {
    // getReportTarget lowercases a 64-character hex id (#315), but a stored
    // record is keyed as stored, as the pane's history and Reopen read it. One
    // in another spelling leaves its report in front of a person rather than
    // hiding it where Reopen can't reach.
    const hex = 'ab'.repeat(32);
    const keys = resolvedKeysFrom(
      [{ target_type: 'pubkey', target_id: 'AbC' }, { target_type: 'event', target_id: hex.toUpperCase() }],
      [{ type: 'pubkey', value: hex.toUpperCase() }],
    );
    expect([...keys.resolved].sort()).toEqual([`event:${hex.toUpperCase()}`, `pubkey:${hex.toUpperCase()}`, 'pubkey:AbC']);
  });

  it('keeps a target only the worker decided on out of resolved, unless a label also resolves it', () => {
    const keys = resolvedKeysFrom(
      [
        { target_type: 'pubkey', target_id: P1, automated: true },  // the worker's age-review case only
        { target_type: 'event', target_id: E1, automated: true },   // the worker's row, and a label
        { target_type: 'event', target_id: E2 },                    // a person's decision
      ],
      [{ type: 'event', value: E1 }],
    );
    expect([...keys.resolved].sort()).toEqual([`event:${E1}`, `event:${E2}`]);
    expect([...keys.automated]).toEqual([`pubkey:${P1}`]);
  });
});

// A person handled each key at `at` (default 100). The reports above default
// to created_at 1, so they are handled unless a test says otherwise.
function handled(keys: string[], at = 100): Map<string, HandlingEntry> {
  return new Map(keys.map(key => [key, { handledAt: at, history: [{ action: 'reviewed', at }] }]));
}
const MOD = 'f'.repeat(64);
const row = (targetId: string, action: string, at: number | null, moderator: string | null = MOD): HandlingRow => ({
  target_type: 'event', target_id: targetId, action, moderator_pubkey: moderator, at,
});

describe('selectReportsNeedingAttention', () => {
  it('keeps unresolved reports and drops handled ones, counting targets', () => {
    const result = selectReportsNeedingAttention(
      [report('r1', [['e', E1]]), report('r2', [['e', E2]]), report('r3', [['p', P1]])],
      handled([`event:${E2}`]),
      new Set(),
    );
    expect(result.events.map(r => r.id)).toEqual(['r1', 'r3']);
    expect(result.counts).toEqual({ targets: 2, resolved: 1, handled_before: 0 });
    expect(result.handledBefore).toEqual([]);
  });

  it('drops a report naming its target in uppercase hex once that target is handled', () => {
    // getReportTarget keys both reports lowercase (#315).
    const lower = 'ab'.repeat(32);
    const result = selectReportsNeedingAttention(
      [report('r1', [['e', lower.toUpperCase()]]), report('r2', [['e', lower]])],
      handled([`event:${lower}`]),
      new Set(),
    );
    expect(result.events).toEqual([]);
    expect(result.counts).toEqual({ targets: 0, resolved: 1, handled_before: 0 });
  });

  it('keeps a handled target that is still pending review', () => {
    // A target can be handled (it has a decision) yet still pending human
    // review. Needs-attention must keep it in the union, or the
    // pending-review badge counts a target the list can never show.
    const result = selectReportsNeedingAttention(
      [report('r1', [['e', E1]])],
      handled([`event:${E1}`]),
      new Set([`event:${E1}`]),
    );
    expect(result.events.map(r => r.id)).toEqual(['r1']);
    expect(result.counts).toEqual({ targets: 1, resolved: 0, handled_before: 0 });
  });

  it('keeps every report for a target but counts the target once', () => {
    const result = selectReportsNeedingAttention(
      [report('r1', [['e', E1]]), report('r2', [['e', E1]]), report('r3', [['e', E2]]), report('r4', [['e', E2]])],
      handled([`event:${E2}`]),
      new Set(),
    );
    expect(result.events.map(r => r.id)).toEqual(['r1', 'r2']);
    expect(result.counts).toEqual({ targets: 1, resolved: 1, handled_before: 0 });
  });

  it('keeps a report that names no usable target, and does not count it as a target', () => {
    // A report naming no usable target can never be resolved by key, so it
    // must stay in needs-attention; the client keeps these too.
    const result = selectReportsNeedingAttention(
      [report('r1', [['x', 'y']]), { id: 'r2', created_at: 1 } as unknown as RelayReport],
      new Map(),
      new Set(),
    );
    expect(result.events.map(r => r.id)).toEqual(['r1', 'r2']);
    expect(result.counts.targets).toBe(0);
  });

  it('keeps a target only the worker resolved, and marks it among the targets it kept', () => {
    const result = selectReportsNeedingAttention(
      [report('r1', [['p', P1]]), report('r2', [['p', P1]]), report('r3', [['e', E1]]), report('r4', [['e', E2]])],
      handled([`event:${E2}`]),
      new Set(),
      // P1 is automation-only. E1 is kept too, but unresolved, so not marked.
      new Set([`pubkey:${P1}`, `event:${'9'.repeat(64)}`]),
    );
    expect(result.events.map(r => r.id)).toEqual(['r1', 'r2', 'r3']);
    // Only kept targets are marked: the second automated key names no report here.
    expect(result.automatedTargets).toEqual([`pubkey:${P1}`]);
    expect(result.counts).toEqual({ targets: 2, resolved: 1, handled_before: 0 });
  });

  it('treats a valueless e tag as the event:undefined key, exactly as the client does', () => {
    const result = selectReportsNeedingAttention(
      [report('r1', [['e']])],
      handled(['event:undefined']),
      new Set(),
    );
    expect(result.events).toEqual([]);
    expect(result.counts.resolved).toBe(1);
  });

  describe('the handled-before rule (#324)', () => {
    it('drops a report that arrived before the target was handled', () => {
      const result = selectReportsNeedingAttention([report('r1', [['e', E1]], 50)], handled([`event:${E1}`], 100), new Set());
      expect(result.events).toEqual([]);
      expect(result.handledBefore).toEqual([]);
      expect(result.counts).toEqual({ targets: 0, resolved: 1, handled_before: 0 });
    });

    it('keeps a report filed after the handling, and lists its target as handled before', () => {
      const result = selectReportsNeedingAttention([report('r1', [['e', E1]], 150)], handled([`event:${E1}`], 100), new Set());
      expect(result.events.map(r => r.id)).toEqual(['r1']);
      expect(result.handledBefore).toEqual([`event:${E1}`]);
      expect(result.counts).toEqual({ targets: 1, resolved: 0, handled_before: 1 });
    });

    it('keeps a report filed in the same second as the handling: only strictly before is handled', () => {
      const result = selectReportsNeedingAttention([report('r1', [['e', E1]], 100)], handled([`event:${E1}`], 100), new Set());
      expect(result.events.map(r => r.id)).toEqual(['r1']);
      expect(result.handledBefore).toEqual([`event:${E1}`]);
    });

    it('compares by arrival when it is known, not by the time the reporter stamped', () => {
      // Stamped after the handling, but the watcher saw it arrive before.
      const early = selectReportsNeedingAttention(
        [report('r1', [['e', E1]], 150)], handled([`event:${E1}`], 100), new Set(), new Set(), new Map([['r1', 90]]),
      );
      expect(early.events).toEqual([]);
      expect(early.handledBefore).toEqual([]);
      // And the other way: stamped before, arrived after. A backdated report
      // must not hide itself.
      const late = selectReportsNeedingAttention(
        [report('r2', [['e', E1]], 50)], handled([`event:${E1}`], 100), new Set(), new Set(), new Map([['r2', 120]]),
      );
      expect(late.events.map(e => e.id)).toEqual(['r2']);
      expect(late.handledBefore).toEqual([`event:${E1}`]);
    });

    it('drops the older reports of a target, keeps its newer ones, and counts it only as handled before', () => {
      const result = selectReportsNeedingAttention(
        [report('old', [['e', E1]], 50), report('new', [['e', E1]], 150)],
        handled([`event:${E1}`], 100),
        new Set(),
      );
      expect(result.events.map(r => r.id)).toEqual(['new']);
      // resolved counts targets whose reports are ALL handled; this one is not.
      expect(result.counts).toEqual({ targets: 1, resolved: 0, handled_before: 1 });
    });

    it('keeps every report on a target only an automated row touched, and does not call it handled before', () => {
      const handling = handlingByTarget([row(E1, 'age_review_case_created', 100, 'auto')], []);
      const result = selectReportsNeedingAttention([report('r1', [['e', E1]], 50), report('r2', [['e', E1]], 150)], handling, new Set());
      expect(result.events.map(r => r.id)).toEqual(['r1', 'r2']);
      expect(result.handledBefore).toEqual([]);
      expect(result.counts).toEqual({ targets: 1, resolved: 0, handled_before: 0 });
    });

    it('treats a report as new again once the target was reopened after the handling', () => {
      const handling = handlingByTarget([row(E1, 'reviewed', 100), row(E1, 'reopened', 200)], []);
      const result = selectReportsNeedingAttention([report('r1', [['e', E1]], 150)], handling, new Set());
      expect(result.events.map(r => r.id)).toEqual(['r1']);
      expect(result.handledBefore).toEqual([]);
      expect(result.counts.handled_before).toBe(0);
    });

    it('keeps reports on a target handled by an undated decision dropped, whatever their time', () => {
      const handling = handlingByTarget([row(E1, 'reviewed', null)], []);
      const result = selectReportsNeedingAttention([report('r1', [['e', E1]], 9_999_999_999)], handling, new Set());
      expect(result.events).toEqual([]);
      expect(result.counts).toEqual({ targets: 0, resolved: 1, handled_before: 0 });
    });

    it('keeps a pending-review target whatever its handling, and still marks a newer report on it', () => {
      const result = selectReportsNeedingAttention(
        [report('r1', [['e', E1]], 50), report('r2', [['e', E2]], 150)],
        handled([`event:${E1}`, `event:${E2}`], 100),
        new Set([`event:${E1}`, `event:${E2}`]),
      );
      expect(result.events.map(r => r.id)).toEqual(['r1', 'r2']);
      expect(result.handledBefore).toEqual([`event:${E2}`]);
      expect(result.counts).toEqual({ targets: 2, resolved: 0, handled_before: 1 });
    });
  });
});

describe('isResolvedForReview', () => {
  // The complement invariant selectReportsNeedingAttention and
  // getResolvedReportsPage both rest on: a report is in resolved history only
  // when it is handled AND its target is not still pending review.
  it('is true only for a handled report on a target not pending review', () => {
    const pendingReview = new Set([`event:${E2}`]);

    expect(isResolvedForReview('handled', `event:${E1}`, pendingReview)).toBe(true);
    expect(isResolvedForReview('handled_before', `event:${E1}`, pendingReview)).toBe(false);
    expect(isResolvedForReview('new', `event:${E1}`, pendingReview)).toBe(false);
    // Handled but still pending review.
    expect(isResolvedForReview('handled', `event:${E2}`, pendingReview)).toBe(false);
  });
});

describe('handledBeforeByLastAction', () => {
  // The brigading watch (spec decision 6): how often items come back, by the
  // call that last cleared them.
  it('counts handled-before targets by the newest handling that is not a reopen', () => {
    const handling = handlingByTarget(
      [
        row(E1, 'dismissed', 100),
        row(E2, 'reviewed', 100), row(E2, 'reopened', 200), row(E2, 'dismissed', 300),
        { target_type: 'pubkey', target_id: P1, action: 'banned', moderator_pubkey: MOD, at: 100 },
      ],
      [],
    );
    expect(handledBeforeByLastAction([`event:${E1}`, `event:${E2}`, `pubkey:${P1}`], handling)).toEqual({
      dismissed: 2,
      banned: 1,
    });
  });

  it('names a resolution label as the call when it is the newest handling', () => {
    const handling = handlingByTarget([row(E1, 'dismissed', 100)], [{ type: 'event', value: E1, at: 120 }]);
    expect(handledBeforeByLastAction([`event:${E1}`], handling)).toEqual({ resolution_label: 1 });
  });

  it('is empty when nothing came back', () => {
    expect(handledBeforeByLastAction([], new Map())).toEqual({});
  });
});

// GET /api/reports?event= / ?pubkey=: the deep link's lookup for a target the
// feed does not carry. Its reports must be dated as the feed's are (#324).
describe('getReportsForTarget', () => {
  // A relay that answers every REQ with these events, then EOSE.
  function stubRelay(events: unknown[]) {
    class FakeWebSocket {
      private listeners = new Map<string, Array<(event: unknown) => void>>();
      constructor(_url: string) {
        setTimeout(() => this.emit('open', {}), 0);
      }
      addEventListener(type: string, listener: (event: unknown) => void) {
        if (!this.listeners.has(type)) this.listeners.set(type, []);
        this.listeners.get(type)!.push(listener);
      }
      send(raw: string) {
        const [, subId] = JSON.parse(raw) as [string, string];
        setTimeout(() => {
          for (const ev of events) this.emit('message', { data: JSON.stringify(['EVENT', subId, ev]) });
          this.emit('message', { data: JSON.stringify(['EOSE', subId]) });
        }, 0);
      }
      close() { /* no-op */ }
      private emit(type: string, event: unknown) {
        for (const handler of this.listeners.get(type) || []) handler(event);
      }
    }
    vi.stubGlobal('WebSocket', FakeWebSocket as never);
  }

  // report_arrivals as a map, read through prepare/bind/batch as D1 does.
  function arrivalsDb(rows: Record<string, number>, opts: { fail?: boolean } = {}) {
    return {
      prepare: (_sql: string) => ({ bind: (...ids: string[]) => ({ ids }) }),
      batch: async (statements: Array<{ ids: string[] }>) => {
        if (opts.fail) throw new Error('D1 unavailable');
        return statements.map(({ ids }) => ({
          results: ids.filter(reportId => reportId in rows).map(reportId => ({ report_id: reportId, first_seen_at: rows[reportId] })),
        }));
      },
    } as unknown as D1Database;
  }

  const relayReport = (id: string, createdAt: number) =>
    ({ id, kind: 1984, pubkey: P1, created_at: createdAt, tags: [['e', E1]], content: '', sig: 'f'.repeat(128) });
  const R1 = '3'.repeat(64);
  const R2 = '4'.repeat(64);

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("carries the arrivals of the target's reports the watcher saw, and only those", async () => {
    stubRelay([relayReport(R1, 2_000), relayReport(R2, 1_000)]);
    const { status, body } = await getReportsForTarget(
      { kinds: [1984], '#e': [E1] }, arrivalsDb({ [R1]: 900, ['5'.repeat(64)]: 50 }), 'wss://relay.example',
    );
    expect(status).toBe(200);
    expect((body.events as RelayReport[]).map(e => e.id)).toEqual([R1, R2]);
    expect(body.report_arrivals).toEqual({ [R1]: 900 });
  });

  // As on the feed and resolved history: dating every report by created_at
  // would let a backdated report read as handled before on this path alone.
  // The lookup also feeds the pane's Related Reports card, so arrivals are
  // enrichment here: a failed read answers without them, and those reports
  // compare by created_at, as from a worker that predates #324.
  it('answers without arrivals when the arrival read fails, and logs it', async () => {
    stubRelay([relayReport(R1, 2_000)]);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { status, body } = await getReportsForTarget(
      { kinds: [1984], '#e': [E1] }, arrivalsDb({}, { fail: true }), 'wss://relay.example',
    );
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect((body.events as unknown[]).length).toBe(1);
    expect(body).not.toHaveProperty('report_arrivals');
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('arrival'), expect.anything());
  });

  // The deep link tells "gone" from "still loading" with this lookup, so it
  // still answers with no database bound, and sends no arrivals.
  it('answers without a database, with no arrivals', async () => {
    stubRelay([relayReport(R1, 2_000)]);
    const { status, body } = await getReportsForTarget({ kinds: [1984], '#e': [E1] }, undefined, 'wss://relay.example');
    expect(status).toBe(200);
    expect((body.events as RelayReport[]).map(e => e.id)).toEqual([R1]);
    expect(body).not.toHaveProperty('report_arrivals');
  });
});
