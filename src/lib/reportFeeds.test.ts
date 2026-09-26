import { describe, expect, it } from 'vitest';
import type { NostrEvent } from '@nostrify/nostrify';
import { mergeReportFeeds } from './reportFeeds';

const report = (id: string, created_at: number): NostrEvent =>
  ({ id, created_at, pubkey: 'p', kind: 1984, tags: [], content: '', sig: '' });

describe('mergeReportFeeds', () => {
  it('lists a report held by two feeds once', () => {
    const shared = report('a', 300);

    expect(mergeReportFeeds([shared, report('b', 100)], [report('c', 200), shared]).map(e => e.id))
      .toEqual(['a', 'c', 'b']);
  });

  it('orders the combined list newest first', () => {
    expect(mergeReportFeeds([report('old', 1)], [report('new', 2)]).map(e => e.id)).toEqual(['new', 'old']);
  });

  it('skips a feed that has not loaded', () => {
    expect(mergeReportFeeds([report('a', 1)], undefined).map(e => e.id)).toEqual(['a']);
  });
});
