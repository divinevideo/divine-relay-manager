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
}

export function ConfirmDialog({
  trigger,
  title,
  summary,
  onConfirm,
  confirmLabel = 'Confirm',
  pendingLabel = 'Processing...',
  isPending = false,
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
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            disabled={isPending}
          >
            {isPending ? pendingLabel : confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
