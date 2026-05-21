import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DeleteConfirmDialog } from './DeleteConfirmDialog';

describe('DeleteConfirmDialog', () => {
  it('shows summary on first click and executes on confirm', async () => {
    const onConfirm = vi.fn();
    render(
      <DeleteConfirmDialog
        trigger={<button>Delete</button>}
        title="Delete User Content"
        summary="This will permanently delete 5 events and 3 media files."
        onConfirm={onConfirm}
      />
    );

    fireEvent.click(screen.getByText('Delete'));
    expect(screen.getByText(/permanently delete 5 events/)).toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /Confirm Delete/i }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('does not call onConfirm when cancelled', () => {
    const onConfirm = vi.fn();
    render(
      <DeleteConfirmDialog
        trigger={<button>Delete</button>}
        title="Delete"
        summary="Gone forever."
        onConfirm={onConfirm}
      />
    );

    fireEvent.click(screen.getByText('Delete'));
    fireEvent.click(screen.getByRole('button', { name: /Cancel/i }));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('shows custom confirm label', () => {
    render(
      <DeleteConfirmDialog
        trigger={<button>Delete</button>}
        title="Delete"
        summary="Summary"
        onConfirm={() => {}}
        confirmLabel="Yes, Nuke It"
      />
    );

    fireEvent.click(screen.getByText('Delete'));
    expect(screen.getByRole('button', { name: /Yes, Nuke It/i })).toBeInTheDocument();
  });

  it('shows pending state', () => {
    render(
      <DeleteConfirmDialog
        trigger={<button>Delete</button>}
        title="Delete"
        summary="Summary"
        onConfirm={() => {}}
        isPending={true}
      />
    );

    fireEvent.click(screen.getByText('Delete'));
    expect(screen.getByRole('button', { name: /Deleting.../i })).toBeDisabled();
  });
});
