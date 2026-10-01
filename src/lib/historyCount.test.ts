import { describe, it, expect } from 'vitest';
import { historyCount, historyStat } from './historyCount';

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
