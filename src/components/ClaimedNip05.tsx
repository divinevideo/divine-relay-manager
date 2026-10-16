// ABOUTME: Shows the nip05 a profile claims, marked unverified. Nothing here runs the
// ABOUTME: NIP-05 nostr.json check, and any kind 0 can claim any domain, @divine.video included.

import { cn } from '@/lib/utils';

const UNVERIFIED_NOTE = "claimed in this account's profile. Nothing has checked it with the domain, so it does not show the account belongs there.";

export function ClaimedNip05({ nip05, className }: { nip05: unknown; className?: string }) {
  // Profile JSON is author-controlled; render only a real, non-empty string.
  if (typeof nip05 !== 'string' || !nip05.trim()) return null;

  return (
    <span className={cn('flex items-baseline gap-1 min-w-0 text-muted-foreground', className)} title={`${nip05}: ${UNVERIFIED_NOTE}`}>
      <span className="truncate min-w-0">{nip05}</span>
      <span className="shrink-0">(unverified)</span>
    </span>
  );
}
