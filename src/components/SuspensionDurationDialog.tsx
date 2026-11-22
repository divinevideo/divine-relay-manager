// ABOUTME: Asks how long to suspend an account for, or what its new end should be,
// ABOUTME: and previews the end. The worker checks the same rule (checkSuspensionDuration).
import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { SUSPENSION_END_UNAVAILABLE } from '@/lib/suspensionEndText';
import {
  checkSuspensionDuration,
  DURATION_ERROR,
  formatSuspensionEnd,
  suspensionEndsAt,
  type SuspensionDuration,
  type SuspensionUnit,
} from '../../shared/suspension';

interface SuspensionDurationDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  mode: 'suspend' | 'change';
  /** Change mode: the end now. null is a suspension with no end; undefined is not known, and leaves the line out. */
  currentEndsAt?: string | null;
  isPending: boolean;
  /** null: no end date (suspend mode only). The dialog closes once this resolves, and stays open if it throws. */
  onConfirm(duration: SuspensionDuration | null): void | Promise<void>;
}

// An end that won't parse is unknown, so it gets the end line's words rather
// than a formatted "NaN" date.
function currentLine(currentEndsAt: string | null): string {
  if (!currentEndsAt) return 'Currently: no end date';
  if (Number.isNaN(new Date(currentEndsAt).getTime())) return SUSPENSION_END_UNAVAILABLE;
  return `Currently: ${formatSuspensionEnd(currentEndsAt)}`;
}

export function SuspensionDurationDialog(p: SuspensionDurationDialogProps) {
  // Without a "Currently" line there is no description; say so, so Radix does
  // not point aria-describedby at nothing.
  const described = p.mode === 'change' && p.currentEndsAt !== undefined;
  return (
    <Dialog open={p.open} onOpenChange={p.onOpenChange}>
      {/* The form lives inside the content, which unmounts on close, so each opening starts fresh. */}
      <DialogContent className="sm:max-w-md" {...(described ? {} : { 'aria-describedby': undefined })}>
        <DurationForm {...p} />
      </DialogContent>
    </Dialog>
  );
}

function DurationForm({ onOpenChange, mode, currentEndsAt, isPending, onConfirm }: SuspensionDurationDialogProps) {
  const ids = useId();
  const [length, setLength] = useState('');
  const [unit, setUnit] = useState<SuspensionUnit>('days');
  const [noEnd, setNoEnd] = useState(false);

  const openEnded = mode === 'suspend' && noEnd;
  // An empty field is not a number: Number('') is 0, which the rule would
  // reject anyway, but say so explicitly rather than lean on that.
  const checked = length.trim() === ''
    ? { ok: false as const }
    : checkSuspensionDuration({ value: Number(length), unit });
  const valid = openEnded || checked.ok;

  const confirm = async () => {
    if (!valid || isPending) return;
    try {
      await onConfirm(openEnded ? null : (checked as { ok: true; duration: SuspensionDuration }).duration);
      onOpenChange(false);
    } catch {
      // The caller has said what went wrong; stay open so the moderator can retry.
    }
  };

  const title = mode === 'suspend' ? 'Suspend account' : 'Change end date';
  const confirmLabel = mode === 'suspend'
    ? (isPending ? 'Suspending...' : 'Suspend')
    : (isPending ? 'Saving...' : 'Change end date');

  return (
    <>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        {mode === 'change' && currentEndsAt !== undefined && (
          <DialogDescription>{currentLine(currentEndsAt)}</DialogDescription>
        )}
      </DialogHeader>

      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor={`${ids}-length`}>Length</Label>
          <div className="flex gap-2">
            <Input
              id={`${ids}-length`}
              type="number"
              inputMode="numeric"
              min={1}
              step={1}
              value={length}
              onChange={(e) => setLength(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void confirm(); }}
              disabled={openEnded || isPending}
              className="w-28"
              autoFocus
            />
            <select
              aria-label="Unit"
              value={unit}
              onChange={(e) => setUnit(e.target.value as SuspensionUnit)}
              disabled={openEnded || isPending}
              className="h-10 rounded-md border border-input bg-background px-3 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <option value="hours">Hours</option>
              <option value="days">Days</option>
            </select>
          </div>
        </div>

        {mode === 'suspend' && (
          <div className="flex items-center gap-2">
            <Checkbox
              id={`${ids}-no-end`}
              checked={noEnd}
              onCheckedChange={(v) => setNoEnd(v === true)}
              disabled={isPending}
            />
            <Label htmlFor={`${ids}-no-end`}>No end date</Label>
          </div>
        )}

        {!openEnded && (
          checked.ok ? (
            <p className="text-sm">Ends {formatSuspensionEnd(suspensionEndsAt(checked.duration, new Date()))}</p>
          ) : (
            // Empty is not wrong yet, so it reads as the instruction it is; a value
            // that breaks the rule is marked as an error.
            <p className={cn('text-sm', length.trim() === '' ? 'text-muted-foreground' : 'text-destructive')}>
              {DURATION_ERROR}
            </p>
          )
        )}
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>Cancel</Button>
        <Button onClick={() => void confirm()} disabled={!valid || isPending}>{confirmLabel}</Button>
      </DialogFooter>
    </>
  );
}
