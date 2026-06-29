import { useQuery } from "@tanstack/react-query";
import { useAdminApi } from "@/hooks/useAdminApi";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";

function fmt(n: number | null): string {
  return n == null ? "—" : String(n);
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

  const stages: { label: string; value: number | null; sub?: string }[] = [
    { label: "Reports in", value: data.helpdesk.reports_in, sub: "helpdesk" },
    { label: "Requests in", value: data.helpdesk.requests_in, sub: "helpdesk" },
    { label: "Video received", value: data.helpdesk.video_received, sub: "helpdesk" },
    { label: "In progress", value: data.moderation.in_progress, sub: "moderation" },
    { label: "Approved", value: data.moderation.approved.total, sub: `${data.moderation.approved.restored} restored / ${data.moderation.approved.new_minor} new` },
    { label: "Denied / expired", value: data.moderation.denied_expired, sub: "moderation" },
  ];

  return (
    <Card className="p-3">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium">Greenlight: age-review consent funnel</h3>
        <Badge variant="secondary" className="text-xs">13-15</Badge>
      </div>
      <div className="grid grid-cols-3 sm:grid-cols-6 gap-3">
        {stages.map((s) => (
          <div key={s.label} className="rounded-md border p-2">
            <div className="text-xl font-semibold tabular-nums">{fmt(s.value)}</div>
            <div className="text-xs font-medium mt-0.5">{s.label}</div>
            {s.sub && <div className="text-[10px] text-muted-foreground mt-0.5">{s.sub}</div>}
          </div>
        ))}
      </div>
      <div className="text-[10px] text-muted-foreground mt-2">
        Helpdesk stages count all age-review tickets; moderation stages are 13-15 only.
      </div>
    </Card>
  );
}
