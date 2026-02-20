import { describe, it, expect } from 'vitest';
import type { NostrEvent } from '@nostrify/nostrify';

// Pure logic extracted from BulkDeleteByKind for testability.
// These match the existing component behavior exactly.

function countByKind(events: NostrEvent[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const event of events) {
    counts.set(event.kind, (counts.get(event.kind) || 0) + 1);
  }
  return counts;
}

function filterByKind(events: NostrEvent[], selectedKind: string): NostrEvent[] {
  const kind = parseInt(selectedKind);
  if (isNaN(kind)) return [];
  return events.filter(e => e.kind === kind);
}

// Minimal event factory — only fields the logic touches
function makeEvent(overrides: Partial<NostrEvent> & { kind: number }): NostrEvent {
  return {
    id: overrides.id || Math.random().toString(36).slice(2),
    pubkey: overrides.pubkey || 'abc123',
    created_at: overrides.created_at || Math.floor(Date.now() / 1000),
    kind: overrides.kind,
    tags: overrides.tags || [],
    content: overrides.content || '',
    sig: overrides.sig || 'sig',
  };
}

describe('countByKind', () => {
  it('counts events grouped by kind', () => {
    const events = [
      makeEvent({ kind: 34235 }),
      makeEvent({ kind: 34235 }),
      makeEvent({ kind: 1 }),
      makeEvent({ kind: 7 }),
      makeEvent({ kind: 34235 }),
    ];
    const counts = countByKind(events);
    expect(counts.get(34235)).toBe(3);
    expect(counts.get(1)).toBe(1);
    expect(counts.get(7)).toBe(1);
    expect(counts.size).toBe(3);
  });

  it('returns empty map for no events', () => {
    const counts = countByKind([]);
    expect(counts.size).toBe(0);
  });

  it('handles single event', () => {
    const counts = countByKind([makeEvent({ kind: 0 })]);
    expect(counts.get(0)).toBe(1);
    expect(counts.size).toBe(1);
  });
});

describe('filterByKind', () => {
  const events = [
    makeEvent({ kind: 34235, id: 'video1' }),
    makeEvent({ kind: 34235, id: 'video2' }),
    makeEvent({ kind: 1, id: 'note1' }),
    makeEvent({ kind: 7, id: 'reaction1' }),
    makeEvent({ kind: 34235, id: 'video3' }),
    makeEvent({ kind: 6, id: 'repost1' }),
  ];

  it('filters events matching the selected kind', () => {
    const result = filterByKind(events, '34235');
    expect(result).toHaveLength(3);
    expect(result.every(e => e.kind === 34235)).toBe(true);
  });

  it('returns single match for kind with one event', () => {
    const result = filterByKind(events, '1');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('note1');
  });

  it('returns empty array for kind with no events', () => {
    const result = filterByKind(events, '30023');
    expect(result).toHaveLength(0);
  });

  it('returns empty array for NaN kind', () => {
    const result = filterByKind(events, 'not-a-number');
    expect(result).toHaveLength(0);
  });

  it('returns empty array for empty string kind', () => {
    const result = filterByKind(events, '');
    expect(result).toHaveLength(0);
  });

  it('returns empty array when events list is empty', () => {
    const result = filterByKind([], '34235');
    expect(result).toHaveLength(0);
  });

  it('count from filterByKind matches countByKind for same kind', () => {
    const counts = countByKind(events);
    for (const [kind, count] of counts) {
      const filtered = filterByKind(events, kind.toString());
      expect(filtered).toHaveLength(count);
    }
  });
});
