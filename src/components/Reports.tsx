// ABOUTME: Displays kind 1984 reports with split-pane layout and consolidation
// ABOUTME: Groups multiple reports on same target, shows count and all reporters

import { useState, useMemo, useEffect } from "react";
import { nip19 } from "nostr-tools";
import { useQuery } from "@tanstack/react-query";
import { useNostr } from "@nostrify/react";
import { useNavigate } from "react-router-dom";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Flag, RefreshCw, Clock, Users, Layers, CheckCircle } from "lucide-react";
import { ReportDetail } from "@/components/ReportDetail";
import { UserDisplayName } from "@/components/UserIdentifier";
import { CopyableId } from "@/components/CopyableId";
import { listBannedPubkeys, listBannedEvents, getAllDecisions } from "@/lib/adminApi";
import { CATEGORY_LABELS } from "@/lib/constants";
import type { NostrEvent } from "@nostrify/nostrify";

interface ReportsProps {
  relayUrl: string;
  selectedReportId?: string;
}

interface ReportTarget {
  type: 'event' | 'pubkey';
  value: string;
}

interface ConsolidatedReport {
  target: ReportTarget;
  reports: NostrEvent[];
  categories: string[];
  reporters: string[];
  latestReport: NostrEvent;
  oldestReport: NostrEvent;
}

function getReportCategory(event: NostrEvent): string {
  const reportTag = event.tags.find(t => t[0] === 'report');
  if (reportTag && reportTag[1]) return reportTag[1];
  const lTag = event.tags.find(t => t[0] === 'l');
  if (lTag && lTag[1]) return lTag[1];
  return 'other';
}

function getReportTarget(event: NostrEvent): ReportTarget | null {
  const eTag = event.tags.find(t => t[0] === 'e');
  if (eTag) return { type: 'event', value: eTag[1] };
  const pTag = event.tags.find(t => t[0] === 'p');
  if (pTag) return { type: 'pubkey', value: pTag[1] };
  return null;
}

function consolidateReports(reports: NostrEvent[]): ConsolidatedReport[] {
  const byTarget = new Map<string, ConsolidatedReport>();

  for (const report of reports) {
    const target = getReportTarget(report);
    if (!target) continue;

    const key = `${target.type}:${target.value}`;
    const category = getReportCategory(report);

    if (!byTarget.has(key)) {
      byTarget.set(key, {
        target,
        reports: [],
        categories: [],
        reporters: [],
        latestReport: report,
        oldestReport: report,
      });
    }

    const consolidated = byTarget.get(key)!;
    consolidated.reports.push(report);

    if (!consolidated.categories.includes(category)) {
      consolidated.categories.push(category);
    }

    if (!consolidated.reporters.includes(report.pubkey)) {
      consolidated.reporters.push(report.pubkey);
    }

    if (report.created_at > consolidated.latestReport.created_at) {
      consolidated.latestReport = report;
    }
    if (report.created_at < consolidated.oldestReport.created_at) {
      consolidated.oldestReport = report;
    }
  }

  // Sort by number of reports (most reported first), then by latest report date
  return Array.from(byTarget.values()).sort((a, b) => {
    if (b.reports.length !== a.reports.length) {
      return b.reports.length - a.reports.length;
    }
    return b.latestReport.created_at - a.latestReport.created_at;
  });
}

function ConsolidatedReportItem({
  consolidated,
  isSelected,
  onClick,
}: {
  consolidated: ConsolidatedReport;
  isSelected: boolean;
  onClick: () => void;
}) {
  const reportCount = consolidated.reports.length;
  const reporterCount = consolidated.reporters.length;
  const primaryCategory = consolidated.categories[0];
  const categoryLabel = CATEGORY_LABELS[primaryCategory] || primaryCategory;

  return (
    <div
      className={`p-3 border rounded-lg cursor-pointer transition-colors ${
        isSelected
          ? 'border-primary bg-primary/5 ring-1 ring-primary'
          : 'hover:bg-muted/50'
      }`}
      onClick={onClick}
    >
      <div className="space-y-2">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-1.5 flex-wrap">
            <Badge variant="outline" className="text-xs">{categoryLabel}</Badge>
            {consolidated.categories.length > 1 && (
              <Badge variant="outline" className="text-xs">
                +{consolidated.categories.length - 1} more
              </Badge>
            )}
            <Badge variant="secondary" className="text-xs">
              {consolidated.target.type === 'event' ? 'Event' : 'User'}
            </Badge>
          </div>
          <div className="flex items-center gap-1 text-xs text-muted-foreground shrink-0">
            <Clock className="h-3 w-3" />
            {new Date(consolidated.latestReport.created_at * 1000).toLocaleDateString()}
          </div>
        </div>

        {/* Report stats */}
        <div className="flex items-center gap-3 text-xs">
          <span className={`flex items-center gap-1 font-medium ${reportCount > 5 ? 'text-red-600' : reportCount > 2 ? 'text-orange-600' : 'text-muted-foreground'}`}>
            <Flag className="h-3 w-3" />
            {reportCount} report{reportCount !== 1 ? 's' : ''}
          </span>
          <span className="flex items-center gap-1 text-muted-foreground">
            <Users className="h-3 w-3" />
            {reporterCount} reporter{reporterCount !== 1 ? 's' : ''}
          </span>
        </div>

        {/* Target ID - show name for users, note ID for events */}
        {consolidated.target.type === 'pubkey' ? (
          <div className="text-xs text-muted-foreground truncate">
            <UserDisplayName pubkey={consolidated.target.value} fallbackLength={16} />
          </div>
        ) : (
          <CopyableId
            value={consolidated.target.value}
            type="note"
            truncateStart={12}
            truncateEnd={4}
            size="xs"
          />
        )}
      </div>
    </div>
  );
}

function IndividualReportItem({
  report,
  isSelected,
  onClick,
}: {
  report: NostrEvent;
  isSelected: boolean;
  onClick: () => void;
}) {
  const category = getReportCategory(report);
  const target = getReportTarget(report);
  const categoryLabel = CATEGORY_LABELS[category] || category;

  return (
    <div
      className={`p-3 border rounded-lg cursor-pointer transition-colors ${
        isSelected
          ? 'border-primary bg-primary/5 ring-1 ring-primary'
          : 'hover:bg-muted/50'
      }`}
      onClick={onClick}
    >
      <div className="space-y-2">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-1.5 flex-wrap">
            <Badge variant="outline" className="text-xs">{categoryLabel}</Badge>
            {target && (
              <Badge variant="secondary" className="text-xs">
                {target.type === 'event' ? 'Event' : 'User'}
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-1 text-xs text-muted-foreground shrink-0">
            <Clock className="h-3 w-3" />
            {new Date(report.created_at * 1000).toLocaleDateString()}
          </div>
        </div>
        {target && (
          target.type === 'pubkey' ? (
            <div className="text-xs text-muted-foreground truncate">
              <UserDisplayName pubkey={target.value} fallbackLength={16} />
            </div>
          ) : (
            <CopyableId
              value={target.value}
              type="note"
              truncateStart={12}
              truncateEnd={4}
              size="xs"
            />
          )
        )}
      </div>
    </div>
  );
}

export function Reports({ relayUrl, selectedReportId }: ReportsProps) {
  const { nostr } = useNostr();
  const navigate = useNavigate();
  const [selectedReport, setSelectedReport] = useState<NostrEvent | null>(null);
  const [viewMode, setViewMode] = useState<'consolidated' | 'individual'>('consolidated');
  const [hideResolved, setHideResolved] = useState(true);

  const { data: reports, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['reports', relayUrl],
    queryFn: async ({ signal }) => {
      const events = await nostr.query(
        [{ kinds: [1984], limit: 200 }],
        { signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) }
      );
      return events.sort((a, b) => b.created_at - a.created_at);
    },
  });

  // Query for resolution labels (kind 1985 with moderation/resolution namespace)
  const { data: resolutionLabels } = useQuery({
    queryKey: ['resolution-labels', relayUrl],
    queryFn: async ({ signal }) => {
      const events = await nostr.query(
        [{ kinds: [1985], '#L': ['moderation/resolution'], limit: 500 }],
        { signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) }
      );
      return events;
    },
  });

  // Query banned pubkeys from relay (NIP-86 RPC)
  const { data: bannedPubkeys } = useQuery({
    queryKey: ['banned-pubkeys'],
    queryFn: async () => {
      try {
        const pubkeys = await listBannedPubkeys();
        console.log('[Reports] Banned pubkeys from relay:', pubkeys.length);
        return pubkeys;
      } catch (error) {
        console.warn('NIP-86 listbannedpubkeys failed:', error);
        return [];
      }
    },
    staleTime: 30 * 1000,
  });

  // Query banned/deleted events from relay (NIP-86 RPC)
  const { data: bannedEvents } = useQuery({
    queryKey: ['banned-events'],
    queryFn: async () => {
      try {
        return await listBannedEvents();
      } catch (error) {
        console.warn('NIP-86 listbannedevents failed:', error);
        return [];
      }
    },
    staleTime: 30 * 1000,
  });

  // Query all moderation decisions from our D1 database
  const { data: allDecisions } = useQuery({
    queryKey: ['all-decisions'],
    queryFn: async () => {
      const decisions = await getAllDecisions();
      console.log('[Reports] Loaded decisions:', decisions.length, decisions.slice(0, 3));
      return decisions;
    },
    staleTime: 30 * 1000,
  });

  // Build set of resolved target keys (from labels, bans, deletions, and decisions)
  const resolvedTargets = useMemo(() => {
    const resolved = new Set<string>();

    // Add from resolution labels
    if (resolutionLabels) {
      for (const label of resolutionLabels) {
        const eTag = label.tags.find(t => t[0] === 'e');
        if (eTag) resolved.add(`event:${eTag[1]}`);
        const pTag = label.tags.find(t => t[0] === 'p');
        if (pTag) resolved.add(`pubkey:${pTag[1]}`);
      }
    }

    // Add banned pubkeys
    if (bannedPubkeys) {
      for (const pubkey of bannedPubkeys) {
        resolved.add(`pubkey:${pubkey}`);
      }
    }

    // Add deleted events
    if (bannedEvents) {
      for (const event of bannedEvents) {
        resolved.add(`event:${event.id}`);
      }
    }

    // Add from moderation decisions (ban_user, delete_event, etc.)
    if (allDecisions) {
      for (const decision of allDecisions) {
        if (decision.target_type === 'pubkey') {
          resolved.add(`pubkey:${decision.target_id}`);
        } else if (decision.target_type === 'event') {
          resolved.add(`event:${decision.target_id}`);
        }
      }
    }

    console.log('[Reports] Resolved targets:', resolved.size, Array.from(resolved).slice(0, 5));
    return resolved;
  }, [resolutionLabels, bannedPubkeys, bannedEvents, allDecisions]);

  const consolidated = useMemo(() => {
    if (!reports) return [];
    let items = consolidateReports(reports);

    // Filter out resolved if toggle is on
    if (hideResolved) {
      items = items.filter(c => !resolvedTargets.has(`${c.target.type}:${c.target.value}`));
    }

    return items;
  }, [reports, hideResolved, resolvedTargets]);

  const allConsolidated = useMemo(() => {
    if (!reports) return [];
    return consolidateReports(reports);
  }, [reports]);

  const uniqueTargets = consolidated.length;
  const totalTargets = allConsolidated.length;
  const totalReports = reports?.length || 0;
  const resolvedCount = totalTargets - uniqueTargets;

  // Sync selected report with URL
  useEffect(() => {
    if (selectedReportId && reports && !selectedReport) {
      const report = reports.find(r => r.id === selectedReportId);
      if (report) {
        setSelectedReport(report);
      }
    }
  }, [selectedReportId, reports, selectedReport]);

  // Update URL when report selection changes
  const handleSelectReport = (report: NostrEvent | null) => {
    setSelectedReport(report);
    if (report) {
      navigate(`/reports/${report.id}`, { replace: true });
    } else {
      navigate('/reports', { replace: true });
    }
  };

  if (isLoading) {
    return (
      <Card className="h-[calc(100vh-200px)]">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Flag className="h-5 w-5" />
            Reports
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {[...Array(5)].map((_, i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertDescription>
          Failed to load reports: {error instanceof Error ? error.message : "Unknown error"}
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-5 gap-4 h-[calc(100vh-200px)]">
      {/* Left Pane - Report List */}
      <Card className="lg:col-span-2">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2 text-lg">
                <Flag className="h-5 w-5" />
                Reports
              </CardTitle>
              <CardDescription>
                {uniqueTargets} pending{resolvedCount > 0 && hideResolved && (
                  <span className="text-green-600"> ({resolvedCount} resolved)</span>
                )}
              </CardDescription>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => refetch()}
              disabled={isFetching}
            >
              <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
            </Button>
          </div>

          {/* View mode toggle */}
          <Tabs value={viewMode} onValueChange={(v) => setViewMode(v as 'consolidated' | 'individual')} className="mt-2">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="consolidated" className="text-xs">
                <Layers className="h-3 w-3 mr-1" />
                Grouped ({uniqueTargets})
              </TabsTrigger>
              <TabsTrigger value="individual" className="text-xs">
                <Flag className="h-3 w-3 mr-1" />
                All ({totalReports})
              </TabsTrigger>
            </TabsList>
          </Tabs>

          {/* Hide resolved toggle */}
          <div className="flex items-center justify-between mt-3 pt-2 border-t">
            <Label htmlFor="hide-resolved" className="text-xs text-muted-foreground flex items-center gap-1.5">
              <CheckCircle className="h-3 w-3 text-green-500" />
              Hide resolved
            </Label>
            <Switch
              id="hide-resolved"
              checked={hideResolved}
              onCheckedChange={setHideResolved}
            />
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <ScrollArea className="h-[calc(100vh-380px)]">
            <div className="space-y-2 p-4 pt-0">
              {viewMode === 'consolidated' ? (
                !consolidated || consolidated.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground">
                    <Flag className="h-8 w-8 mx-auto mb-2 opacity-50" />
                    <p className="text-sm">No reports found</p>
                  </div>
                ) : (
                  consolidated.map((item) => (
                    <ConsolidatedReportItem
                      key={`${item.target.type}:${item.target.value}`}
                      consolidated={item}
                      isSelected={selectedReport?.id === item.latestReport.id}
                      onClick={() => handleSelectReport(item.latestReport)}
                    />
                  ))
                )
              ) : (
                !reports || reports.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground">
                    <Flag className="h-8 w-8 mx-auto mb-2 opacity-50" />
                    <p className="text-sm">No reports found</p>
                  </div>
                ) : (
                  reports.map((report) => (
                    <IndividualReportItem
                      key={report.id}
                      report={report}
                      isSelected={selectedReport?.id === report.id}
                      onClick={() => handleSelectReport(report)}
                    />
                  ))
                )
              )}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>

      {/* Right Pane - Report Detail */}
      <Card className="lg:col-span-3 overflow-hidden">
        <ReportDetail
          report={selectedReport}
          allReportsForTarget={
            selectedReport
              ? consolidated.find(c =>
                  c.reports.some(r => r.id === selectedReport.id)
                )?.reports
              : undefined
          }
          allReports={reports || []}
          onDismiss={() => handleSelectReport(null)}
        />
      </Card>
    </div>
  );
}
