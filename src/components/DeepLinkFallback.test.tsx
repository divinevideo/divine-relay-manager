// ABOUTME: Pins how the gone-report pane lists a target's prior moderation actions:
// ABOUTME: a Reopen row (#324) alone is not a prior action, and names no moderator.

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DeepLinkFallback } from './DeepLinkFallback';
import type { ModerationDecision } from '@/lib/adminApi';

const TARGET = { type: 'event' as const, value: 'c'.repeat(64) };
const MODERATOR = 'e'.repeat(64);

// What a Reopen writes: a dated `reopened` row with no moderator. An untyped
// reopen writes one under both target types, so one can stand alone on a
// target that was never handled.
const REOPEN: ModerationDecision = {
  id: 2,
  target_type: 'event',
  target_id: TARGET.value,
  action: 'reopened',
  reason: 'Reopened',
  created_at: '2026-11-02 10:00:00',
};
const REVIEWED: ModerationDecision = {
  id: 1,
  target_type: 'event',
  target_id: TARGET.value,
  action: 'reviewed',
  moderator_pubkey: MODERATOR,
  created_at: '2026-11-01 10:00:00',
};

function renderGone(decisions: ModerationDecision[]) {
  return render(<DeepLinkFallback status="gone" target={TARGET} decisions={decisions} onRetry={vi.fn()} />);
}

describe('DeepLinkFallback prior moderation actions', () => {
  it('says nothing was recorded when the only row is a reopen', () => {
    renderGone([REOPEN]);

    expect(screen.getByText('No prior moderation actions recorded for this target.')).toBeInTheDocument();
    expect(screen.queryByText(/Prior moderation actions on this target/)).not.toBeInTheDocument();
  });

  it('lists a reopen beside a real decision, dated and naming no moderator', () => {
    renderGone([REOPEN, REVIEWED]);

    expect(screen.getByText(/Prior moderation actions on this target/)).toBeInTheDocument();
    const items = screen.getAllByRole('listitem').map(li => li.textContent);
    expect(items).toEqual([
      'reopened · 2026-11-02 10:00:00',
      `reviewed · 2026-11-01 10:00:00 by ${MODERATOR}`,
    ]);
  });
});
