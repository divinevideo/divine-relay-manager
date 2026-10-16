import { describe, it, expect } from 'vitest';
import { historyCount, historyStat, reportsFiledLabel } from './historyCount';

describe('historyCount', () => {
  it('prints a complete count as it is', () => {
    expect(historyCount(80, false)).toBe('80');
  });

  it('marks a count that stopped early as a floor', () => {
    expect(historyCount(991, true)).toBe('991+');
  });
});

describe('historyStat', () => {
  it('does not print a failed read as zero', () => {
    expect(historyStat(0, false, true, 'reports')).toBe('reports unavailable');
  });

  it('keeps a floor mark when the read finished at its bound', () => {
    expect(historyStat(991, true, false, 'labels')).toBe('991+ labels');
  });
});

describe('reportsFiledLabel', () => {
  it('prints a count under the read limit exactly', () => {
    expect(reportsFiledLabel(42, 100)).toBe('42 reports filed');
  });

  it('uses the singular for one report', () => {
    expect(reportsFiledLabel(1, 100)).toBe('1 report filed');
  });

  it('prints zero as zero', () => {
    expect(reportsFiledLabel(0, 100)).toBe('0 reports filed');
  });

  // A read that filled its limit may have stopped there: the count is a floor.
  it('marks a count that reached the read limit as a floor', () => {
    expect(reportsFiledLabel(100, 100)).toBe('100+ reports filed');
  });
});
