// ABOUTME: Displays kind 1984 reports with split-pane layout and consolidation
// ABOUTME: Groups multiple reports on same target, shows count and all reporters

import { useState, useMemo, useEffect } from "react";

import { useQuery } from "@tanstack/react-query";
import { useNostr } from "@nostrify/react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Flag,
  RefreshCw,
  Clock,
  Users,
  Layers,
  CheckCircle,
  ArrowUpDown,
  Filter,
  User,
  FileText,
  AlertTriangle,
  X,
} from "lucide-react";
import { ReportDetail } from "@/components/ReportDetail";
import { UserDisplayName } from "@/components/UserIdentifier";
import { CopyableId } from "@/components/CopyableId";
import { useAdminApi } from "@/hooks/useAdminApi";
import { CATEGORY_LABELS } from "@/lib/constants";
import { useIsMobile } from "@/hooks/useIsMobile";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import type { NostrEvent } from "@nostrify/nostrify";

// Sort options for moderation queue
type SortOption = 'reports' | 'newest' | 'oldest' | 'category' | 'reporters';

const SORT_OPTIONS: { value: SortOption; label: string }[] = [
  { value: 'reports', label: 'Most Reports' },
  { value: 'reporters', label: 'Most Reporters' },
  { value: 'newest', label: 'Newest First' },
  { value: 'oldest', label: 'Oldest First' },
  { value: 'category', label: 'By Category' },
];

// High-priority categories that need immediate attention (CSAM, illegal content)
const HIGH_PRIORITY_CATEGORIES = ['sexual_minors', 'nonconsensual_sexual_content', 'terrorism_extremism', 'credible_threats'];
const MEDIUM_PRIORITY_CATEGORIES = ['doxxing_pii', 'malware_scam', 'illegal_goods'];

// Category priority for sorting
function getCategoryPriority(categories: string[]): number {
  if (categories.some(c => HIGH_PRIORITY_CATEGORIES.includes(c))) return 0;
  if (categories.some(c => MEDIUM_PRIORITY_CATEGORIES.includes(c))) return 1;
  return 2;
}

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
  const isHighPriority = consolidated.categories.some(c => HIGH_PRIORITY_CATEGORIES.includes(c));
  const isMediumPriority = consolidated.categories.some(c => MEDIUM_PRIORITY_CATEGORIES.includes(c));

  return (
    <div
      className={`p-3 border rounded-lg cursor-pointer transition-colors ${
        isSelected
          ? 'border-primary bg-primary/5 ring-1 ring-primary'
          : isHighPriority
          ? 'border-red-300 bg-red-50/50 dark:bg-red-950/20 hover:bg-red-50 dark:hover:bg-red-950/30'
          : isMediumPriority
          ? 'border-orange-200 bg-orange-50/30 dark:bg-orange-950/10 hover:bg-orange-50/50'
          : 'hover:bg-muted/50'
      }`}
      onClick={onClick}
    >
      <div className="space-y-2">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-1.5 flex-wrap">
            {isHighPriority && (
              <Badge variant="destructive" className="text-xs">
                <AlertTriangle className="h-3 w-3 mr-1" />
                Priority
              </Badge>
            )}
            <Badge
              variant={isHighPriority ? 'destructive' : 'outline'}
              className="text-xs"
            >
              {categoryLabel}
            </Badge>
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
            <UserDisplayName pubkey={consolidated.target.value} fallbackLength={16} linkToProfile />
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
  const isHighPriority = HIGH_PRIORITY_CATEGORIES.includes(category);
  const isMediumPriority = MEDIUM_PRIORITY_CATEGORIES.includes(category);

  return (
    <div
      className={`p-3 border rounded-lg cursor-pointer transition-colors ${
        isSelected
          ? 'border-primary bg-primary/5 ring-1 ring-primary'
          : isHighPriority
          ? 'border-red-300 bg-red-50/50 dark:bg-red-950/20 hover:bg-red-50 dark:hover:bg-red-950/30'
          : isMediumPriority
          ? 'border-orange-200 bg-orange-50/30 dark:bg-orange-950/10 hover:bg-orange-50/50'
          : 'hover:bg-muted/50'
      }`}
      onClick={onClick}
    >
      <div className="space-y-2">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-1.5 flex-wrap">
            {isHighPriority && (
              <Badge variant="destructive" className="text-xs">
                <AlertTriangle className="h-3 w-3 mr-1" />
                Priority
              </Badge>
            )}
            <Badge
              variant={isHighPriority ? 'destructive' : 'outline'}
              className="text-xs"
            >
              {categoryLabel}
            </Badge>
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
              <UserDisplayName pubkey={target.value} fallbackLength={16} linkToProfile />
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
  const [searchParams, setSearchParams] = useSearchParams();
  const { listBannedPubkeys, listBannedEvents, getAllDecisions } = useAdminApi();
  const isMobile = useIsMobile();
  const [selectedReport, setSelectedReport] = useState<NostrEvent | null>(null);
  const [viewMode, setViewMode] = useState<'consolidated' | 'individual'>('consolidated');
  const [hideResolved, setHideResolved] = useState(true);
  const [sortBy, setSortBy] = useState<SortOption>('reports');
  const [filterCategory, setFilterCategory] = useState<string | null>(null);
  const [filterTargetType, setFilterTargetType] = useState<'all' | 'event' | 'pubkey'>('all');
  // Check for deep link params to force fresh data fetch
  const hasDeepLinkParams = !!(searchParams.get('event') || searchParams.get('pubkey'));

  const { data: reports, isLoading, error, refetch, isFetching, dataUpdatedAt } = useQuery({
    queryKey: ['reports', relayUrl],
    queryFn: async ({ signal }) => {
      const events = await nostr.query(
        [{ kinds: [1984], limit: 200 }],
        { signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) }
      );
      return events.sort((a, b) => b.created_at - a.created_at);
    },
    refetchInterval: 15 * 1000, // Poll every 15 seconds for team consistency
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
    refetchInterval: 15 * 1000,
  });

  // Query banned pubkeys from relay (NIP-86 RPC)
  // Force fresh fetch (staleTime: 0) when deep linking to ensure accurate ban status
  const { data: bannedPubkeys, isFetching: isFetchingBanned } = useQuery({
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
    staleTime: hasDeepLinkParams ? 0 : 30 * 1000,
    refetchInterval: 15 * 1000,
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
    refetchInterval: 15 * 1000,
  });

  // Query all moderation decisions from our D1 database
  const { data: allDecisions, error: decisionsError } = useQuery({
    queryKey: ['all-decisions'],
    queryFn: async () => {
      try {
        const decisions = await getAllDecisions();
        console.log('[Reports] Loaded decisions:', decisions.length, decisions.slice(0, 3));
        return decisions;
      } catch (error) {
        console.error('[Reports] Failed to load decisions:', error);
        return [];
      }
    },
    staleTime: 30 * 1000,
    refetchInterval: 15 * 1000,
  });

  // Debug: log any decisions error
  useEffect(() => {
    if (decisionsError) {
      console.error('[Reports] Decisions query error:', decisionsError);
    }
  }, [decisionsError]);

  // Track relative time since last data update for freshness indicator
  const [lastUpdatedText, setLastUpdatedText] = useState<string>('');
  useEffect(() => {
    if (!dataUpdatedAt) return;

    const updateRelativeTime = () => {
      const seconds = Math.floor((Date.now() - dataUpdatedAt) / 1000);
      if (seconds < 5) {
        setLastUpdatedText('just now');
      } else if (seconds < 60) {
        setLastUpdatedText(`${seconds}s ago`);
      } else {
        const minutes = Math.floor(seconds / 60);
        setLastUpdatedText(`${minutes}m ago`);
      }
    };

    updateRelativeTime();
    const interval = setInterval(updateRelativeTime, 5000);
    return () => clearInterval(interval);
  }, [dataUpdatedAt]);

  // Build set of resolved target keys (from labels, bans, deletions, and decisions)
  const resolvedTargets = useMemo(() => {
    const resolved = new Set<string>();
    let fromLabels = 0, fromBannedPubkeys = 0, fromBannedEvents = 0, fromDecisions = 0;

    // Add from resolution labels
    if (resolutionLabels) {
      for (const label of resolutionLabels) {
        const eTag = label.tags.find(t => t[0] === 'e');
        if (eTag) { resolved.add(`event:${eTag[1]}`); fromLabels++; }
        const pTag = label.tags.find(t => t[0] === 'p');
        if (pTag) { resolved.add(`pubkey:${pTag[1]}`); fromLabels++; }
      }
    }

    // Add banned pubkeys (now returns BannedPubkeyEntry objects)
    if (bannedPubkeys) {
      for (const entry of bannedPubkeys) {
        resolved.add(`pubkey:${entry.pubkey}`);
        fromBannedPubkeys++;
      }
    }

    // Add deleted events
    if (bannedEvents) {
      for (const event of bannedEvents) {
        resolved.add(`event:${event.id}`);
        fromBannedEvents++;
      }
    }

    // Add from moderation decisions (ban_user, delete_event, etc.)
    if (allDecisions && allDecisions.length > 0) {
      for (const decision of allDecisions) {
        if (decision.target_type === 'pubkey') {
          resolved.add(`pubkey:${decision.target_id}`);
          fromDecisions++;
        } else if (decision.target_type === 'event') {
          resolved.add(`event:${decision.target_id}`);
          fromDecisions++;
        }
      }
    }

    console.log('[Reports] Resolved targets breakdown:', {
      total: resolved.size,
      fromLabels,
      fromBannedPubkeys,
      fromBannedEvents,
      fromDecisions,
      decisionsLoaded: allDecisions?.length ?? 'undefined',
    });
    return resolved;
  }, [resolutionLabels, bannedPubkeys, bannedEvents, allDecisions]);

  // Get all unique categories from reports for filter chips
  const availableCategories = useMemo(() => {
    if (!reports) return [];
    const categories = new Set<string>();
    for (const report of reports) {
      categories.add(getReportCategory(report));
    }
    return Array.from(categories).sort();
  }, [reports]);

  const consolidated = useMemo(() => {
    if (!reports) return [];
    let items = consolidateReports(reports);

    // Filter out resolved if toggle is on
    if (hideResolved) {
      items = items.filter(c => !resolvedTargets.has(`${c.target.type}:${c.target.value}`));
    }

    // Filter by category
    if (filterCategory) {
      items = items.filter(c => c.categories.includes(filterCategory));
    }

    // Filter by target type
    if (filterTargetType !== 'all') {
      items = items.filter(c => c.target.type === filterTargetType);
    }

    // Apply sorting
    items.sort((a, b) => {
      switch (sortBy) {
        case 'reports':
          // Most reports first, then by date
          if (b.reports.length !== a.reports.length) {
            return b.reports.length - a.reports.length;
          }
          return b.latestReport.created_at - a.latestReport.created_at;

        case 'reporters':
          // Most unique reporters first (higher confidence)
          if (b.reporters.length !== a.reporters.length) {
            return b.reporters.length - a.reporters.length;
          }
          return b.reports.length - a.reports.length;

        case 'newest':
          return b.latestReport.created_at - a.latestReport.created_at;

        case 'oldest':
          return a.oldestReport.created_at - b.oldestReport.created_at;

        case 'category': {
          // Sort by priority (CSAM first), then alphabetically by category
          const aPriority = getCategoryPriority(a.categories);
          const bPriority = getCategoryPriority(b.categories);
          if (aPriority !== bPriority) return aPriority - bPriority;
          // Then by primary category name
          const aCategory = a.categories[0] || 'zzz';
          const bCategory = b.categories[0] || 'zzz';
          if (aCategory !== bCategory) return aCategory.localeCompare(bCategory);
          // Then by report count
          return b.reports.length - a.reports.length;
        }

        default:
          return 0;
      }
    });

    return items;
  }, [reports, hideResolved, resolvedTargets, filterCategory, filterTargetType, sortBy]);

  const allConsolidated = useMemo(() => {
    if (!reports) return [];
    return consolidateReports(reports);
  }, [reports]);

  // Filter individual reports when hideResolved is on
  const filteredReports = useMemo(() => {
    if (!reports) return [];
    let items = [...reports];

    // Filter resolved
    if (hideResolved) {
      items = items.filter(report => {
        const target = getReportTarget(report);
        if (!target) return true; // Keep reports without targets
        return !resolvedTargets.has(`${target.type}:${target.value}`);
      });
    }

    // Filter by category
    if (filterCategory) {
      items = items.filter(report => getReportCategory(report) === filterCategory);
    }

    // Filter by target type
    if (filterTargetType !== 'all') {
      items = items.filter(report => {
        const target = getReportTarget(report);
        return target?.type === filterTargetType;
      });
    }

    // Apply sorting
    items.sort((a, b) => {
      switch (sortBy) {
        case 'newest':
          return b.created_at - a.created_at;
        case 'oldest':
          return a.created_at - b.created_at;
        case 'category': {
          const aCat = getReportCategory(a);
          const bCat = getReportCategory(b);
          const aPriority = getCategoryPriority([aCat]);
          const bPriority = getCategoryPriority([bCat]);
          if (aPriority !== bPriority) return aPriority - bPriority;
          return aCat.localeCompare(bCat);
        }
        default:
          // For 'reports' and 'reporters', just use date for individual view
          return b.created_at - a.created_at;
      }
    });

    return items;
  }, [reports, hideResolved, resolvedTargets, filterCategory, filterTargetType, sortBy]);

  const uniqueTargets = consolidated.length;
  const totalTargets = allConsolidated.length;
  const totalReports = reports?.length || 0;
  const filteredReportsCount = filteredReports.length;
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

  // Handle deep linking via query params (?event=... or ?pubkey=...)
  useEffect(() => {
    const eventParam = searchParams.get('event');
    const pubkeyParam = searchParams.get('pubkey');

    // Skip if no params
    if (!eventParam && !pubkeyParam) return;
    if (!allConsolidated || allConsolidated.length === 0) return;

    // Wait for fresh ban data before processing deep link
    if (isFetchingBanned) return;

    let targetReport: ConsolidatedReport | undefined;

    if (eventParam) {
      targetReport = allConsolidated.find(c =>
        c.target.type === 'event' && c.target.value === eventParam
      );
    } else if (pubkeyParam) {
      targetReport = allConsolidated.find(c =>
        c.target.type === 'pubkey' && c.target.value === pubkeyParam
      );
    }

    if (targetReport) {
      // If target is resolved and we're hiding resolved, temporarily show it
      const targetKey = `${targetReport.target.type}:${targetReport.target.value}`;
      if (hideResolved && resolvedTargets.has(targetKey)) {
        setHideResolved(false);
      }

      // Select the report
      setSelectedReport(targetReport.latestReport);
      navigate(`/reports/${targetReport.latestReport.id}`, { replace: true });

      // Clear params from URL now that we've navigated
      setSearchParams({}, { replace: true });
    }
    // If report not found, keep params — effect will re-run when more data loads
  }, [allConsolidated, searchParams, hideResolved, resolvedTargets, navigate, setSearchParams, isFetchingBanned]);

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
    <>
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4 h-full">
        {/* Left Pane - Report List */}
        <Card className="lg:col-span-2 h-full overflow-hidden flex flex-col">
        <CardHeader className="pb-3 shrink-0">
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
            <div className="flex items-center gap-2">
              {lastUpdatedText && (
                <span className="text-xs text-muted-foreground hidden sm:inline">
                  {lastUpdatedText}
                </span>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={() => refetch()}
                disabled={isFetching}
                title={lastUpdatedText ? `Last updated ${lastUpdatedText}` : 'Refresh'}
                className="min-w-[44px] min-h-[44px] sm:min-w-0 sm:min-h-0"
              >
                <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
              </Button>
            </div>
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
                All ({hideResolved ? filteredReportsCount : totalReports})
              </TabsTrigger>
            </TabsList>
          </Tabs>

          {/* Sort and Filter Controls */}
          <div className="space-y-3 mt-3 pt-3 border-t">
            {/* Sort dropdown */}
            <div className="flex items-center gap-2">
              <ArrowUpDown className="h-3 w-3 text-muted-foreground shrink-0" />
              <Select value={sortBy} onValueChange={(v) => setSortBy(v as SortOption)}>
                <SelectTrigger className="h-8 text-xs flex-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SORT_OPTIONS.map(option => (
                    <SelectItem key={option.value} value={option.value} className="text-xs">
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Target type filter */}
            <div className="flex items-center gap-2">
              <Filter className="h-3 w-3 text-muted-foreground shrink-0" />
              <div className="flex gap-1 flex-1">
                <Button
                  variant={filterTargetType === 'all' ? 'secondary' : 'ghost'}
                  size="sm"
                  className="h-7 text-xs px-2 flex-1"
                  onClick={() => setFilterTargetType('all')}
                >
                  All
                </Button>
                <Button
                  variant={filterTargetType === 'pubkey' ? 'secondary' : 'ghost'}
                  size="sm"
                  className="h-7 text-xs px-2 flex-1"
                  onClick={() => setFilterTargetType('pubkey')}
                >
                  <User className="h-3 w-3 mr-1" />
                  Users
                </Button>
                <Button
                  variant={filterTargetType === 'event' ? 'secondary' : 'ghost'}
                  size="sm"
                  className="h-7 text-xs px-2 flex-1"
                  onClick={() => setFilterTargetType('event')}
                >
                  <FileText className="h-3 w-3 mr-1" />
                  Events
                </Button>
              </div>
            </div>

            {/* Category filter chips */}
            {availableCategories.length > 0 && (
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Category</Label>
                <div className="flex flex-wrap gap-1">
                  {filterCategory && (
                    <Badge
                      variant="default"
                      className="text-xs cursor-pointer pr-1"
                      onClick={() => setFilterCategory(null)}
                    >
                      {CATEGORY_LABELS[filterCategory] || filterCategory}
                      <X className="h-3 w-3 ml-1" />
                    </Badge>
                  )}
                  {!filterCategory && availableCategories.map(cat => (
                    <Badge
                      key={cat}
                      variant={HIGH_PRIORITY_CATEGORIES.includes(cat) ? 'destructive' : 'outline'}
                      className="text-xs cursor-pointer hover:bg-muted"
                      onClick={() => setFilterCategory(cat)}
                    >
                      {HIGH_PRIORITY_CATEGORIES.includes(cat) && (
                        <AlertTriangle className="h-3 w-3 mr-1" />
                      )}
                      {CATEGORY_LABELS[cat] || cat}
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            {/* Hide resolved toggle */}
            <div className="flex items-center justify-between pt-2 border-t">
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
          </div>
        </CardHeader>
        <CardContent className="p-0 flex-1 min-h-0">
          <ScrollArea className="h-full">
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
                filteredReports.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground">
                    <Flag className="h-8 w-8 mx-auto mb-2 opacity-50" />
                    <p className="text-sm">No reports found</p>
                  </div>
                ) : (
                  filteredReports.map((report) => (
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

        {/* Right Pane - Report Detail (Desktop) */}
        {!isMobile && (
          <Card className="lg:col-span-3 overflow-hidden h-full">
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
        )}
      </div>

      {/* Mobile Sheet - Report Detail */}
      {isMobile && (
        <Sheet open={!!selectedReport} onOpenChange={(open) => !open && handleSelectReport(null)}>
          <SheetContent side="right" className="!w-full !max-w-[100vw] p-0 overflow-y-auto">
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
          </SheetContent>
        </Sheet>
      )}
    </>
  );
}
