import { describe, it, expect } from 'vitest';
import { historyCount } from './historyCount';

describe('historyCount', () => {
  it('prints a complete count as it is', () => {
    expect(historyCount(80, false)).toBe('80');
  });

  it('marks a count that stopped early as a floor', () => {
    expect(historyCount(991, true)).toBe('991+');
  });
});
