import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NostrEvent } from '@nostrify/nostrify';
import { consolidateReports } from './consolidateReports';

const hex = (n: number, fill = '0') => n.toString(16).padStart(64, fill);
const EVENT_A = hex(0xa);
const EVENT_B = hex(0xb);
const R1 = hex(1, 'a');
const R2 = hex(2, 'a');
const R3 = hex(3, 'a');

let nextId = 0;
const report = (target: string, reporter: string, created_at: number, category = 'spam'): NostrEvent => ({
  id: hex(++nextId, 'f'),
  pubkey: reporter,
  created_at,
  kind: 1984,
  tags: [['e', target], ['report', category]],
  content: '',
  sig: '',
});

describe('consolidateReports', () => {
  it('lists each reporter once, in the order the reports arrive', () => {
    const [group] = consolidateReports([
      report(EVENT_A, R2, 400),
      report(EVENT_A, R1, 300),
      report(EVENT_A, R2, 200),
      report(EVENT_A, R3, 100),
    ]);

    expect(group.reporters).toEqual([R2, R1, R3]);
    // Every report still counts; only the reporter list is deduped.
    expect(group.reports).toHaveLength(4);
  });

  it('treats reporter keys as exact strings, without case folding', () => {
    const upper = R1.toUpperCase();
    const [group] = consolidateReports([report(EVENT_A, R1, 2), report(EVENT_A, upper, 1)]);

    expect(group.reporters).toEqual([R1, upper]);
  });

  it('lists each category once, in the order the reports arrive', () => {
    const [group] = consolidateReports([
      report(EVENT_A, R1, 3, 'spam'),
      report(EVENT_A, R2, 2, 'nudity'),
      report(EVENT_A, R3, 1, 'spam'),
    ]);

    expect(group.categories).toEqual(['spam', 'nudity']);
  });

  it('keeps reporters per target, and orders targets by report count', () => {
    const groups = consolidateReports([
      report(EVENT_B, R1, 5),
      report(EVENT_A, R1, 4),
      report(EVENT_A, R2, 3),
      report(EVENT_A, R1, 2),
    ]);

    expect(groups.map(g => [g.target.value, g.reports.length, g.reporters])).toEqual([
      [EVENT_A, 3, [R1, R2]],
      [EVENT_B, 1, [R1]],
    ]);
  });

  describe('with a few thousand reports on one target', () => {
    const SCANS = ['includes', 'indexOf', 'lastIndexOf', 'some', 'find', 'findIndex'] as const;

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('dedupes reporters without scanning the reporter list', () => {
      // 4,000 reports from 2,000 reporters, each reporting twice. Scanning the
      // list on every report is quadratic in the reporters: the targeted
      // lookup can return 40,000 reports for one account.
      const reporters = Array.from({ length: 2000 }, (_, i) => `b${i.toString(16).padStart(63, '0')}`);
      const pool = [
        ...reporters.map((r, i) => report(EVENT_A, r, 10_000 - i)),
        ...reporters.map((r, i) => report(EVENT_A, r, 5_000 - i)),
      ];

      // Record every array searched while grouping. Spying the prototype
      // catches the scan whichever search method it uses.
      const searched = new Set<unknown>();
      for (const method of SCANS) {
        const original = Array.prototype[method] as (...args: unknown[]) => unknown;
        vi.spyOn(Array.prototype, method).mockImplementation(function (this: unknown[], ...args: unknown[]) {
          searched.add(this);
          return original.apply(this, args);
        } as never);
      }

      const [group] = consolidateReports(pool);
      vi.restoreAllMocks();

      expect(group.reports).toHaveLength(4000);
      expect(group.reporters).toEqual(reporters);
      expect(searched.has(group.reporters)).toBe(false);
    });
  });
});
