// ABOUTME: Chip for an account whose email Keycast says is not confirmed. Shown only for an
// ABOUTME: explicit true; absent, null, non-boolean or a failed lookup mean unknown and show nothing.
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import type { AccountStatusResponse } from '@/lib/adminApi';
import { useAccountStatus } from '@/hooks/useAccountStatus';

export const EMAIL_UNCONFIRMED_LABEL = 'Email not confirmed';
// No numeric limits on purpose: Keycast owns them and they change.
export const EMAIL_UNCONFIRMED_TITLE =
  "This account hasn't confirmed its email. Until it does, Keycast limits how much it can post and report, and it can only send direct messages to Divine HQ and Moderation.";

/** Only a successful lookup that says exactly `true`. Keycast may not send the field yet. */
function isEmailUnconfirmed(accountStatus: AccountStatusResponse | undefined): boolean {
  return accountStatus?.success === true && accountStatus.email_unconfirmed === true;
}

export function EmailUnconfirmedChip({ accountStatus }: { accountStatus: AccountStatusResponse | undefined }) {
  if (!isEmailUnconfirmed(accountStatus)) return null;
  return (
    // Focusable so keyboard users reach the explanation; its own provider so the
    // chip works wherever it's placed.
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span tabIndex={0} className="inline-flex rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <Badge variant="outline" className="border-amber-500 text-amber-700 dark:text-amber-400">
              {EMAIL_UNCONFIRMED_LABEL}
            </Badge>
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-xs">
          <p className="text-xs">{EMAIL_UNCONFIRMED_TITLE}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/** The chip for one pubkey, through the shared account-status query (same cache as the badge). */
export function EmailUnconfirmedChipFor({ pubkey }: { pubkey: string | null | undefined }) {
  const { data } = useAccountStatus(pubkey ?? undefined);
  return <EmailUnconfirmedChip accountStatus={data} />;
}
