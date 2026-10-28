// ABOUTME: Shows the nip05 a profile claims, marked unverified. Nothing here runs the
// ABOUTME: NIP-05 nostr.json check, and any kind 0 can claim any domain, @divine.video included.

import { cn } from '@/lib/utils';
import { displaySafe, isolate } from '@/lib/bidi';

const UNVERIFIED_NOTE = "claimed in this account's profile. Nothing has checked it with the domain, so it does not show the account belongs there.";

/**
 * `wrap` lets a long claim wrap instead of ending in an ellipsis, for tooltip
 * bodies where the full text should be readable. `hoverNote={false}` drops the
 * native hover text where the claim already sits inside a tooltip.
 */
export function ClaimedNip05({ nip05, className, wrap = false, hoverNote = true }: {
  nip05: unknown;
  className?: string;
  wrap?: boolean;
  hoverNote?: boolean;
}) {
  // Profile JSON is author-controlled; render only a real, non-empty string.
  if (typeof nip05 !== 'string' || !nip05.trim()) return null;

  return (
    // The claim is author-written and may carry direction controls; isolating it
    // keeps it from reordering "(unverified)" or the note.
    <span
      className={cn('flex items-baseline gap-1 min-w-0 text-muted-foreground', className)}
      title={hoverNote ? `${isolate(nip05)}: ${UNVERIFIED_NOTE}` : undefined}
    >
      <bdi className={cn('min-w-0', wrap ? 'break-all' : 'truncate')}>{displaySafe(nip05)}</bdi>
      <span className="shrink-0">(unverified)</span>
    </span>
  );
}
