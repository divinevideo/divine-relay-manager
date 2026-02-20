import { describe, it, expect } from 'vitest';
import { formatRelativeTime } from './useDataFreshness';

describe('formatRelativeTime', () => {
  it('returns "just now" for timestamps less than 5 seconds ago', () => {
    const now = Date.now();
    expect(formatRelativeTime(now)).toBe('just now');
    expect(formatRelativeTime(now - 2000)).toBe('just now');
    expect(formatRelativeTime(now - 4500)).toBe('just now');
  });

  it('returns seconds for timestamps 5-59 seconds ago', () => {
    const now = Date.now();
    expect(formatRelativeTime(now - 5000)).toBe('5s ago');
    expect(formatRelativeTime(now - 30000)).toBe('30s ago');
    expect(formatRelativeTime(now - 59000)).toBe('59s ago');
  });

  it('returns minutes for timestamps 60+ seconds ago', () => {
    const now = Date.now();
    expect(formatRelativeTime(now - 60000)).toBe('1m ago');
    expect(formatRelativeTime(now - 120000)).toBe('2m ago');
    expect(formatRelativeTime(now - 300000)).toBe('5m ago');
  });

  it('handles large values', () => {
    const now = Date.now();
    expect(formatRelativeTime(now - 3600000)).toBe('60m ago');
  });
});
