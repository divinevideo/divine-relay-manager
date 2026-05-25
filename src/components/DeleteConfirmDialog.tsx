import { type ComponentProps } from 'react';
import { ConfirmDialog } from './ConfirmDialog';

export function DeleteConfirmDialog(props: ComponentProps<typeof ConfirmDialog>) {
  return (
    <ConfirmDialog
      confirmLabel="Confirm Delete"
      pendingLabel="Deleting..."
      {...props}
    />
  );
}
