// ABOUTME: Badge for what Keycast says about an account (Divine login account or
// ABOUTME: not) and its sign-in state; shared by age review and the report view.
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import type { AccountStatusResponse } from '@/lib/adminApi';
import { deriveAccountIdentity } from '@/lib/accountVerdict';
import { ACCOUNT_TYPE_BADGE } from '@/lib/constants';
import { useAccountStatus } from '@/hooks/useAccountStatus';

interface Props {
  accountStatus: AccountStatusResponse | undefined;
  accountStatusError: boolean;
  accountStatusLoading: boolean;
}

const TYPE_CLASS = {
  divine: 'bg-sky-600 text-white hover:bg-sky-600',
  self_custody: 'bg-muted text-foreground', // informational, not destructive
  unknown: 'bg-muted text-muted-foreground',
} as const;

export function AccountTypeBadge({ accountStatus, accountStatusError, accountStatusLoading }: Props) {
  // Cold load with nothing cached: say so rather than flash "unavailable".
  if (accountStatusLoading && !accountStatus && !accountStatusError) {
    return <span className="text-xs text-muted-foreground">Checking account type…</span>;
  }

  const { accountType, signInStatus } = deriveAccountIdentity(accountStatus, accountStatusError);
  const { label, title } = ACCOUNT_TYPE_BADGE[accountType];
  const signIn =
    signInStatus === 'active' ? 'sign-in active'
    : signInStatus === 'blocked' ? `sign-in blocked (${accountStatus?.status === 'banned' ? 'banned' : 'suspended'})`
    : signInStatus === 'unknown' && accountType === 'divine' ? 'sign-in status unavailable'
    : null;

  return (
    <span className="inline-flex items-center gap-2 flex-wrap">
      {/* Focusable so keyboard users reach the caveat; its own provider so the
          badge works wherever it's placed. */}
      <TooltipProvider delayDuration={150}>
        <Tooltip>
          <TooltipTrigger asChild>
            <span tabIndex={0} className="rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <Badge className={TYPE_CLASS[accountType]}>{label}</Badge>
            </span>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-xs">
            <p className="text-xs">{title}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      {signIn ? <span className="text-xs text-muted-foreground">{signIn}</span> : null}
    </span>
  );
}

const HEX_64 = /^[0-9a-f]{64}$/;

/** The badge for one pubkey, looked up through the shared account-status query. */
export function AccountTypeLabel({ pubkey }: { pubkey: string | null | undefined }) {
  // Lowercase to share age review's cache entry. A report's p tag is written by
  // whoever filed it, so anything but a 64-hex pubkey is never looked up: a path
  // like '../info' would otherwise reach another route that answers success.
  const normalized = pubkey?.toLowerCase();
  const lookup = normalized && HEX_64.test(normalized) ? normalized : undefined;
  const { data, isError, isLoading } = useAccountStatus(lookup);
  if (!pubkey) return null;
  if (!lookup) return <AccountTypeBadge accountStatus={undefined} accountStatusError accountStatusLoading={false} />;
  return <AccountTypeBadge accountStatus={data} accountStatusError={isError} accountStatusLoading={isLoading} />;
}
