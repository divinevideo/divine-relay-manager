import { useQuery } from "@tanstack/react-query";
import { Info } from "lucide-react";
import { useAdminApi } from "@/hooks/useAdminApi";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { FUNNEL_ZENDESK_QUERIES, TERMINAL_STATES } from "../../shared/age-review";

function fmt(n: number | null): string {
  return n == null ? "—" : String(n);
}

interface Stage {
  label: string;
  value: number | null;
  sub: string;
  // Plain-language meaning of the stage, for a moderator reading the card.
  tip: string;
  // The exact, auditable criteria behind the count. Sourced from the same shared
  // constants the worker counts with, so it cannot drift from what is measured.
  criteria: string;
}

export function AgeReviewFunnel() {
  const api = useAdminApi();
  const { data, isLoading } = useQuery({
    queryKey: ['age-review-funnel', 'age_13_15'],
    queryFn: () => api.getAgeReviewFunnel('age_13_15'),
    staleTime: 60_000,
    refetchInterval: 60_000,
  });

  if (isLoading) {
    return (
      <Card className="p-3">
        <Skeleton className="h-5 w-48 mb-3" />
        <div className="grid grid-cols-3 sm:grid-cols-6 gap-3">
          {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-14" />)}
        </div>
      </Card>
    );
  }

  if (!data?.success) {
    return (
      <Card className="p-3 text-sm text-muted-foreground">
        Funnel data unavailable.
      </Card>
    );
  }

  const stages: Stage[] = [
    {
      label: "Reports in",
      value: data.helpdesk.reports_in,
      sub: "helpdesk",
      tip: "Third-party reports of a suspected underage account, filed in-app and routed to the helpdesk. Counts all ages, not just 13-15.",
      criteria: `Zendesk · ${FUNNEL_ZENDESK_QUERIES.reports_in}`,
    },
    {
      label: "Requests in",
      value: data.helpdesk.requests_in,
      sub: "helpdesk",
      tip: "A parent or teen who contacted the helpdesk themselves to verify consent. Counts all ages, not just 13-15.",
      criteria: `Zendesk · ${FUNNEL_ZENDESK_QUERIES.requests_in}`,
    },
    {
      label: "Video received",
      value: data.helpdesk.video_received,
      sub: "helpdesk",
      tip: "A consent verification video arrived (attachment or link), flagged by the consent_video_received macro. Counts all ages.",
      criteria: `Zendesk · ${FUNNEL_ZENDESK_QUERIES.video_received}`,
    },
    {
      label: "In progress",
      value: data.moderation.in_progress,
      sub: "moderation",
      tip: "Open 13-15 moderation case, not yet resolved: under review, awaiting user / parent / support response, submitted, or needs follow-up.",
      criteria: `D1 age_review_cases · band age_13_15 · state ∉ {${TERMINAL_STATES.join(", ")}}`,
    },
    {
      label: "Approved",
      value: data.moderation.approved.total,
      sub: `${data.moderation.approved.restored} restored / ${data.moderation.approved.new_minor} new`,
      tip: "13-15 account authorized. Restored = an existing account cleared; new = a brand-new approved minor account created via onboarding.",
      criteria: "D1 · band age_13_15 · state cleared · new = created_via minor_onboarding",
    },
    {
      label: "Denied / expired",
      value: data.moderation.denied_expired,
      sub: "moderation",
      tip: "13-15 case closed without approval, or the 15-day consent clock lapsed.",
      criteria: "D1 · band age_13_15 · state denied_closed",
    },
  ];

  return (
    <Card className="p-3">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium">Greenlight: age-review consent funnel</h3>
        <Badge variant="secondary" className="text-xs">13-15</Badge>
      </div>
      <TooltipProvider delayDuration={150}>
        <div className="grid grid-cols-3 sm:grid-cols-6 gap-3">
          {stages.map((s) => (
            <Tooltip key={s.label}>
              <TooltipTrigger asChild>
                <div
                  tabIndex={0}
                  className="rounded-md border p-2 cursor-help focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <div className="text-xl font-semibold tabular-nums">{fmt(s.value)}</div>
                  <div className="flex items-center gap-1 mt-0.5">
                    <span className="text-xs font-medium">{s.label}</span>
                    <Info className="h-3 w-3 text-muted-foreground/60 shrink-0" />
                  </div>
                  <div className="text-[10px] text-muted-foreground mt-0.5">{s.sub}</div>
                </div>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-xs">
                <p className="text-xs">{s.tip}</p>
                <p className="text-[10px] font-mono text-muted-foreground mt-1 break-words">{s.criteria}</p>
              </TooltipContent>
            </Tooltip>
          ))}
        </div>
      </TooltipProvider>
      <div className="text-[10px] text-muted-foreground mt-2">
        Helpdesk stages count all age-review tickets; moderation stages are 13-15 only.
      </div>
    </Card>
  );
}
