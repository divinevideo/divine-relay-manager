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
import { isSuspensionChanged } from '@/lib/adminApi';
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
  /**
   * The timers' first read is still running. Confirm waits for it, so a choice is never
   * sent without the version of what it was made against. A read that failed is not
   * loading: the prompt then shows the end as unavailable and sends no version (F5).
   */
  timersLoading: boolean;
  now?: Date;
  /**
   * The dialog closes once this resolves, and stays open if it throws. `shownVersion` is
   * the version of the timer the options were built from: null when no timer was shown,
   * undefined when the timers are unknown (nothing was shown to compare against). The
   * worker refuses the unban when the timer has moved since (`suspension_changed`); the
   * caller then refreshes the timers and this asks again against the current one.
   */
  onConfirm(choice: UnbanSuspensionChoice, shownVersion: number | null | undefined): void | Promise<void>;
}

const CHANGED_NOTICE = 'The suspension changed after this was opened. Check the options below and confirm again.';

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

function UnbanForm({ onOpenChange, record, suspensionConfirmed, isPending, timersLoading, now, onConfirm }: UnbanSuspensionDialogProps) {
  const ids = useId();
  // null until the moderator picks one. The record can arrive while the
  // dialog is open and change the options, so the default is worked out at
  // each render, and a pick the new options no longer offer falls back to it.
  const [picked, setPicked] = useState<UnbanSuspensionChoice | null>(null);
  // Set once the worker refused a choice made against an older timer. It stays for the rest
  // of this opening, so the moderator knows why the options may now read differently.
  const [changed, setChanged] = useState(false);
  const { options, endUnknown } = unbanOptions(record, now ?? new Date());
  const selected = options.find((o) => o.value === picked)?.value ?? options[0].value;
  // A worker that predates listing the version sends none (undefined): nothing to compare.
  const shownVersion = record === undefined ? undefined : record === null ? null : record.version;

  // Confirm is disabled while pending, so a second click cannot send twice. After a
  // suspension_changed refusal the caller re-reads the timers before the mutation settles,
  // so Confirm stays disabled until the current timer (or the failed read) is on screen.
  const confirm = async () => {
    try {
      await onConfirm(selected, shownVersion);
      onOpenChange(false);
    } catch (error) {
      // The caller has said what went wrong; stay open so the moderator can retry.
      if (isSuspensionChanged(error)) {
        setPicked(null);
        setChanged(true);
      }
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

      {changed && <p role="status" className="text-sm font-medium">{CHANGED_NOTICE}</p>}

      {/* Unconfirmed, the description says the account may be suspended, so this line
          must not open with "Suspended." */}
      {endUnknown && (
        <p className="text-sm text-muted-foreground">
          {suspensionConfirmed ? SUSPENSION_END_UNAVAILABLE : 'End date unavailable'}
        </p>
      )}

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
        {/* Always enabled, like Escape: pending also covers the timer re-read after a
            suspension_changed refusal. Closing mid-unban leaves it running; its toast still shows. */}
        <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button onClick={() => void confirm()} disabled={isPending || timersLoading}>{isPending ? 'Unbanning...' : 'Unban'}</Button>
      </DialogFooter>
    </>
  );
}
