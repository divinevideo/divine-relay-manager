import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from './ConfirmDialog';

describe('ConfirmDialog', () => {
  it('shows summary on first click and executes on confirm', async () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        trigger={<button>Action</button>}
        title="Confirm Action"
        summary="Are you sure you want to proceed?"
        onConfirm={onConfirm}
      />
    );

    fireEvent.click(screen.getByText('Action'));
    expect(screen.getByText(/Are you sure/)).toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /Confirm/i }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('does not call onConfirm when cancelled', () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        trigger={<button>Action</button>}
        title="Confirm"
        summary="Summary"
        onConfirm={onConfirm}
      />
    );

    fireEvent.click(screen.getByText('Action'));
    fireEvent.click(screen.getByRole('button', { name: /Cancel/i }));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('shows custom confirm and pending labels', () => {
    render(
      <ConfirmDialog
        trigger={<button>Action</button>}
        title="Ban User"
        summary="This is destructive."
        onConfirm={() => {}}
        confirmLabel="Ban User"
        pendingLabel="Banning..."
        isPending={true}
      />
    );

    fireEvent.click(screen.getByText('Action'));
    expect(screen.getByRole('button', { name: /Banning.../i })).toBeDisabled();
  });

  it('does not throw unhandled rejection when onConfirm fails', async () => {
    const onConfirm = vi.fn().mockRejectedValue(new Error('RPC failed'));
    render(
      <ConfirmDialog
        trigger={<button>Action</button>}
        title="Confirm"
        summary="Summary"
        onConfirm={onConfirm}
        confirmLabel="Do It"
      />
    );

    fireEvent.click(screen.getByText('Action'));
    fireEvent.click(screen.getByRole('button', { name: /Do It/i }));
    await vi.waitFor(() => expect(onConfirm).toHaveBeenCalledOnce());
  });
});
