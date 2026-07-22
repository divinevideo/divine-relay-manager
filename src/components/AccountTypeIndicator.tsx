// ABOUTME: Moderator-facing indicator of a target's account type and what
// ABOUTME: enforcement is actually effective, plus a partial compliance checklist.
import { Badge } from '@/components/ui/badge';
import type { AccountStatusResponse } from '@/lib/adminApi';
import { deriveAccountVerdict, type LegState } from '@/lib/accountVerdict';

interface Props {
  accountStatus: AccountStatusResponse | undefined;
  accountStatusError: boolean;
  postCount: number | undefined;
  ticketLinked: boolean;
}

const TYPE_LABEL = {
  divine: 'Divine account',
  self_custody: 'Self-custody (not in keycast)',
  unknown: 'Account status unavailable',
} as const;

const TYPE_CLASS = {
  divine: 'bg-sky-600 text-white hover:bg-sky-600',
  self_custody: 'bg-muted text-foreground', // informational, not destructive
  unknown: 'bg-muted text-muted-foreground',
} as const;

const LEG_LABEL: Record<LegState, string> = {
  done: 'done',
  missing: 'missing',
  na: 'n/a',
  not_tracked: 'not tracked yet',
};

const LEG_CLASS: Record<LegState, string> = {
  done: 'text-emerald-600',
  missing: 'text-amber-600 font-medium',
  na: 'text-muted-foreground',
  not_tracked: 'text-muted-foreground italic',
};

export function AccountTypeIndicator({ accountStatus, accountStatusError, postCount, ticketLinked }: Props) {
  const v = deriveAccountVerdict({ accountStatus, accountStatusError, postCount, ticketLinked });

  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex items-center gap-2 flex-wrap">
        <Badge className={TYPE_CLASS[v.accountType]}>{TYPE_LABEL[v.accountType]}</Badge>
        {v.accountType === 'divine' ? (
          <span className="text-xs text-muted-foreground">
            {v.suspended ? 'sign-in suspended' : 'sign-in active'}
          </span>
        ) : null}
      </div>

      {v.contentPresence === 'hidden_suspended' ? (
        <p className="text-xs text-muted-foreground">
          No visible content, but the account is suspended — content may be hidden by our enforcement (viewer coming).
        </p>
      ) : null}

      <ul className="text-xs space-y-0.5">
        {v.legs.map((leg) => (
          <li key={leg.key} className="flex justify-between gap-2">
            <span className="text-muted-foreground">{leg.label}</span>
            <span className={LEG_CLASS[leg.state]}>{LEG_LABEL[leg.state]}</span>
          </li>
        ))}
      </ul>

      <p className="text-sm font-medium">{v.verdict}</p>
    </div>
  );
}
