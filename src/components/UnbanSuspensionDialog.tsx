// ABOUTME: Asks what happens to a timed suspension when a banned and suspended account
// ABOUTME: is unbanned: resume it, end it now, or keep it with no end date.
import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { SUSPENSION_END_UNAVAILABLE } from '@/lib/suspensionEndText';
import {
  formatSuspensionEnd,
  type TimedSuspensionView,
  type UnbanSuspensionChoice,
} from '../../shared/suspension';

interface UnbanSuspensionDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  /** As useTimedSuspension: undefined while unknown (loading or unreadable), null for no timer. */
  record: TimedSuspensionView | null | undefined;
  /**
   * The relay's list confirms the account is suspended. False while that is not
   * known (the list is loading, failed, or unknown): the prompt then asks
   * without stating a suspension as fact.
   */
  suspensionConfirmed: boolean;
  isPending: boolean;
  now?: Date;
  /** The dialog closes once this resolves, and stays open if it throws. */
  onConfirm(choice: UnbanSuspensionChoice): void | Promise<void>;
}

interface Option { value: UnbanSuspensionChoice; label: string }

const END_NOW: Option = { value: 'end_now', label: 'End the suspension now' };
const OPEN_ENDED: Option = { value: 'open_ended', label: 'Keep suspended with no end date' };

/**
 * The options, default first. An end that is unknown (the timers have not
 * answered, could not be read, or hold an end that won't parse) defaults to
 * resume, which keeps whatever end the server has (F5): defaulting to "no end
 * date" there would erase a real end.
 */
function unbanOptions(record: TimedSuspensionView | null | undefined, now: Date): { options: Option[]; endUnknown: boolean } {
  const unknown = { options: [{ value: 'resume' as const, label: 'Resume the suspension as it is' }, END_NOW, OPEN_ENDED], endUnknown: true };
  if (record === undefined) return unknown;
  const endsAt = record?.endsAt;
  if (!endsAt) return { options: [OPEN_ENDED, END_NOW], endUnknown: false };
  const end = new Date(endsAt);
  if (Number.isNaN(end.getTime())) return unknown;
  const resume: Option = end.getTime() > now.getTime()
    ? { value: 'resume', label: `Resume until ${formatSuspensionEnd(endsAt)}` }
    : { value: 'resume', label: 'Resume. The end date has passed, so it lifts at the next check' };
  return { options: [resume, END_NOW, OPEN_ENDED], endUnknown: false };
}

export function UnbanSuspensionDialog(p: UnbanSuspensionDialogProps) {
  return (
    <Dialog open={p.open} onOpenChange={p.onOpenChange}>
      {/* The form lives inside the content, which unmounts on close, so each opening starts fresh. */}
      <DialogContent className="sm:max-w-md">
        <UnbanForm {...p} />
      </DialogContent>
    </Dialog>
  );
}

function UnbanForm({ onOpenChange, record, suspensionConfirmed, isPending, now, onConfirm }: UnbanSuspensionDialogProps) {
  const ids = useId();
  // null until the moderator picks one. The record can arrive while the
  // dialog is open and change the options, so the default is worked out at
  // each render, and a pick the new options no longer offer falls back to it.
  const [picked, setPicked] = useState<UnbanSuspensionChoice | null>(null);
  const { options, endUnknown } = unbanOptions(record, now ?? new Date());
  const selected = options.find((o) => o.value === picked)?.value ?? options[0].value;

  // Confirm is disabled while pending, so a second click cannot send twice.
  const confirm = async () => {
    try {
      await onConfirm(selected);
      onOpenChange(false);
    } catch {
      // The caller has said what went wrong; stay open so the moderator can retry.
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Unban account</DialogTitle>
        <DialogDescription>
          {suspensionConfirmed
            ? 'This account is also suspended. Choose what happens to the suspension when the ban is lifted.'
            : 'This account may also be suspended; its suspension status is not confirmed. Choose what happens to any suspension when the ban is lifted.'}
        </DialogDescription>
      </DialogHeader>

      {endUnknown && <p className="text-sm text-muted-foreground">{SUSPENSION_END_UNAVAILABLE}</p>}

      <RadioGroup
        aria-label="Suspension"
        value={selected}
        onValueChange={(v) => setPicked(v as UnbanSuspensionChoice)}
        disabled={isPending}
      >
        {options.map((o) => (
          <div key={o.value} className="flex items-center gap-2">
            <RadioGroupItem value={o.value} id={`${ids}-${o.value}`} />
            <Label htmlFor={`${ids}-${o.value}`}>{o.label}</Label>
          </div>
        ))}
      </RadioGroup>

      <DialogFooter>
        <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>Cancel</Button>
        <Button onClick={() => void confirm()} disabled={isPending}>{isPending ? 'Unbanning...' : 'Unban'}</Button>
      </DialogFooter>
    </>
  );
}
