// ABOUTME: Pins the unban prompt's options and default for each thing known about the
// ABOUTME: suspension's end, and that confirm sends the choice the moderator selected.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { UnbanSuspensionDialog } from './UnbanSuspensionDialog';
import { formatSuspensionEnd, type TimedSuspensionView } from '../../shared/suspension';

type Props = Parameters<typeof UnbanSuspensionDialog>[0];

// Pure rendering against an explicit now, so these fixtures never age.
const NOW = new Date('2026-11-20T12:00:00.000Z');
const FUTURE = '2026-11-23T12:00:00.000Z';
const PAST = '2026-11-19T12:00:00.000Z';
const record = (endsAt: string | null, status: TimedSuspensionView['status'] = 'cancelled_ban'): TimedSuspensionView => ({
  pubkey: 'a'.repeat(64), endsAt, status, setBy: null, setAt: '2026-11-18T00:00:00.000Z', changedAt: null,
});

function renderDialog(over: Partial<Props> = {}) {
  const props: Props = {
    open: true,
    onOpenChange: vi.fn(),
    record: null,
    suspensionConfirmed: true,
    isPending: false,
    now: NOW,
    onConfirm: vi.fn(),
    ...over,
  };
  const view = render(<UnbanSuspensionDialog {...props} />);
  return { props, ...view };
}

function labelOf(radio: HTMLElement): string {
  return document.querySelector(`label[for="${radio.id}"]`)?.textContent ?? '';
}
const optionLabels = () => screen.getAllByRole('radio').map(labelOf);
const checkedLabel = () => labelOf(screen.getAllByRole('radio').find((r) => r.getAttribute('aria-checked') === 'true')!);

describe('UnbanSuspensionDialog', () => {
  it('titles and explains the prompt', () => {
    renderDialog();
    expect(screen.getByRole('heading', { name: 'Unban account' })).toBeInTheDocument();
    expect(screen.getByText('This account is also suspended. Choose what happens to the suspension when the ban is lifted.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Unban' })).toBeEnabled();
  });

  // The relay's list has not confirmed the suspension (still loading, failed,
  // or unknown): the prompt must not state it as fact.
  it('says the suspension is not confirmed when it is not', () => {
    renderDialog({ suspensionConfirmed: false });
    expect(screen.getByText('This account may also be suspended; its suspension status is not confirmed. Choose what happens to any suspension when the ban is lifted.')).toBeInTheDocument();
    expect(screen.queryByText('This account is also suspended. Choose what happens to the suspension when the ban is lifted.')).not.toBeInTheDocument();
  });

  it('with an end still ahead, offers resume until it first, then end now, then no end date', () => {
    renderDialog({ record: record(FUTURE) });
    expect(optionLabels()).toEqual([
      `Resume until ${formatSuspensionEnd(FUTURE)}`,
      'End the suspension now',
      'Keep suspended with no end date',
    ]);
    expect(checkedLabel()).toBe(`Resume until ${formatSuspensionEnd(FUTURE)}`);
  });

  it('with an end that has passed, says resume lifts at the next check', () => {
    renderDialog({ record: record(PAST) });
    expect(optionLabels()).toEqual([
      'Resume. The end date has passed, so it lifts at the next check',
      'End the suspension now',
      'Keep suspended with no end date',
    ]);
    expect(checkedLabel()).toBe('Resume. The end date has passed, so it lifts at the next check');
  });

  it.each([
    ['no record', null],
    ['a record with no end', record(null)],
  ] as const)('with %s, offers no end date first, then end now', (_name, rec) => {
    renderDialog({ record: rec });
    expect(optionLabels()).toEqual(['Keep suspended with no end date', 'End the suspension now']);
    expect(checkedLabel()).toBe('Keep suspended with no end date');
    expect(screen.queryByText('Suspended. End date unavailable')).not.toBeInTheDocument();
  });

  // F5: an unknown end must never default to "no end date", which would erase
  // a real end. Resume keeps whatever end the server has.
  it.each([
    ['the timers have not answered or could not be read', undefined],
    ['the end cannot be read', record('not-a-date')],
  ] as const)('when %s, defaults to resume as it is and says the end is unavailable', (_name, rec) => {
    renderDialog({ record: rec });
    expect(optionLabels()).toEqual([
      'Resume the suspension as it is',
      'End the suspension now',
      'Keep suspended with no end date',
    ]);
    expect(checkedLabel()).toBe('Resume the suspension as it is');
    expect(screen.getByText('Suspended. End date unavailable')).toBeInTheDocument();
  });

  it.each([
    [record(FUTURE), undefined, 'resume'],
    [record(FUTURE), 'End the suspension now', 'end_now'],
    [record(FUTURE), 'Keep suspended with no end date', 'open_ended'],
    [null, undefined, 'open_ended'],
    [null, 'End the suspension now', 'end_now'],
    [undefined, undefined, 'resume'],
  ] as const)('confirm sends the selected choice (%#)', async (rec, pick, choice) => {
    const { props } = renderDialog({ record: rec });
    if (pick) fireEvent.click(screen.getByLabelText(pick));
    fireEvent.click(screen.getByRole('button', { name: 'Unban' }));
    await waitFor(() => expect(props.onConfirm).toHaveBeenCalledWith(choice));
    expect(props.onConfirm).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(props.onOpenChange).toHaveBeenCalledWith(false));
  });

  // The record can arrive while the prompt is open: the default follows it, and
  // never lands on a choice the new options do not offer.
  it('moves the default when the record arrives with options that drop it', async () => {
    const { props, rerender } = renderDialog({ record: undefined });
    expect(checkedLabel()).toBe('Resume the suspension as it is');
    rerender(<UnbanSuspensionDialog {...props} record={null} />);
    expect(checkedLabel()).toBe('Keep suspended with no end date');
    fireEvent.click(screen.getByRole('button', { name: 'Unban' }));
    await waitFor(() => expect(props.onConfirm).toHaveBeenCalledWith('open_ended'));
  });

  // A pick the new options no longer offer would check nothing on screen and
  // still be sent: it falls back to the new default instead.
  it('drops a pick the arriving record no longer offers', async () => {
    const { props, rerender } = renderDialog({ record: undefined });
    // Away and back: clicking the option already checked is not a pick.
    fireEvent.click(screen.getByLabelText('End the suspension now'));
    fireEvent.click(screen.getByLabelText('Resume the suspension as it is'));
    rerender(<UnbanSuspensionDialog {...props} record={null} />);
    expect(checkedLabel()).toBe('Keep suspended with no end date');
    fireEvent.click(screen.getByRole('button', { name: 'Unban' }));
    await waitFor(() => expect(props.onConfirm).toHaveBeenCalledWith('open_ended'));
  });

  it('keeps a choice the moderator made when the record arrives and still offers it', async () => {
    const { props, rerender } = renderDialog({ record: undefined });
    fireEvent.click(screen.getByLabelText('End the suspension now'));
    rerender(<UnbanSuspensionDialog {...props} record={record(FUTURE)} />);
    expect(checkedLabel()).toBe('End the suspension now');
    fireEvent.click(screen.getByRole('button', { name: 'Unban' }));
    await waitFor(() => expect(props.onConfirm).toHaveBeenCalledWith('end_now'));
  });

  it('stays open when the unban fails, so the moderator can retry', async () => {
    const { props } = renderDialog({ onConfirm: vi.fn().mockRejectedValue(new Error('relay down')) });
    fireEvent.click(screen.getByRole('button', { name: 'Unban' }));
    await waitFor(() => expect(props.onConfirm).toHaveBeenCalled());
    expect(props.onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it('shows the pending label and blocks a second confirm while the unban runs', () => {
    const { props } = renderDialog({ isPending: true });
    const confirm = screen.getByRole('button', { name: 'Unbanning...' });
    expect(confirm).toBeDisabled();
    fireEvent.click(confirm);
    expect(props.onConfirm).not.toHaveBeenCalled();
  });

  it('cancel closes without unbanning', () => {
    const { props } = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(props.onOpenChange).toHaveBeenCalledWith(false);
    expect(props.onConfirm).not.toHaveBeenCalled();
  });

  it('reads the clock when no now is given', () => {
    const ahead = new Date(Date.now() + 3 * 86_400_000).toISOString();
    renderDialog({ record: record(ahead), now: undefined });
    expect(checkedLabel()).toBe(`Resume until ${formatSuspensionEnd(ahead)}`);
  });
});
