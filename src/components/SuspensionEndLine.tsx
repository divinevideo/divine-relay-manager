// ABOUTME: The line under a suspended account that says when its suspension ends,
// ABOUTME: or honestly that the end is still being read or could not be read.
import { useTimedSuspension } from '@/hooks/useTimedSuspensions';
import { suspensionEndText } from '@/lib/suspensionEndText';

export function SuspensionEndLine({ pubkey, banned = false }: { pubkey: string; banned?: boolean }) {
  const { record, isError } = useTimedSuspension(pubkey);
  return (
    <p className="basis-full text-xs text-muted-foreground">
      {suspensionEndText({ record, isError, banned, now: new Date() })}
    </p>
  );
}
