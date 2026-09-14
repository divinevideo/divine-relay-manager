// Reducing kind-1985 resolution labels to the target keys the queue subtracts.
// This mirrors what Reports.tsx did in the browser over a 500-event page; moving
// it to the worker is what makes an uncapped label read affordable to send.
import { describe, it, expect } from 'vitest';
import { reduceLabelsToTargets, pageResolutionLabels } from './resolution-labels';
import type { ResolutionLabelEvent } from './resolution-labels';

function label(tags: string[][]) {
  return { id: Math.random().toString(36).slice(2), created_at: 1, tags };
}

describe('reduceLabelsToTargets', () => {
  it('reads an event target from an e tag', () => {
    const targets = reduceLabelsToTargets([label([['e', 'a'.repeat(64)]])]);

    expect(targets).toEqual([{ type: 'event', value: 'a'.repeat(64) }]);
  });

  it('reads a pubkey target from a p tag', () => {
    const targets = reduceLabelsToTargets([label([['p', 'b'.repeat(64)]])]);

    expect(targets).toEqual([{ type: 'pubkey', value: 'b'.repeat(64) }]);
  });

  it('reads both targets when a label carries an e tag and a p tag', () => {
    // Reports.tsx added both, independently -- not one or the other. A reducer
    // that stops at the first match silently stops resolving the author side of
    // every event-scoped resolution.
    const targets = reduceLabelsToTargets([
      label([['e', 'a'.repeat(64)], ['p', 'b'.repeat(64)]]),
    ]);

    expect(targets).toEqual([
      { type: 'event', value: 'a'.repeat(64) },
      { type: 'pubkey', value: 'b'.repeat(64) },
    ]);
  });

  it('collapses the same target appearing across many labels', () => {
    // The point of the projection: a target resolved ten times costs one entry,
    // so the payload tracks targets rather than moderation volume.
    const targets = reduceLabelsToTargets([
      label([['e', 'a'.repeat(64)]]),
      label([['e', 'a'.repeat(64)]]),
      label([['e', 'a'.repeat(64)]]),
    ]);

    expect(targets).toEqual([{ type: 'event', value: 'a'.repeat(64) }]);
  });

  it('ignores a label with no e or p tag', () => {
    const targets = reduceLabelsToTargets([label([['L', 'moderation/resolution']])]);

    expect(targets).toEqual([]);
  });

  it('ignores a tag with no value', () => {
    // Relay payloads are untrusted input; a malformed tag must not become a
    // target key of 'event:undefined' that silently resolves nothing.
    const targets = reduceLabelsToTargets([label([['e']])]);

    expect(targets).toEqual([]);
  });
});

// A relay that holds `all` newest-first and answers each REQ with the newest
// `pageSize` events whose created_at <= until. `until` is inclusive, exactly as
// a real relay treats it, so boundary events repeat across pages.
function fakeRelay(all: ResolutionLabelEvent[], pageSize: number) {
  const calls: Array<number | undefined> = [];
  const sorted = [...all].sort((a, b) => b.created_at - a.created_at);
  const fetchPage = async (until: number | undefined) => {
    calls.push(until);
    const eligible = until === undefined ? sorted : sorted.filter((e) => e.created_at <= until);
    return eligible.slice(0, pageSize);
  };
  return { fetchPage, calls };
}

function labels(count: number, startAt: number): ResolutionLabelEvent[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `label-${startAt - i}`,
    created_at: startAt - i,
    tags: [['e', String(startAt - i).padStart(64, '0')]],
  }));
}

describe('pageResolutionLabels', () => {
  it('returns every target when the relay answers in one short page', async () => {
    const { fetchPage, calls } = fakeRelay(labels(3, 100), 10);

    const result = await pageResolutionLabels(fetchPage, { pageSize: 10, maxPages: 5 });

    expect(result.targets).toHaveLength(3);
    expect(result.truncated).toBe(false);
    expect(calls).toEqual([undefined]);
  });

  it('pages past a full page using the oldest created_at as the next until', async () => {
    // 25 labels, 10 per page -> 10 / 10 / 5. Without paging this returns 10 and
    // the other 15 targets silently read as unresolved, which is the bug.
    const { fetchPage, calls } = fakeRelay(labels(25, 100), 10);

    const result = await pageResolutionLabels(fetchPage, { pageSize: 10, maxPages: 5 });

    expect(result.targets).toHaveLength(25);
    expect(result.truncated).toBe(false);
    expect(calls).toEqual([undefined, 91, 82]);
  });

  it('dedups the boundary event that an inclusive until returns twice', async () => {
    const { fetchPage } = fakeRelay(labels(25, 100), 10);

    const result = await pageResolutionLabels(fetchPage, { pageSize: 10, maxPages: 5 });

    const values = result.targets.map((t) => t.value);
    expect(new Set(values).size).toBe(values.length);
  });

  it('stops at the page bound and says so instead of looping', async () => {
    // The safety valve: coverage is bounded, but never silently. #221 exists
    // because a capped read that claims completeness un-hides handled work.
    const { fetchPage, calls } = fakeRelay(labels(500, 1000), 10);

    const result = await pageResolutionLabels(fetchPage, { pageSize: 10, maxPages: 3 });

    expect(calls).toHaveLength(3);
    expect(result.truncated).toBe(true);
    // 28, not 30: `until` is inclusive, so each page after the first repeats the
    // previous page's boundary event, and the dedup drops it.
    expect(result.targets).toHaveLength(28);
  });

  it('reports the oldest created_at it actually covered', async () => {
    const { fetchPage } = fakeRelay(labels(500, 1000), 10);

    const result = await pageResolutionLabels(fetchPage, { pageSize: 10, maxPages: 3 });

    // 3 pages of 10 starting at 1000, with the inclusive boundary repeating:
    // 1000..991, 991..982, 982..973.
    expect(result.oldestCovered).toBe(973);
  });

  it('lets a failing page propagate instead of returning a partial set as complete', async () => {
    // queryRelay's #186 contract: an unconfirmed read is a failure, not an empty
    // one. Swallowing it here would hand the queue a short target list that
    // reads as authoritative, un-hiding handled work -- the #221 bug, reached by
    // a different route. The caller 502s; it must never see truncated:false.
    let page = 0;
    const fetchPage = async () => {
      page += 1;
      if (page === 2) throw new Error('Relay query timed out before EOSE');
      return labels(10, 100);
    };

    await expect(
      pageResolutionLabels(fetchPage, { pageSize: 10, maxPages: 5 })
    ).rejects.toThrow('Relay query timed out before EOSE');
  });

  it('is not truncated when the relay runs out exactly on a page boundary', async () => {
    // A full page followed by an empty one is exhaustion, not a cap.
    const { fetchPage } = fakeRelay(labels(10, 100), 10);

    const result = await pageResolutionLabels(fetchPage, { pageSize: 10, maxPages: 5 });

    expect(result.truncated).toBe(false);
    expect(result.targets).toHaveLength(10);
  });
});
