// ABOUTME: Pins the unban prompt's options and default for each thing known about the
// ABOUTME: suspension's end, and that confirm sends the choice the moderator selected.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { UnbanSuspensionDialog } from './UnbanSuspensionDialog';
import { ApiError } from '@/lib/adminApi';
import { formatSuspensionEnd, type TimedSuspensionView } from '../../shared/suspension';

type Props = Parameters<typeof UnbanSuspensionDialog>[0];

// Pure rendering against an explicit now, so these fixtures never age.
const NOW = new Date('2026-11-20T12:00:00.000Z');
const FUTURE = '2026-11-23T12:00:00.000Z';
const PAST = '2026-11-19T12:00:00.000Z';
const VERSION = 3;
const record = (endsAt: string | null, status: TimedSuspensionView['status'] = 'cancelled_ban', version = VERSION): TimedSuspensionView => ({
  pubkey: 'a'.repeat(64), endsAt, status, setBy: null, setAt: '2026-11-18T00:00:00.000Z', changedAt: null, version,
});
const CHANGED_NOTICE = 'The suspension changed after this was opened. Check the options below and confirm again.';

function renderDialog(over: Partial<Props> = {}) {
  const props: Props = {
    open: true,
    onOpenChange: vi.fn(),
    record: null,
    suspensionConfirmed: true,
    isPending: false,
    timersLoading: false,
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

  // Under "may also be suspended", a line starting "Suspended." would state the very
  // thing the description says is not confirmed.
  it('says only that the end date is unavailable when the suspension is not confirmed', () => {
    renderDialog({ record: undefined, suspensionConfirmed: false });
    expect(screen.getByText('End date unavailable')).toBeInTheDocument();
    expect(screen.queryByText('Suspended. End date unavailable')).not.toBeInTheDocument();
  });

  // The timer version shown goes with every choice (ask again if it changed): null when no
  // timer was shown, and none when the timers are unknown, as nothing was shown to compare.
  it.each([
    [record(FUTURE), undefined, 'resume', VERSION],
    [record(FUTURE), 'End the suspension now', 'end_now', VERSION],
    [record(FUTURE), 'Keep suspended with no end date', 'open_ended', VERSION],
    [null, undefined, 'open_ended', null],
    [null, 'End the suspension now', 'end_now', null],
    [undefined, undefined, 'resume', undefined],
  ] as const)('confirm sends the selected choice and the shown version (%#)', async (rec, pick, choice, version) => {
    const { props } = renderDialog({ record: rec });
    if (pick) fireEvent.click(screen.getByLabelText(pick));
    fireEvent.click(screen.getByRole('button', { name: 'Unban' }));
    await waitFor(() => expect(props.onConfirm).toHaveBeenCalledWith(choice, version));
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
    await waitFor(() => expect(props.onConfirm).toHaveBeenCalledWith('open_ended', null));
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
    await waitFor(() => expect(props.onConfirm).toHaveBeenCalledWith('open_ended', null));
  });

  it('keeps a choice the moderator made when the record arrives and still offers it', async () => {
    const { props, rerender } = renderDialog({ record: undefined });
    fireEvent.click(screen.getByLabelText('End the suspension now'));
    rerender(<UnbanSuspensionDialog {...props} record={record(FUTURE)} />);
    expect(checkedLabel()).toBe('End the suspension now');
    fireEvent.click(screen.getByRole('button', { name: 'Unban' }));
    await waitFor(() => expect(props.onConfirm).toHaveBeenCalledWith('end_now', VERSION));
  });

  // A worker from before the version was listed sends none, so there is nothing to compare.
  it('sends no version for a record without one', async () => {
    const { props } = renderDialog({ record: { ...record(FUTURE), version: undefined } });
    fireEvent.click(screen.getByRole('button', { name: 'Unban' }));
    await waitFor(() => expect(props.onConfirm).toHaveBeenCalledWith('resume', undefined));
  });

  it('stays open when the unban fails, so the moderator can retry', async () => {
    const { props } = renderDialog({ onConfirm: vi.fn().mockRejectedValue(new Error('relay down')) });
    fireEvent.click(screen.getByRole('button', { name: 'Unban' }));
    await waitFor(() => expect(props.onConfirm).toHaveBeenCalled());
    expect(props.onOpenChange).not.toHaveBeenCalledWith(false);
    expect(screen.queryByText(CHANGED_NOTICE)).not.toBeInTheDocument();
  });

  // The review's case: a cached read showed no timer while another moderator set an end.
  // The worker refuses; the prompt stays open, says so, and shows the current end once the
  // caller's refreshed timer arrives, so the moderator confirms again against it.
  it('after a suspension_changed refusal, stays open, says why, and confirms again against the current timer', async () => {
    const onConfirm = vi.fn()
      .mockRejectedValueOnce(new ApiError('changed', 409, 'Conflict', 'suspension_changed'))
      .mockResolvedValueOnce(undefined);
    const { props, rerender } = renderDialog({ record: null, onConfirm });
    fireEvent.click(screen.getByRole('button', { name: 'Unban' }));
    expect(await screen.findByText(CHANGED_NOTICE)).toBeInTheDocument();
    expect(onConfirm).toHaveBeenLastCalledWith('open_ended', null);
    expect(props.onOpenChange).not.toHaveBeenCalledWith(false);

    rerender(<UnbanSuspensionDialog {...props} record={record(FUTURE, 'cancelled_ban', 4)} />);
    expect(checkedLabel()).toBe(`Resume until ${formatSuspensionEnd(FUTURE)}`);
    expect(screen.getByText(CHANGED_NOTICE)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Unban' }));
    await waitFor(() => expect(onConfirm).toHaveBeenLastCalledWith('resume', 4));
    await waitFor(() => expect(props.onOpenChange).toHaveBeenCalledWith(false));
  });

  it('shows the pending label and blocks a second confirm while the unban runs', () => {
    const { props } = renderDialog({ isPending: true });
    const confirm = screen.getByRole('button', { name: 'Unbanning...' });
    expect(confirm).toBeDisabled();
    fireEvent.click(confirm);
    expect(props.onConfirm).not.toHaveBeenCalled();
  });

  // Pending also covers the timer re-read after a suspension_changed refusal, which can take
  // a retry: the moderator can always close the prompt, as Escape already allows.
  it('keeps Cancel enabled while pending', () => {
    const { props } = renderDialog({ isPending: true });
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    expect(cancel).toBeEnabled();
    fireEvent.click(cancel);
    expect(props.onOpenChange).toHaveBeenCalledWith(false);
  });

  // A confirm before the timers' first read answers would carry no version and skip the
  // check, so it waits. A failed read is not loading: covered by the unknown-end cases above.
  it('blocks confirm while the timers are first loading', () => {
    const { props } = renderDialog({ record: undefined, timersLoading: true });
    const confirm = screen.getByRole('button', { name: 'Unban' });
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
