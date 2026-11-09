import { describe, it, expect } from 'vitest';
import { isResolvedForReview, resolvedKeysFrom, selectReportsNeedingAttention, type RelayReport } from './reports-needing-attention';

const report = (id: string, tags: string[][]): RelayReport => ({ id, created_at: 1, tags });
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

describe('selectReportsNeedingAttention', () => {
  it('keeps unresolved reports and drops resolved ones, counting targets', () => {
    const result = selectReportsNeedingAttention(
      [report('r1', [['e', E1]]), report('r2', [['e', E2]]), report('r3', [['p', P1]])],
      new Set([`event:${E2}`]),
      new Set(),
    );
    expect(result.events.map(r => r.id)).toEqual(['r1', 'r3']);
    expect(result.counts).toEqual({ targets: 2, resolved: 1 });
  });

  it('drops a report naming its target in uppercase hex once that target is resolved', () => {
    // getReportTarget keys both reports lowercase (#315).
    const lower = 'ab'.repeat(32);
    const result = selectReportsNeedingAttention(
      [report('r1', [['e', lower.toUpperCase()]]), report('r2', [['e', lower]])],
      new Set([`event:${lower}`]),
      new Set(),
    );
    expect(result.events).toEqual([]);
    expect(result.counts).toEqual({ targets: 0, resolved: 1 });
  });

  it('keeps a resolved target that is still pending review', () => {
    // A target can be resolved (it has a decision) yet still pending human
    // review. Needs-attention must keep it in the union, or the
    // pending-review badge counts a target the list can never show.
    const result = selectReportsNeedingAttention(
      [report('r1', [['e', E1]])],
      new Set([`event:${E1}`]),
      new Set([`event:${E1}`]),
    );
    expect(result.events.map(r => r.id)).toEqual(['r1']);
    expect(result.counts).toEqual({ targets: 1, resolved: 0 });
  });

  it('keeps every report for a target but counts the target once', () => {
    // One target reported many times: every report is kept, but the target
    // is counted once.
    const result = selectReportsNeedingAttention(
      [report('r1', [['e', E1]]), report('r2', [['e', E1]]), report('r3', [['e', E2]]), report('r4', [['e', E2]])],
      new Set([`event:${E2}`]),
      new Set(),
    );
    expect(result.events.map(r => r.id)).toEqual(['r1', 'r2']);
    expect(result.counts).toEqual({ targets: 1, resolved: 1 });
  });

  it('keeps a report that names no usable target, and does not count it as a target', () => {
    // A report naming no usable target can never be resolved by key, so it
    // must stay in needs-attention; the client keeps these too.
    const result = selectReportsNeedingAttention(
      [report('r1', [['x', 'y']]), { id: 'r2', created_at: 1 } as unknown as RelayReport],
      new Set(),
      new Set(),
    );
    expect(result.events.map(r => r.id)).toEqual(['r1', 'r2']);
    expect(result.counts.targets).toBe(0);
  });

  it('keeps a target only the worker resolved, and marks it among the targets it kept', () => {
    const result = selectReportsNeedingAttention(
      [report('r1', [['p', P1]]), report('r2', [['p', P1]]), report('r3', [['e', E1]]), report('r4', [['e', E2]])],
      new Set([`event:${E2}`]),
      new Set(),
      // P1 is automation-only. E1 is kept too, but unresolved, so not marked.
      new Set([`pubkey:${P1}`, `event:${'9'.repeat(64)}`]),
    );
    expect(result.events.map(r => r.id)).toEqual(['r1', 'r2', 'r3']);
    // Only kept targets are marked: the second automated key names no report here.
    expect(result.automatedTargets).toEqual([`pubkey:${P1}`]);
    expect(result.counts).toEqual({ targets: 2, resolved: 1 });
  });

  it('treats a valueless e tag as the event:undefined key, exactly as the client does', () => {
    const result = selectReportsNeedingAttention(
      [report('r1', [['e']])],
      new Set(['event:undefined']),
      new Set(),
    );
    expect(result.events).toEqual([]);
    expect(result.counts.resolved).toBe(1);
  });
});

describe('isResolvedForReview', () => {
  // The complement invariant selectReportsNeedingAttention and
  // getResolvedReportsPage both rest on: a target is handled only when it is
  // resolved AND not still pending review.
  it('is true only when resolved and not pending review', () => {
    const resolved = new Set([`event:${E1}`]);
    const pendingReview = new Set([`event:${E2}`]);

    expect(isResolvedForReview(`event:${E1}`, resolved, pendingReview)).toBe(true);
    // Not resolved at all.
    expect(isResolvedForReview(`event:${E2}`, resolved, pendingReview)).toBe(false);

    resolved.add(`event:${E2}`);
    // Resolved but still pending review.
    expect(isResolvedForReview(`event:${E2}`, resolved, pendingReview)).toBe(false);
    // Neither resolved nor pending review.
    expect(isResolvedForReview(`pubkey:${P1}`, resolved, pendingReview)).toBe(false);
  });
});
