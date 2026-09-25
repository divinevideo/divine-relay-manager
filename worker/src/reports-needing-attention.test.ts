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
    expect([...keys].sort()).toEqual([`event:${E1}`, `event:${E2}`, `pubkey:${P1}`]);
  });

  it('does not change the case of a key', () => {
    // Global constraint: the worker must key exactly as the client does.
    const keys = resolvedKeysFrom([{ target_type: 'pubkey', target_id: 'AbC' }], []);
    expect(keys.has('pubkey:AbC')).toBe(true);
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

  it('keeps a resolved target that is still pending review', () => {
    // Review Focus 4: the union. Without it the pending-review badge counts a
    // target the list can never show.
    const result = selectReportsNeedingAttention(
      [report('r1', [['e', E1]])],
      new Set([`event:${E1}`]),
      new Set([`event:${E1}`]),
    );
    expect(result.events.map(r => r.id)).toEqual(['r1']);
    expect(result.counts).toEqual({ targets: 1, resolved: 0 });
  });

  it('keeps every report for a target but counts the target once', () => {
    // Review Focus 3.
    const result = selectReportsNeedingAttention(
      [report('r1', [['e', E1]]), report('r2', [['e', E1]]), report('r3', [['e', E2]]), report('r4', [['e', E2]])],
      new Set([`event:${E2}`]),
      new Set(),
    );
    expect(result.events.map(r => r.id)).toEqual(['r1', 'r2']);
    expect(result.counts).toEqual({ targets: 1, resolved: 1 });
  });

  it('keeps a report that names no usable target, and does not count it as a target', () => {
    // Review Focus 1: the client keeps these; they can never be resolved by key.
    const result = selectReportsNeedingAttention(
      [report('r1', [['x', 'y']]), { id: 'r2', created_at: 1 } as unknown as RelayReport],
      new Set(),
      new Set(),
    );
    expect(result.events.map(r => r.id)).toEqual(['r1', 'r2']);
    expect(result.counts.targets).toBe(0);
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
