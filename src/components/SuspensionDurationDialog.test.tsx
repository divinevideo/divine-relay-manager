import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SuspensionDurationDialog } from './SuspensionDurationDialog';
import { DURATION_ERROR, formatSuspensionEnd, suspensionEndsAt } from '../../shared/suspension';

type Props = Parameters<typeof SuspensionDurationDialog>[0];

function renderDialog(over: Partial<Props> = {}) {
  const props: Props = {
    open: true,
    onOpenChange: vi.fn(),
    mode: 'suspend',
    isPending: false,
    onConfirm: vi.fn(),
    ...over,
  };
  render(<SuspensionDurationDialog {...props} />);
  return props;
}

const length = () => screen.getByLabelText('Length');
const unit = () => screen.getByRole('combobox', { name: 'Unit' });
const setLength = (v: string) => fireEvent.change(length(), { target: { value: v } });

describe('SuspensionDurationDialog', () => {
  it('titles the suspend dialog and confirms a 3 day suspension', async () => {
    const props = renderDialog();
    expect(screen.getByRole('heading', { name: 'Suspend account' })).toBeInTheDocument();
    expect(unit()).toHaveValue('days');
    setLength('3');
    fireEvent.click(screen.getByRole('button', { name: 'Suspend' }));
    await waitFor(() => expect(props.onConfirm).toHaveBeenCalledWith({ value: 3, unit: 'days' }));
  });

  it.each(['0', '1.5', '-2', '366', ''])('disables confirm and shows the duration rule for %j days', (value) => {
    renderDialog();
    setLength(value);
    expect(screen.getByRole('button', { name: 'Suspend' })).toBeDisabled();
    expect(screen.getByText(DURATION_ERROR)).toBeInTheDocument();
    expect(screen.queryByText(/^Ends /)).not.toBeInTheDocument();
  });

  it('enables confirm for 3 days and previews the end', () => {
    // The preview reads the clock at render, so it is one of the two values
    // computed either side of it (they differ only if a minute turns over).
    const ends = () => `Ends ${formatSuspensionEnd(suspensionEndsAt({ value: 3, unit: 'days' }, new Date()))}`;
    const before = ends();
    renderDialog();
    setLength('3');
    const after = ends();
    expect(screen.getByRole('button', { name: 'Suspend' })).toBeEnabled();
    expect(screen.queryByText(DURATION_ERROR)).not.toBeInTheDocument();
    expect([before, after]).toContain(screen.getByText(/^Ends /).textContent);
  });

  it('checks the range in the unit chosen: 366 hours is allowed, 366 days is not', () => {
    renderDialog();
    setLength('366');
    expect(screen.getByRole('button', { name: 'Suspend' })).toBeDisabled();
    fireEvent.change(unit(), { target: { value: 'hours' } });
    expect(screen.getByRole('button', { name: 'Suspend' })).toBeEnabled();
  });

  it('confirms in hours when Hours is chosen', async () => {
    const props = renderDialog();
    fireEvent.change(unit(), { target: { value: 'hours' } });
    setLength('12');
    fireEvent.click(screen.getByRole('button', { name: 'Suspend' }));
    await waitFor(() => expect(props.onConfirm).toHaveBeenCalledWith({ value: 12, unit: 'hours' }));
  });

  it('No end date disables the length fields and confirms with null', async () => {
    const props = renderDialog();
    setLength('0');
    fireEvent.click(screen.getByRole('checkbox', { name: 'No end date' }));
    expect(length()).toBeDisabled();
    expect(unit()).toBeDisabled();
    // The invalid length no longer matters.
    expect(screen.queryByText(DURATION_ERROR)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Suspend' }));
    await waitFor(() => expect(props.onConfirm).toHaveBeenCalledWith(null));
  });

  it('shows the pending label and disables confirm while pending', () => {
    renderDialog({ isPending: true });
    setLength('3');
    expect(screen.getByRole('button', { name: 'Suspending...' })).toBeDisabled();
  });

  it('closes after a confirm that succeeds', async () => {
    const props = renderDialog({ onConfirm: vi.fn().mockResolvedValue(undefined) });
    setLength('3');
    fireEvent.click(screen.getByRole('button', { name: 'Suspend' }));
    await waitFor(() => expect(props.onOpenChange).toHaveBeenCalledWith(false));
  });

  it('stays open after a confirm that fails, so the moderator can retry', async () => {
    const props = renderDialog({ onConfirm: vi.fn().mockRejectedValue(new Error('refused')) });
    setLength('3');
    fireEvent.click(screen.getByRole('button', { name: 'Suspend' }));
    await waitFor(() => expect(props.onConfirm).toHaveBeenCalled());
    expect(props.onOpenChange).not.toHaveBeenCalledWith(false);
  });

  describe('change mode', () => {
    it('has its own title, confirm label and no No end date', async () => {
      const props = renderDialog({ mode: 'change', currentEndsAt: '2026-11-24T14:00:00.000Z' });
      expect(screen.getByRole('heading', { name: 'Change end date' })).toBeInTheDocument();
      expect(screen.queryByRole('checkbox', { name: 'No end date' })).not.toBeInTheDocument();
      expect(screen.getByText('Currently: Tue 24 Nov 2026, 14:00 UTC')).toBeInTheDocument();
      fireEvent.change(unit(), { target: { value: 'hours' } });
      setLength('12');
      fireEvent.click(screen.getByRole('button', { name: 'Change end date' }));
      await waitFor(() => expect(props.onConfirm).toHaveBeenCalledWith({ value: 12, unit: 'hours' }));
    });

    it('says "no end date" for a suspension without one', () => {
      renderDialog({ mode: 'change', currentEndsAt: null });
      expect(screen.getByText('Currently: no end date')).toBeInTheDocument();
    });

    // Unknown is not "no end date": the line is left out rather than guessed.
    it('leaves the Currently line out when the end is not known', () => {
      renderDialog({ mode: 'change', currentEndsAt: undefined });
      expect(screen.queryByText(/^Currently:/)).not.toBeInTheDocument();
    });

    // An end the dialog can't read is unknown, not a date: same words as the end line.
    it('says the end date is unavailable for an end it cannot parse', () => {
      renderDialog({ mode: 'change', currentEndsAt: 'not-a-date' });
      expect(screen.getByText('Suspended. End date unavailable')).toBeInTheDocument();
      expect(screen.queryByText(/NaN|undefined/)).not.toBeInTheDocument();
    });

    it('shows Saving... while pending', () => {
      renderDialog({ mode: 'change', isPending: true });
      expect(screen.getByRole('button', { name: 'Saving...' })).toBeDisabled();
    });
  });
});
