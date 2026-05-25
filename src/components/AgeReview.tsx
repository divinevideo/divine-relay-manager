import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAdminApi } from "@/hooks/useAdminApi";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Clock, RefreshCw, Filter, AlertTriangle } from "lucide-react";
import { AgeReviewDetail } from "@/components/AgeReviewDetail";
import { UserIdentifier } from "@/components/UserIdentifier";
import { useIsMobile } from "@/hooks/useIsMobile";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import {
  AGE_BANDS,
  TERMINAL_STATES,
  getDaysRemaining,
  type AgeReviewState,
  type AgeBand,
} from "../../shared/age-review";

const BAND_LABELS: Record<AgeBand, string> = {
  under_13: "Under 13",
  age_13_15: "13–15",
  age_16_plus_claimed: "16+",
};

const STATE_SHORT: Record<AgeReviewState, string> = {
  open_reported: "Open",
  under_moderator_review: "In Review",
  restricted_pending_user_response: "Pending User",
  restricted_pending_parental_consent: "Pending Parent",
  restricted_pending_support_email: "Pending Email",
  submitted_for_review: "Submitted",
  needs_follow_up: "Follow-up",
  cleared: "Cleared",
  denied_closed: "Denied",
};

type FilterMode = 'active' | 'closed' | 'all';

export function AgeReview() {
  const api = useAdminApi();
  const isMobile = useIsMobile();
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null);
  const [filterMode, setFilterMode] = useState<FilterMode>('active');
  const [bandFilter, setBandFilter] = useState<string>('all');

  const serverParams = useMemo(() => {
    const params: { state?: string; age_band?: string } = {};
    if (filterMode !== 'all') params.state = filterMode;
    if (bandFilter !== 'all') params.age_band = bandFilter;
    return params;
  }, [filterMode, bandFilter]);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['age-review-cases', serverParams],
    queryFn: () => api.getAgeReviewCases(serverParams),
    staleTime: 30_000,
    refetchInterval: 30_000,
  });

  const filteredCases = data?.cases ?? [];

  const selectedCase = filteredCases.find(c => c.id === selectedCaseId) ?? null;

  const { data: activeData } = useQuery({
    queryKey: ['age-review-cases', { state: 'active' }],
    queryFn: () => api.getAgeReviewCases({ state: 'active' }),
    staleTime: 30_000,
    refetchInterval: 30_000,
  });

  const activeCounts = useMemo(() => {
    if (!activeData?.cases) return { total: 0, urgent: 0 };
    const urgent = activeData.cases.filter(c => {
      const days = getDaysRemaining(c);
      return days != null && days <= 2 && !c.clock_paused;
    });
    return { total: activeData.cases.length, urgent: urgent.length };
  }, [activeData?.cases]);

  const listContent = (
    <div className="flex flex-col h-full">
      {/* Filter bar */}
      <div className="shrink-0 p-3 space-y-2 border-b">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Clock className="h-4 w-4" />
            <span className="font-medium text-sm">
              Age Review
              {activeCounts.total > 0 && (
                <Badge variant="secondary" className="ml-1.5 text-xs">{activeCounts.total}</Badge>
              )}
              {activeCounts.urgent > 0 && (
                <Badge variant="destructive" className="ml-1 text-xs gap-0.5">
                  <AlertTriangle className="h-2.5 w-2.5" />
                  {activeCounts.urgent}
                </Badge>
              )}
            </span>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => refetch()}
            className="h-7"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </div>

        <div className="flex gap-2">
          <Tabs value={filterMode} onValueChange={(v) => setFilterMode(v as FilterMode)} className="flex-1">
            <TabsList className="h-7 w-full">
              <TabsTrigger value="active" className="text-xs h-6 flex-1">Active</TabsTrigger>
              <TabsTrigger value="closed" className="text-xs h-6 flex-1">Closed</TabsTrigger>
              <TabsTrigger value="all" className="text-xs h-6 flex-1">All</TabsTrigger>
            </TabsList>
          </Tabs>

          <Select value={bandFilter} onValueChange={setBandFilter}>
            <SelectTrigger className="h-7 w-24 text-xs">
              <Filter className="h-3 w-3 mr-1" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all" className="text-xs">All ages</SelectItem>
              {AGE_BANDS.map((band) => (
                <SelectItem key={band} value={band} className="text-xs">
                  {BAND_LABELS[band]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Case list */}
      <ScrollArea className="flex-1">
        {isLoading ? (
          <div className="p-3 space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        ) : isError ? (
          <div className="p-3 text-sm text-red-600">Failed to load cases</div>
        ) : filteredCases.length === 0 ? (
          <div className="p-6 text-center text-sm text-muted-foreground">
            No {filterMode === 'all' ? '' : filterMode} cases
          </div>
        ) : (
          <div className="divide-y">
            {filteredCases.map((c) => {
              const days = getDaysRemaining(c);
              const isUrgent = days != null && days <= 2 && !c.clock_paused && !TERMINAL_STATES.includes(c.state);
              const isSelected = selectedCaseId === c.id;

              return (
                <button
                  key={c.id}
                  className={`w-full text-left px-3 py-2.5 hover:bg-muted/50 transition-colors ${
                    isSelected ? 'bg-muted' : ''
                  } ${isUrgent ? 'border-l-2 border-l-red-500' : ''}`}
                  onClick={() => setSelectedCaseId(c.id)}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 mb-0.5">
                        <UserIdentifier pubkey={c.pubkey} variant="compact" showAvatar={false} linkToProfile={false} className="text-xs" />
                      </div>
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <Badge variant="outline" className="text-[10px] h-4 px-1">
                          {STATE_SHORT[c.state]}
                        </Badge>
                        <Badge variant="outline" className="text-[10px] h-4 px-1">
                          {BAND_LABELS[c.suspected_age_band]}
                        </Badge>
                        {c.clock_paused ? (
                          <Badge variant="outline" className="text-[10px] h-4 px-1 gap-0.5">
                            ⏸ Paused
                          </Badge>
                        ) : null}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      {days != null && !TERMINAL_STATES.includes(c.state) && (
                        <div className={`text-[10px] ${isUrgent ? 'text-red-600 font-medium' : 'text-muted-foreground'}`}>
                          {days <= 0 ? 'Expired' : `${Math.ceil(days)}d`}
                        </div>
                      )}
                      <div className="text-[10px] text-muted-foreground">
                        {new Date(c.created_at).toLocaleDateString()}
                      </div>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </ScrollArea>
    </div>
  );

  const detailContent = selectedCase ? (
    <AgeReviewDetail caseData={selectedCase} />
  ) : (
    <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
      Select a case to view details
    </div>
  );

  if (isMobile) {
    return (
      <Card className="h-full flex flex-col overflow-hidden">
        {listContent}
        <Sheet open={!!selectedCase} onOpenChange={() => setSelectedCaseId(null)}>
          <SheetContent side="bottom" className="h-[80vh] p-0">
            {detailContent}
          </SheetContent>
        </Sheet>
      </Card>
    );
  }

  return (
    <div className="h-full flex gap-4">
      <Card className="w-[360px] shrink-0 flex flex-col overflow-hidden">
        {listContent}
      </Card>
      <Card className="flex-1 overflow-hidden">
        {detailContent}
      </Card>
    </div>
  );
}
