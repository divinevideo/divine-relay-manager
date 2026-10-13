import { useState, type ReactNode } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';

interface ConfirmDialogProps {
  trigger: ReactNode;
  title: string;
  summary: string;
  onConfirm: () => void | Promise<void>;
  confirmLabel?: string;
  pendingLabel?: string;
  isPending?: boolean;
  /** Confirm-button style. Destructive by default; `approve` for a positive, consequential action. */
  confirmVariant?: 'destructive' | 'approve';
}

const CONFIRM_CLASSES: Record<NonNullable<ConfirmDialogProps['confirmVariant']>, string> = {
  destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
  approve: 'bg-green-600 text-white hover:bg-green-700',
};

export function ConfirmDialog({
  trigger,
  title,
  summary,
  onConfirm,
  confirmLabel = 'Confirm',
  pendingLabel = 'Processing...',
  isPending = false,
  confirmVariant = 'destructive',
}: ConfirmDialogProps) {
  const [open, setOpen] = useState(false);

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{summary}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={async (e) => {
              e.preventDefault();
              try {
                await onConfirm();
                setOpen(false);
              } catch {
                // Dialog stays open so the user can retry.
              }
            }}
            className={CONFIRM_CLASSES[confirmVariant]}
            disabled={isPending}
          >
            {isPending ? pendingLabel : confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
