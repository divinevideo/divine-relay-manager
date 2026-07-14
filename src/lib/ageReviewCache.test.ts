// ABOUTME: Tests list-cache reconciliation for mutated age-review cases —
// ABOUTME: the client-side mirror of the worker's list filters (#179 review)

import { describe, expect, it } from 'vitest';
import type { AgeReviewCase } from '../../shared/age-review';
import { caseBelongsInList, reconcileCaseIntoList } from './ageReviewCache';

function makeCase(overrides: Partial<AgeReviewCase> = {}): AgeReviewCase {
  return {
    id: 'case-1',
    pubkey: 'a'.repeat(64),
    reporter_pubkey: 'b'.repeat(64),
    report_id: 'report-1',
    suspected_age_band: 'age_13_15',
    state: 'under_moderator_review',
    allowed_resolution: 'parent_video_or_email',
    parent_contact_email: null,
    deadline_at: null,
    clock_paused: 0,
    clock_paused_at: null,
    remaining_days_when_paused: null,
    moderator_pubkey: null,
    resolution_note: null,
    last_alerted_at: null,
    zendesk_ticket_id: null,
    created_via: 'report',
    claim_link_url: null,
    claim_link_expires_at: null,
    created_at: '2026-07-14T00:00:00Z',
    updated_at: '2026-07-14T00:00:00Z',
    version: 0,
    ...overrides,
  };
}

describe('caseBelongsInList', () => {
  it('active list excludes terminal states and includes the rest', () => {
    expect(caseBelongsInList({ state: 'active' }, makeCase({ state: 'cleared' }))).toBe(false);
    expect(caseBelongsInList({ state: 'active' }, makeCase({ state: 'denied_closed' }))).toBe(false);
    expect(caseBelongsInList({ state: 'active' }, makeCase({ state: 'open_reported' }))).toBe(true);
  });

  it('closed list includes only terminal states', () => {
    expect(caseBelongsInList({ state: 'closed' }, makeCase({ state: 'cleared' }))).toBe(true);
    expect(caseBelongsInList({ state: 'closed' }, makeCase({ state: 'open_reported' }))).toBe(false);
  });

  it('a specific state filter matches exactly', () => {
    expect(caseBelongsInList({ state: 'under_moderator_review' }, makeCase())).toBe(true);
    expect(caseBelongsInList({ state: 'under_moderator_review' }, makeCase({ state: 'cleared' }))).toBe(false);
  });

  it('no state filter means all states; band filters exactly', () => {
    expect(caseBelongsInList({}, makeCase({ state: 'cleared' }))).toBe(true);
    expect(caseBelongsInList({ age_band: 'under_13' }, makeCase())).toBe(false);
    expect(caseBelongsInList({ age_band: 'age_13_15' }, makeCase())).toBe(true);
  });
});

describe('reconcileCaseIntoList', () => {
  const other = makeCase({ id: 'case-2', pubkey: 'c'.repeat(64) });

  it('drops a newly terminal case from an active list (the shadowing row)', () => {
    const active = makeCase();
    const next = reconcileCaseIntoList({ state: 'active' }, [active, other], makeCase({ state: 'cleared', version: 1 }));
    expect(next.map(c => c.id)).toEqual(['case-2']);
  });

  it('replaces the row in-place when the case still belongs (fresh version reaches the list)', () => {
    const next = reconcileCaseIntoList({ state: 'active' }, [makeCase(), other], makeCase({ version: 3, clock_paused: 1 }));
    expect(next.find(c => c.id === 'case-1')).toMatchObject({ version: 3, clock_paused: 1 });
    expect(next).toHaveLength(2);
  });

  it('leaves a belonging-but-absent case for the refetch (never fabricates order)', () => {
    const next = reconcileCaseIntoList({ state: 'closed' }, [makeCase({ id: 'case-9', state: 'cleared' })], makeCase({ state: 'cleared', version: 1 }));
    expect(next.map(c => c.id)).toEqual(['case-9']);
  });

  it('does not disturb other rows when dropping', () => {
    const next = reconcileCaseIntoList({ state: 'active' }, [other, makeCase()], makeCase({ state: 'denied_closed', version: 1 }));
    expect(next).toEqual([other]);
  });
});
