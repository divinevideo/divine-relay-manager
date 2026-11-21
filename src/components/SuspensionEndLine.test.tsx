import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { formatSuspensionEnd, type TimedSuspensionView } from '../../shared/suspension';

const listTimedSuspensions = vi.hoisted(() => vi.fn());
vi.mock('@/hooks/useAdminApi', () => ({
  useAdminApi: () => ({ listTimedSuspensions }),
  useApiUrl: () => 'https://api.example',
}));

import { SuspensionEndLine } from './SuspensionEndLine';
import { suspensionEndText } from '@/lib/suspensionEndText';

const PK = 'ab'.repeat(32);
const NOW = new Date('2026-11-21T00:00:00.000Z');
const rec = (endsAt: string | null, over: Partial<TimedSuspensionView> = {}): TimedSuspensionView => ({
  pubkey: PK, endsAt, status: 'active', setBy: null, setAt: '2026-11-20T00:00:00.000Z', changedAt: null, ...over,
});

describe('suspensionEndText', () => {
  it('says it is checking while the list has not answered', () => {
    expect(suspensionEndText({ record: undefined, isError: false, banned: false, now: NOW }))
      .toBe('Checking suspension end date');
  });

  // Review Focus 4: an unreadable list is not "no end date".
  it('says the end date is unavailable when the list could not be read, never "no end date"', () => {
    const text = suspensionEndText({ record: undefined, isError: true, banned: false, now: NOW });
    expect(text).toBe('Suspended. End date unavailable');
    expect(text).not.toMatch(/no end date/i);
  });

  it('puts an unreadable list ahead of every later case', () => {
    // A record cannot sit beside isError from useTimedSuspension today, but the
    // order is the rule: isError wins over a ban and over a dated record.
    expect(suspensionEndText({ record: rec('2026-11-24T14:00:00.000Z'), isError: true, banned: true, now: NOW }))
      .toBe('Suspended. End date unavailable');
  });

  it('says a ban holds the timed suspension when banned with a dated record', () => {
    expect(suspensionEndText({ record: rec('2026-11-24T14:00:00.000Z'), isError: false, banned: true, now: NOW }))
      .toBe('Banned. The timed suspension will not lift while the ban stands');
  });

  it('gives the end for a future end', () => {
    expect(suspensionEndText({ record: rec('2026-11-24T14:00:00.000Z'), isError: false, banned: false, now: NOW }))
      .toBe('Suspended until Tue 24 Nov 2026, 14:00 UTC');
  });

  it('says a passed end lifts at the next check', () => {
    expect(suspensionEndText({ record: rec('2026-11-20T23:00:00.000Z'), isError: false, banned: false, now: NOW }))
      .toBe('End time passed (Fri 20 Nov 2026, 23:00 UTC). Lifts at the next check');
  });

  it('treats an end equal to now as passed', () => {
    expect(suspensionEndText({ record: rec(NOW.toISOString()), isError: false, banned: false, now: NOW }))
      .toBe('End time passed (Sat 21 Nov 2026, 00:00 UTC). Lifts at the next check');
  });

  it('says no end date when the list answered without this account', () => {
    expect(suspensionEndText({ record: null, isError: false, banned: false, now: NOW }))
      .toBe('Suspended, no end date');
  });

  it('says no end date for a record without an end', () => {
    expect(suspensionEndText({ record: rec(null), isError: false, banned: false, now: NOW }))
      .toBe('Suspended, no end date');
  });

  it('does not show the ban line for a banned account without a dated record', () => {
    expect(suspensionEndText({ record: null, isError: false, banned: true, now: NOW }))
      .toBe('Suspended, no end date');
  });

  // The tick lifts only active rows. A cancelled_ban row the screen does not see as banned
  // (the ban list is loading or failed, an unban left the record behind, or only Keycast
  // holds the ban) will not lift, so "Lifts at the next check" would be untrue.
  it.each([
    ['a passed end', '2026-11-20T23:00:00.000Z'],
    ['a future end', '2026-11-24T14:00:00.000Z'],
    ['no end', null],
  ])('says a timer paused by a ban will not lift on its own, for %s', (_label, endsAt) => {
    const text = suspensionEndText({ record: rec(endsAt, { status: 'cancelled_ban' }), isError: false, banned: false, now: NOW });
    expect(text).toBe('Timer paused by a ban, so it will not lift on its own. Use Change end date to restart it');
  });

  it('keeps the ban line for a paused timer while the ban is seen', () => {
    expect(suspensionEndText({
      record: rec('2026-11-20T23:00:00.000Z', { status: 'cancelled_ban' }), isError: false, banned: true, now: NOW,
    })).toBe('Banned. The timed suspension will not lift while the ban stands');
  });

  // An end the UI cannot read is not an end it can show.
  it('says the end date is unavailable for an end it cannot parse', () => {
    expect(suspensionEndText({ record: rec('not-a-date'), isError: false, banned: false, now: NOW }))
      .toBe('Suspended. End date unavailable');
  });
});

describe('SuspensionEndLine', () => {
  beforeEach(() => { listTimedSuspensions.mockReset(); });

  function renderLine(props: { pubkey: string; banned?: boolean }) {
    const qc = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
    return render(<QueryClientProvider client={qc}><SuspensionEndLine {...props} /></QueryClientProvider>);
  }

  it('shows the end of this account\'s timer', async () => {
    // Minute-aligned, three days out: a real-clock literal would expire (F2).
    const endsAt = new Date(Math.ceil((Date.now() + 3 * 86_400_000) / 60_000) * 60_000).toISOString();
    listTimedSuspensions.mockResolvedValue([rec(endsAt)]);
    renderLine({ pubkey: PK });
    expect(screen.getByText('Checking suspension end date')).toBeInTheDocument();
    expect(await screen.findByText(`Suspended until ${formatSuspensionEnd(endsAt)}`)).toBeInTheDocument();
  });

  it('matches the account whatever the case of the pubkey', async () => {
    const endsAt = new Date(Math.ceil((Date.now() + 3 * 86_400_000) / 60_000) * 60_000).toISOString();
    listTimedSuspensions.mockResolvedValue([rec(endsAt)]);
    renderLine({ pubkey: PK.toUpperCase() });
    expect(await screen.findByText(`Suspended until ${formatSuspensionEnd(endsAt)}`)).toBeInTheDocument();
  });

  it('says the end date is unavailable when the list read fails', async () => {
    listTimedSuspensions.mockRejectedValue(new Error('worker down'));
    renderLine({ pubkey: PK });
    expect(await screen.findByText('Suspended. End date unavailable')).toBeInTheDocument();
  });

  it('passes banned through', async () => {
    const endsAt = new Date(Math.ceil((Date.now() + 3 * 86_400_000) / 60_000) * 60_000).toISOString();
    listTimedSuspensions.mockResolvedValue([rec(endsAt, { status: 'cancelled_ban' })]);
    renderLine({ pubkey: PK, banned: true });
    expect(await screen.findByText('Banned. The timed suspension will not lift while the ban stands')).toBeInTheDocument();
  });
});
