// ABOUTME: Displays kind 1984 reports with split-pane layout and consolidation
// ABOUTME: Groups multiple reports on same target, shows count and all reporters

import { useState, useMemo, useEffect, useRef } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAppContext } from "@/hooks/useAppContext";
import { getEnvironmentById, getCurrentEnvironment } from "@/lib/environments";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ResolutionUnavailablePane, ResolutionOverrideWarning, StaleResolutionBanner, TruncatedHistoryBanner } from "@/components/ResolutionStateNotice";
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
  EyeOff,
  Copy,
  Check,
} from "lucide-react";
import { nip19 } from "nostr-tools";
import { ReportDetail } from "@/components/ReportDetail";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { ReportDetailErrorFallback } from "@/components/ReportDetailErrorFallback";
import { DeepLinkFallback } from "@/components/DeepLinkFallback";
import { classifyTargetedFetch, decisionsForTarget, reportsMatchingTarget, type DeepLinkStatus } from "@/lib/deepLinkResolution";
import { useAdminApi } from "@/hooks/useAdminApi";
import { AUTO_HIDE_ACTION, AUTO_HIDE_ACTIONS, CATEGORY_LABELS, HIGH_PRIORITY_CATEGORIES, getLatestAutoHideState, getReportCategory, getReportTargetIds } from "@/lib/constants";
import { isConsolidatedReportResolved } from "@/lib/reportResolution";
import { useIsMobile } from "@/hooks/useIsMobile";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import type { NostrEvent } from "@nostrify/nostrify";

// Scoped fallback for the reports-list pane (#158): list rows render
// reporter-authored content too, and without a boundary a row crash escalates
// to the app-root card, whose Reload would deterministically re-crash.
function ReportsListErrorFallback({ onRetry }: { onRetry: () => void }) {
  return (
    <Card className="lg:col-span-2 flex h-full flex-col items-center justify-center space-y-3 overflow-hidden p-8 text-center">
      <AlertTriangle className="h-6 w-6 text-destructive" />
      <p className="font-medium">The reports list failed to render</p>
      <p className="text-sm text-muted-foreground">
        A report in the queue may contain malformed data. Details are in the
        browser console.
      </p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        <RefreshCw className="mr-1 h-3 w-3" />
        Try again
      </Button>
    </Card>
  );
}

// Sort options for moderation queue
type SortOption = 'reports' | 'newest' | 'oldest' | 'category' | 'reporters';

const SORT_OPTIONS: { value: SortOption; label: string }[] = [
  { value: 'reports', label: 'Most Reports' },
  { value: 'reporters', label: 'Most Reporters' },
  { value: 'newest', label: 'Newest First' },
  { value: 'oldest', label: 'Oldest First' },
  { value: 'category', label: 'By Category' },
];

const MEDIUM_PRIORITY_CATEGORIES = ['doxxing_pii', 'malware_scam', 'illegal_goods'];

// Timeout for the four resolution reads that build resolvedTargets, replacing
// adminApi's 30s API_TIMEOUT_MS for these calls only. On a COLD load there is no
// error to latch onto yet, so every escape hatch this page offers sits behind the
// loading skeleton: a source that times out at 30s and then retries strands the
// moderator on a bare skeleton for a minute with nothing to click, and any of the
// four can cause it. A 30s bound buys nothing here anyway, being twice the 15s
// poll interval that would have recovered the read on its own (#221). Scoped to
// these reads: one-shot moderation actions still want the generous default.
const RESOLUTION_READ_TIMEOUT_MS = 8_000;

// The four polled reads that build resolvedTargets. Named at module scope so the
// acknowledged-override state can be keyed by it.
type ResolutionSourceKey = 'labels' | 'banned-pubkeys' | 'banned-events' | 'decisions';

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
  // The reported author (report `p` tag), used to cross-resolve an event-scoped
  // report when its author has been banned. Undefined if no valid `p` tag.
  authorPubkey?: string;
}

// Deliberately presence-based (a valueless ["e"] still yields an event target)
// rather than delegating to getReportTargetIds: returning null here would drop
// malformed reports from the consolidated queue entirely, and useReportContext/
// ReportDetail carry identical copies the detail pane relies on. TODO(#160):
// consolidate all report-target extraction sites behind shared helpers with
// agreed semantics.
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

  // Derive each group's author from ALL its reports, not just the first-processed
  // (newest) one. Cross-resolution hides a whole consolidated group from the default
  // queue, so taking the author from a single unverified `p` tag is gameable: a newer
  // report naming any banned pubkey would bury the genuine older report with it
  // (NIP-56 warns reports "can be easily gamed"). Require agreement instead — cross-
  // resolve only when every report carries a valid `p` tag and names the same author.
  // A missing author cannot be ignored: otherwise one later report naming a banned
  // pubkey could still bury an existing report that supplied no author. Lowercased so
  // a casing difference is not a false disagreement; undefined when any author is
  // missing or the reports conflict, in which case the group is never cross-resolved.
  for (const consolidated of byTarget.values()) {
    const authors = consolidated.reports.map(r => getReportTargetIds(r).pubkey);
    const uniqueAuthors = new Set(authors.filter((p): p is string => !!p).map(p => p.toLowerCase()));
    consolidated.authorPubkey = authors.every((p): p is string => !!p) && uniqueAuthors.size === 1
      ? [...uniqueAuthors][0]
      : undefined;
  }

  // Sort by number of reports (most reported first), then by latest report date
  return Array.from(byTarget.values()).sort((a, b) => {
    if (b.reports.length !== a.reports.length) {
      return b.reports.length - a.reports.length;
    }
    return b.latestReport.created_at - a.latestReport.created_at;
  });
}

// Full-width bech32 ID with CSS truncation and copy button.
// Shows as much of the ID as the layout allows, like UserProfileCard's npub row.
function TargetId({ value, type }: { value: string; type: 'event' | 'pubkey' }) {
  const [copied, setCopied] = useState(false);

  let displayValue = value;
  try {
    displayValue = type === 'pubkey' ? nip19.npubEncode(value) : nip19.noteEncode(value);
  } catch {
    // keep hex
  }

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(displayValue);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard not available */ }
  };

  return (
    <div className="flex items-center gap-1 min-w-0">
      <code className="text-[10px] text-muted-foreground font-mono block truncate min-w-0 flex-1">
        {displayValue}
      </code>
      <button
        type="button"
        onClick={handleCopy}
        className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
      >
        {copied ? (
          <Check className="h-3 w-3 text-green-500" />
        ) : (
          <Copy className="h-3 w-3 opacity-50" />
        )}
      </button>
    </div>
  );
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
      className={`p-3 border rounded-lg cursor-pointer transition-colors overflow-hidden ${
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

        {/* Target ID - full bech32 with CSS truncation */}
        <TargetId value={consolidated.target.value} type={consolidated.target.type} />
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
      className={`p-3 border rounded-lg cursor-pointer transition-colors overflow-hidden ${
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
          <TargetId value={target.value} type={target.type} />
        )}
      </div>
    </div>
  );
}

export function Reports({ relayUrl, selectedReportId }: ReportsProps) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { listBannedPubkeys, listBannedEvents, getAllDecisions, fetchReports, fetchReportsByTarget, fetchResolutionLabels } = useAdminApi();
  const { config, updateConfig } = useAppContext();
  const queryClient = useQueryClient();
  const isMobile = useIsMobile();
  const [selectedReport, setSelectedReport] = useState<NostrEvent | null>(null);
  const detailBoundaryRef = useRef<ErrorBoundary | null>(null);
  const [viewMode, setViewMode] = useState<'consolidated' | 'individual'>('consolidated');
  const [hideResolved, setHideResolved] = useState(true);
  const [showPendingReview, setShowPendingReview] = useState(false);
  const [sortBy, setSortBy] = useState<SortOption>('reports');
  const [filterCategory, setFilterCategory] = useState<string | null>(null);
  const [filterTargetType, setFilterTargetType] = useState<'all' | 'event' | 'pubkey'>('all');
  // The resolution sources a moderator has explicitly chosen to proceed without.
  // A Set rather than a boolean: the blocked pane names the sources it is
  // blocking on, and its consent paragraph changes depending on whether
  // DECISIONS is among them (proceeding then also exposes auto-hidden content).
  // A blanket boolean silently carried consent given for "Banned posts" over to
  // a later cold decisions failure, so the moderator never saw that paragraph --
  // a consent bypass, not just staleness.
  //
  // Component-local on purpose: acknowledgements survive polls within this mount
  // so a moderator is not thrown back to the blocked pane every 15s, and reset
  // on reload so the safe default reasserts itself.
  const [acknowledgedBlockedSources, setAcknowledgedBlockedSources] =
    useState<ReadonlySet<ResolutionSourceKey>>(() => new Set());
  // Check for deep link params to force fresh data fetch
  const hasDeepLinkParams = !!(searchParams.get('event') || searchParams.get('pubkey'));
  // Deep-link resolution: 'resolving' while we look a target up, 'gone' when the
  // relay confirms the report is absent, 'unavailable' when the relay itself failed.
  const [deepLinkStatus, setDeepLinkStatus] = useState<DeepLinkStatus>('idle');
  const attemptedTargetRef = useRef<string | null>(null); // one targeted fetch per target
  const [retryNonce, setRetryNonce] = useState(0); // forces the deep-link effect to re-run on retry
  // Tracks mount state so an in-flight targeted lookup that resolves after the component
  // unmounts (e.g. the moderator switched tabs) can't fire a late navigate() and yank them back.
  const mountedRef = useRef(true);
  useEffect(() => {
    // Set on mount (not only cleared on unmount) so a StrictMode remount restores it.
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // Reports and resolution labels fetched via server-side relay query through
  // the worker. Replaces browser-side WebSocket (nostrify NPool) which served
  // stale cached data. The worker opens a fresh WebSocket per request.
  const { data: reports, isLoading, error, refetch, isFetching, dataUpdatedAt } = useQuery({
    queryKey: ['reports', relayUrl],
    queryFn: fetchReports,
    refetchInterval: 15 * 1000,
    placeholderData: (previousData) => previousData,
    retry: false,
  });

  // resolvedTargets is subtractive: these labels HIDE work already handled, so
  // a failed fetch makes the queue bigger and wrong rather than smaller and
  // safe (#221). One retry, because a single slow relay read should not cost a
  // moderator their whole resolution filter -- this is the only polling query
  // here that retries, for that reason.
  const {
    data: labelsResult,
    error: labelsError,
    dataUpdatedAt: labelsUpdatedAt,
    isPending: labelsPending,
    fetchStatus: labelsFetchStatus,
    errorUpdateCount: labelsErrorUpdateCount,
  } = useQuery({
    queryKey: ['resolution-labels', relayUrl],
    queryFn: () => fetchResolutionLabels({ timeoutMs: RESOLUTION_READ_TIMEOUT_MS }),
    refetchInterval: 15 * 1000,
    placeholderData: (previousData) => previousData,
    retry: 1,
  });
  const resolutionLabels = labelsResult?.items;

  // Query banned pubkeys from relay (NIP-86 RPC)
  // Force fresh fetch (staleTime: 0) when deep linking to ensure accurate ban status
  const {
    data: bannedPubkeys,
    error: bannedPubkeysError,
    dataUpdatedAt: bannedPubkeysUpdatedAt,
    isPending: bannedPubkeysPending,
    fetchStatus: bannedPubkeysFetchStatus,
    errorUpdateCount: bannedPubkeysErrorUpdateCount,
  } = useQuery({
    queryKey: ['banned-pubkeys'],
    queryFn: async () => {
      try {
        return await listBannedPubkeys({ timeoutMs: RESOLUTION_READ_TIMEOUT_MS });
      } catch (error) {
        console.warn('NIP-86 listbannedpubkeys failed:', error);
        throw error; // let React Query handle it, but retry: 1 + placeholderData keeps UI stable
      }
    },
    staleTime: hasDeepLinkParams ? 0 : 30 * 1000,
    refetchInterval: 15 * 1000,
    placeholderData: (previousData) => previousData,
    retry: 1,
  });

  // Query banned/deleted events from relay (NIP-86 RPC)
  const {
    data: bannedEvents,
    error: bannedEventsError,
    dataUpdatedAt: bannedEventsUpdatedAt,
    isPending: bannedEventsPending,
    fetchStatus: bannedEventsFetchStatus,
    errorUpdateCount: bannedEventsErrorUpdateCount,
  } = useQuery({
    queryKey: ['banned-events'],
    queryFn: async () => {
      try {
        return await listBannedEvents({ timeoutMs: RESOLUTION_READ_TIMEOUT_MS });
      } catch (error) {
        console.warn('NIP-86 listbannedevents failed:', error);
        throw error;
      }
    },
    staleTime: 30 * 1000,
    refetchInterval: 15 * 1000,
    placeholderData: (previousData) => previousData,
    retry: 1,
  });

  // Query all moderation decisions from our D1 database.
  // retry: 1, not 0. The original reasoning still holds (stacking retries on a
  // cold-start timeout compounds latency), but it no longer justifies zero:
  // resolvedTargets is subtractive, so a source that gives up immediately does
  // not fail safe, it un-hides work already handled (#221). One retry buys back
  // most of the single-timeout case without stacking.
  const {
    data: decisionsResult,
    error: decisionsError,
    dataUpdatedAt: decisionsUpdatedAt,
    isPending: decisionsPending,
    fetchStatus: decisionsFetchStatus,
    errorUpdateCount: decisionsErrorUpdateCount,
  } = useQuery({
    queryKey: ['decisions'],
    queryFn: async () => {
      try {
        return await getAllDecisions({ timeoutMs: RESOLUTION_READ_TIMEOUT_MS });
      } catch (error) {
        console.warn('[Reports] Decisions query failed:', error);
        throw error;
      }
    },
    staleTime: 30 * 1000,
    refetchInterval: 15 * 1000,
    placeholderData: (previousData) => previousData,
    retry: 1,
  });
  const allDecisions = decisionsResult?.items;

  // The oldest point each capped source can still speak to, kept apart because
  // the two are load-bearing in different views. A target resolved before a
  // source's bound is invisible to whatever that source feeds, and would sit in
  // the queue forever with nothing explaining why.
  const truncationBounds = useMemo(() => ({
    labels: labelsResult?.truncated ? labelsResult.oldestCovered : null,
    decisions: decisionsResult?.truncated ? decisionsResult.oldestCovered : null,
  }), [labelsResult, decisionsResult]);

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

    // Add from resolution labels
    if (resolutionLabels) {
      for (const label of resolutionLabels) {
        const eTag = label.tags.find(t => t[0] === 'e');
        if (eTag) { resolved.add(`event:${eTag[1]}`); }
        const pTag = label.tags.find(t => t[0] === 'p');
        if (pTag) { resolved.add(`pubkey:${pTag[1]}`); }
      }
    }

    // Add banned pubkeys (now returns BannedPubkeyEntry objects)
    if (bannedPubkeys) {
      for (const entry of bannedPubkeys) {
        resolved.add(`pubkey:${entry.pubkey}`);
      }
    }

    // Add deleted events
    if (bannedEvents) {
      for (const event of bannedEvents) {
        resolved.add(`event:${event.id}`);
      }
    }

    // Add from moderation decisions (ban_user, delete_event, etc.)
    const autoHideActions: readonly string[] = AUTO_HIDE_ACTIONS;
    if (allDecisions && allDecisions.length > 0) {
      for (const decision of allDecisions) {
        if (autoHideActions.includes(decision.action)) continue;
        if (decision.target_type === 'pubkey') {
          resolved.add(`pubkey:${decision.target_id}`);
        } else if (decision.target_type === 'event') {
          resolved.add(`event:${decision.target_id}`);
        }
      }
    }

    return resolved;
  }, [resolutionLabels, bannedPubkeys, bannedEvents, allDecisions]);

  // Set of relay-banned pubkeys, used to cross-resolve an event-scoped report
  // whose author has been banned. banpubkey purges the account's events without
  // registering each in listbannedevents, so the event's own key never lands in
  // resolvedTargets; this bridges that gap. See lib/reportResolution.
  //
  // Lowercased because the predicate lowercases the report's side, and the relay
  // does not canonicalise this list: funnelcake stores whatever `banpubkey` was
  // given (its hex check accepts A-F) and `listbannedpubkeys` reads it back
  // verbatim, while our own ban call forwards the pubkey unchanged -- which for a
  // report whose event is no longer on the relay is the raw `p` tag. Matching only
  // on the report side would leave that ban unable to clear its own reports.
  // Runtime-guarded for the same reason getReportTargetIds is: this is a relay
  // payload, and a malformed entry must not take the whole queue down.
  const bannedPubkeySet = useMemo(
    () => new Set(
      (bannedPubkeys ?? []).flatMap(entry =>
        typeof entry.pubkey === 'string' ? [entry.pubkey.toLowerCase()] : []),
    ),
    [bannedPubkeys],
  );

  // Build set of targets pending review (auto-hidden but not yet confirmed/restored)
  const pendingReviewTargets = useMemo(() => {
    const pending = new Set<string>();
    if (!allDecisions) return pending;

    // Group decisions by target to check status
    const targetDecisions = new Map<string, string[]>();
    for (const decision of allDecisions) {
      const key = `${decision.target_type}:${decision.target_id}`;
      if (!targetDecisions.has(key)) {
        targetDecisions.set(key, []);
      }
      targetDecisions.get(key)!.push(decision.action);
    }

    // Decisions arrive newest first, so the first state transition is authoritative.
    for (const [key, actions] of targetDecisions) {
      const latestAction = getLatestAutoHideState(actions);
      if (latestAction === AUTO_HIDE_ACTION.hidden
        || latestAction === AUTO_HIDE_ACTION.unresolved
        || latestAction === AUTO_HIDE_ACTION.restoreFailed) {
        pending.add(key);
      }
    }


    return pending;
  }, [allDecisions]);

  // The four sources that build resolvedTargets, described once so the gate,
  // the banners, and the blocked pane read from one list and cannot drift
  // apart from EACH OTHER the way the queries themselves did. This does not
  // guarantee the list itself stays complete: a new resolution query has to
  // be added here by hand, or it silently reintroduces #221.
  interface ResolutionSource {
    key: ResolutionSourceKey;
    label: string;
    hasData: boolean;
    error: unknown;
    updatedAt: number;
    isPending: boolean;
    // True when the query is holding off fetching because the browser is
    // offline (fetchStatus 'paused'), as distinct from isPending, which stays
    // true throughout a paused wait and cannot tell "loading" from "stuck
    // offline" on its own.
    isPaused: boolean;
    // Monotonic count of settled failures. The ONLY failure signal that survives
    // a refetch: see hasColdFailed below.
    errorUpdateCount: number;
    gatesAlways: boolean;
  }

  const resolutionSources = useMemo<ResolutionSource[]>(() => [
    {
      key: 'labels',
      label: 'Resolution labels',
      hasData: !!resolutionLabels,
      error: labelsError,
      updatedAt: labelsUpdatedAt,
      isPending: labelsPending,
      isPaused: labelsFetchStatus === 'paused',
      errorUpdateCount: labelsErrorUpdateCount,
      gatesAlways: false,
    },
    {
      key: 'banned-pubkeys',
      label: 'Banned accounts',
      hasData: !!bannedPubkeys,
      error: bannedPubkeysError,
      updatedAt: bannedPubkeysUpdatedAt,
      isPending: bannedPubkeysPending,
      isPaused: bannedPubkeysFetchStatus === 'paused',
      errorUpdateCount: bannedPubkeysErrorUpdateCount,
      gatesAlways: false,
    },
    {
      key: 'banned-events',
      label: 'Banned posts',
      hasData: !!bannedEvents,
      error: bannedEventsError,
      updatedAt: bannedEventsUpdatedAt,
      isPending: bannedEventsPending,
      isPaused: bannedEventsFetchStatus === 'paused',
      errorUpdateCount: bannedEventsErrorUpdateCount,
      gatesAlways: false,
    },
    {
      // Decisions feeds pendingReviewTargets as well as resolvedTargets, and
      // pendingReviewTargets is applied on every path (filtered TO it in the
      // pending view, filtered OUT of it otherwise). So it gates regardless of
      // the hide-resolved toggle, which is what the old decisionsLoading guard
      // did for loading and failed to do for errors.
      key: 'decisions',
      label: 'Moderation decisions',
      hasData: !!allDecisions,
      error: decisionsError,
      updatedAt: decisionsUpdatedAt,
      isPending: decisionsPending,
      isPaused: decisionsFetchStatus === 'paused',
      errorUpdateCount: decisionsErrorUpdateCount,
      gatesAlways: true,
    },
  ], [
    resolutionLabels, labelsError, labelsUpdatedAt, labelsPending, labelsFetchStatus, labelsErrorUpdateCount,
    bannedPubkeys, bannedPubkeysError, bannedPubkeysUpdatedAt, bannedPubkeysPending, bannedPubkeysFetchStatus, bannedPubkeysErrorUpdateCount,
    bannedEvents, bannedEventsError, bannedEventsUpdatedAt, bannedEventsPending, bannedEventsFetchStatus, bannedEventsErrorUpdateCount,
    allDecisions, decisionsError, decisionsUpdatedAt, decisionsPending, decisionsFetchStatus, decisionsErrorUpdateCount,
  ]);

  // Models only when the LIST FILTER (the "hide resolved" toggle applied to
  // consolidated/individual) consults resolvedTargets. Three other
  // consumers -- the deep-link auto-deselect, the deep-link resolved
  // branch, and the resolved-count label -- key on hideResolved alone and
  // stay live even in the pending-review view where this is false. That is
  // deliberate, not a gap this flag should also gate: all three fail in the
  // show-more direction on a partially-loaded resolvedTargets, which is the
  // safe direction for a subtractive set, and they self-correct once the
  // source lands.
  const resolvedFilterActive = hideResolved && !showPendingReview;
  const gatingSources = resolutionSources.filter(s => s.gatesAlways || resolvedFilterActive);
  // Has this source failed with nothing to fall back on, and stayed failed?
  //
  // Reading the live `error` alone is not enough to answer that. query-core's
  // fetchState() (see the 'fetch' action in query.js) resets
  // `{error: null, status: 'pending'}` on every refetch of a query whose data is
  // undefined, and refetchInterval keeps firing on errored queries. So a source
  // that is failing continuously spends each poll cycle looking like a FIRST
  // load: blockingErrors empties, blockingLoad refills, and because the cold-load
  // skeleton is checked before the blocked pane, the moderator gets bounced back
  // to a bare skeleton with Retry and the override gone from under the cursor.
  //
  // errorUpdateCount is the counter that survives: fetchState() does not touch
  // it, and neither does the 'success' action (unlike fetchFailureCount, which
  // both reset). It only ever increments, so `hasData` turning true is what
  // releases the latch -- a source that genuinely recovers stops counting as
  // failed, and a source that fails again while HOLDING data is warm, not cold,
  // and belongs to staleSources instead.
  //
  // A live `error` is subsumed: the same reducer action sets both, so
  // errorUpdateCount > 0 whenever error is set. The isPaused exclusion keeps the
  // offline branch's precedence: a source that failed and has since gone
  // offline should say "offline", not re-report the earlier error.
  const hasColdFailed = (s: ResolutionSource) =>
    !s.hasData && !s.isPaused && s.errorUpdateCount > 0;
  const blockingLoad = gatingSources.filter(s => !s.hasData && s.isPending && !hasColdFailed(s));
  // Offline addition (#221): fetchStatus 'paused' (not isPending, which stays
  // true the whole time) is the only signal that a blocking source isn't
  // merely slow, so the block can say why instead of sitting indefinitely.
  const blockingLoadPaused = blockingLoad.filter(s => s.isPaused);
  // Paused never resolves on its own while offline (no timeout applies, see
  // ResolutionUnavailablePane's offline branch below), so once the moderator has
  // acknowledged a paused source, it can't be allowed to keep failing the
  // isLoading/blockingLoad gate the way a merely-slow source still should. Keyed
  // per source: a paused source they have NOT acknowledged still blocks.
  const blockingLoadStillBlocking = blockingLoad.filter(
    s => !(s.isPaused && acknowledgedBlockedSources.has(s.key))
  );
  // The errorUpdateCount term inside hasColdFailed is near-unreachable today:
  // past the cold-load gate above, every gating source with `!hasData` has
  // already settled, and every settled non-error source yields at least `[]`
  // (truthy), so `!hasData` alone already implies a failure in practice. Kept
  // anyway because it states the actual intent -- block on sources that FAILED,
  // not merely on sources that are empty -- and it would start mattering the
  // moment a source can settle with no data and no error (e.g. a 200 with a
  // missing field). Don't delete this as dead code.
  const blockingErrors = gatingSources.filter(hasColdFailed);
  // Sources an override is currently bypassing, whether by cold error or by an
  // indefinite offline pause -- combined because the override warning and the
  // decisions-unavailable copy read the same regardless of which reason applies.
  const currentlyBlockedSources = [...blockingErrors, ...blockingLoadPaused];
  const decisionsUnavailable = currentlyBlockedSources.some(s => s.key === 'decisions');
  // Blocked sources the moderator has already accepted. Anything blocking that
  // is NOT acknowledged re-raises the pane, so consent given for one source
  // cannot stand in for consent to a different one that failed later.
  const overriddenBlockedSources = currentlyBlockedSources.filter(
    s => acknowledgedBlockedSources.has(s.key)
  );
  const unacknowledgedPaused = blockingLoadPaused.filter(s => !acknowledgedBlockedSources.has(s.key));
  const unacknowledgedErrors = blockingErrors.filter(s => !acknowledgedBlockedSources.has(s.key));
  // Errored but still holding previous data: filter with the stale set, say so.
  const staleSources = gatingSources.filter(s => s.hasData && s.error);

  // How far back the banner can honestly claim history reaches, given which
  // capped sources are load-bearing in the current view. Gated per source for
  // the same reason gatesAlways exists: a truncated LABELS read only matters
  // where resolvedTargets is being subtracted, but a truncated DECISIONS read
  // matters everywhere, because decisions also feeds pendingReviewTargets. The
  // pending-review queue is built ENTIRELY from decisions, and switching it on
  // force-clears hideResolved -- so gating the whole banner on the resolved
  // filter switched it off in the one view most exposed to the cap, exactly
  // where an auto_hidden row aging out silently drops a target from the CSAM
  // queue.
  //
  // Math.max, not Math.min: the window can only be as deep as the MORE
  // restrictive (later) of the two bounds. Reporting the earlier one would tell
  // a moderator history reaches further back than it does.
  const activeTruncationBounds = [
    resolvedFilterActive ? truncationBounds.labels : null,
    truncationBounds.decisions,
  ].filter((v): v is number => typeof v === 'number');
  const truncatedOldestCovered = activeTruncationBounds.length > 0
    ? Math.max(...activeTruncationBounds)
    : null;

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

    // If showing pending review, only show items pending review (auto-hidden CSAM queue)
    if (showPendingReview) {
      items = items.filter(c => pendingReviewTargets.has(`${c.target.type}:${c.target.value}`));
    } else {
      // Default view: EXCLUDE auto-hidden items (moderators don't see CSAM unless they opt in)
      items = items.filter(c => !pendingReviewTargets.has(`${c.target.type}:${c.target.value}`));
      // Also filter out resolved if toggle is on
      if (hideResolved) {
        items = items.filter(c => !isConsolidatedReportResolved(c, resolvedTargets, bannedPubkeySet));
      }
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
  }, [reports, hideResolved, showPendingReview, resolvedTargets, bannedPubkeySet, pendingReviewTargets, filterCategory, filterTargetType, sortBy]);

  const allConsolidated = useMemo(() => {
    if (!reports) return [];
    return consolidateReports(reports);
  }, [reports]);

  // Filter individual reports when hideResolved is on
  const filteredReports = useMemo(() => {
    if (!reports) return [];
    let items = [...reports];

    // If showing pending review, only show items pending review (auto-hidden CSAM queue)
    if (showPendingReview) {
      items = items.filter(report => {
        const target = getReportTarget(report);
        if (!target) return false;
        return pendingReviewTargets.has(`${target.type}:${target.value}`);
      });
    } else {
      // Default view: EXCLUDE auto-hidden items (moderators don't see CSAM unless they opt in)
      items = items.filter(report => {
        const target = getReportTarget(report);
        if (!target) return true; // Keep reports without targets
        return !pendingReviewTargets.has(`${target.type}:${target.value}`);
      });
      // Also filter resolved if toggle is on
      if (hideResolved) {
        items = items.filter(report => {
          const target = getReportTarget(report);
          if (!target) return true; // Keep reports without targets
          return !isConsolidatedReportResolved(
            { target, authorPubkey: getReportTargetIds(report).pubkey },
            resolvedTargets,
            bannedPubkeySet,
          );
        });
      }
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
  }, [reports, hideResolved, showPendingReview, resolvedTargets, bannedPubkeySet, pendingReviewTargets, filterCategory, filterTargetType, sortBy]);

  const uniqueTargets = consolidated.length;
  const pendingReviewCount = pendingReviewTargets.size;
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

  // A deep link can select a report before ban/label/decision queries finish.
  // Re-check the selected target as resolution data arrives so it cannot stay
  // hidden from the list while its detail pane is open.
  useEffect(() => {
    if (!hideResolved || !selectedReport) return;
    const target = getReportTarget(selectedReport);
    if (target && isConsolidatedReportResolved(
      { target, authorPubkey: getReportTargetIds(selectedReport).pubkey },
      resolvedTargets,
      bannedPubkeySet,
    )) {
      setHideResolved(false);
    }
  }, [hideResolved, selectedReport, resolvedTargets, bannedPubkeySet]);

  // Handle deep linking via query params (?event=... or ?pubkey=... or &env=...)
  useEffect(() => {
    const eventParam = searchParams.get('event');
    const pubkeyParam = searchParams.get('pubkey');
    const envParam = searchParams.get('env');

    // Skip if no deep link target
    if (!eventParam && !pubkeyParam) return;

    // Switch environment if deep link specifies one that differs from current
    if (envParam) {
      const currentEnv = getCurrentEnvironment(config.relayUrl, config.apiUrl);
      if (currentEnv?.id !== envParam) {
        const targetEnv = getEnvironmentById(envParam);
        if (targetEnv) {
          updateConfig(c => ({ ...c, relayUrl: targetEnv.relayUrl, apiUrl: targetEnv.apiUrl }));
          queryClient.clear();
          queryClient.refetchQueries();
          return; // Data will reload, effect re-runs with matching environment
        }
      }
    }

    // Still loading the bulk list — resolving, don't conclude yet. We intentionally
    // do NOT gate on isFetchingBanned: ban data affects how a report is displayed,
    // not whether it exists, and gating on it flips a resolved pane back to
    // 'resolving' (and re-fires the lookup) on every background ban refetch.
    if (isLoading) {
      setDeepLinkStatus('resolving');
      return;
    }

    const target: { type: 'event' | 'pubkey'; value: string } | null = eventParam
      ? { type: 'event', value: eventParam }
      : pubkeyParam
      ? { type: 'pubkey', value: pubkeyParam }
      : null;
    if (!target) return;

    const inBulk = allConsolidated.find(
      c => c.target.type === target.type && c.target.value === target.value
    );

    if (inBulk) {
      // If target is resolved and we're hiding resolved, temporarily show it
      if (hideResolved && isConsolidatedReportResolved(inBulk, resolvedTargets, bannedPubkeySet)) {
        setHideResolved(false);
      }
      setSelectedReport(inBulk.latestReport);
      setDeepLinkStatus('found');
      // Navigating to the path (no query string) already clears the deep-link params;
      // a separate setSearchParams({}) here would run against the stale pre-navigate path
      // and clobber this back to /reports.
      navigate(`/reports/${inBulk.latestReport.id}`, { replace: true });
      attemptedTargetRef.current = null;
      return;
    }

    // Bulk list is loaded and the target isn't in it. Do one targeted relay fetch
    // per target to tell "aged out / vanished" apart from "still loading". Key the
    // attempt on the full target identity (relay + type + value) so a same-value
    // target across type, or a relay/environment switch, re-resolves instead of
    // reusing the prior attempt or its stale result.
    const targetKey = `${relayUrl}|${target.type}|${target.value}`;
    if (attemptedTargetRef.current === targetKey) return;
    attemptedTargetRef.current = targetKey;
    // Drop any prior selection so the resolving / gone / unavailable panes (which
    // gate on !selectedReport) render for this new target rather than stale detail.
    setSelectedReport(null);
    setDeepLinkStatus('resolving');

    (async () => {
      try {
        const events = await fetchReportsByTarget(
          target.type === 'event' ? { event: target.value } : { pubkey: target.value }
        );
        // Drop the result if this run was superseded (target changed) or the component
        // unmounted while the fetch was in flight — otherwise a late navigate() would yank
        // the moderator back to this report. (A benign same-target re-run keeps
        // attemptedTargetRef === targetKey, so this correctly still applies.)
        if (!mountedRef.current || attemptedTargetRef.current !== targetKey) return;
        // The relay's own #e/#p filter is authoritative for existence: every returned
        // report tags the deep-link target. Gate found/gone on the raw result, not on
        // reportsMatchingTarget — re-filtering by resolved target made a note-report that
        // p-tags a ?pubkey= target (but resolves to an event) a false 'gone'. An empty
        // result here is a relay-confirmed absence; an empty *timeout* never reaches this
        // branch (the worker 502s it → the catch below → 'unavailable').
        const matching = reportsMatchingTarget(events, target, getReportTarget);
        const verdict = classifyTargetedFetch(events);
        if (verdict === 'found') {
          // Prefer a report whose resolved target IS the deep-link target for display;
          // fall back to any returned report (all of them tag the target).
          const pool = matching.length > 0 ? matching : events;
          // Merge into the reports cache so the detail pane has full context,
          queryClient.setQueryData<NostrEvent[]>(['reports', relayUrl], (old) => {
            const merged = [...(old ?? [])];
            for (const e of pool) if (!merged.some(m => m.id === e.id)) merged.push(e);
            return merged;
          });
          // and select the newest report directly — not via a re-run, so a
          // consolidation mismatch can neither loop nor hang the pane on 'resolving'.
          const latest = pool.reduce((a, b) => (b.created_at > a.created_at ? b : a));
          setSelectedReport(latest);
          setDeepLinkStatus('found');
          navigate(`/reports/${latest.id}`, { replace: true });
        } else {
          setDeepLinkStatus(verdict); // 'gone' — relay-confirmed empty (timeout is a 502 → catch)
        }
      } catch {
        if (!mountedRef.current || attemptedTargetRef.current !== targetKey) return;
        setDeepLinkStatus('unavailable');
      }
    })();
  }, [allConsolidated, searchParams, hideResolved, resolvedTargets, bannedPubkeySet, navigate, isLoading, config.relayUrl, config.apiUrl, updateConfig, queryClient, fetchReportsByTarget, relayUrl, retryNonce]);

  // Update URL when report selection changes
  const handleSelectReport = (report: NostrEvent | null) => {
    // Re-clicking the already-selected report's row is a natural retry
    // gesture after a crash, but it doesn't change resetKeys — clear the
    // boundary explicitly (no-op when the pane is healthy).
    detailBoundaryRef.current?.reset();
    setSelectedReport(report);
    setDeepLinkStatus('idle'); // clear any deep-link fallback once the user interacts
    // Invalidate any in-flight targeted lookup: a user selection/dismissal
    // supersedes the deep link, so a late response must not pass the resolution
    // guard and re-navigate (e.g. closing the mobile resolving Sheet mid-lookup).
    attemptedTargetRef.current = null;
    if (report) {
      navigate(`/reports/${report.id}`, { replace: true });
    } else {
      navigate('/reports', { replace: true });
    }
  };
  // One dismiss handler shared by the healthy detail pane and its crash
  // fallback, so the two paths cannot drift.
  const dismissDetail = () => handleSelectReport(null);

  // Taking the override acknowledges exactly the sources blocking at that moment,
  // and nothing else. A source that fails later is unacknowledged, so the pane
  // re-raises and the moderator sees that source's own consent copy.
  const acknowledgeBlockedSources = (sources: ResolutionSource[]) => {
    setAcknowledgedBlockedSources(prev => {
      const next = new Set(prev);
      for (const s of sources) next.add(s.key);
      return next;
    });
  };

  // Shared by both the offline pane and the cold-error pane below so the two
  // retry paths cannot drift apart.
  const retryResolutionSources = () => {
    refetch();
    queryClient.invalidateQueries({ queryKey: ['resolution-labels'] });
    queryClient.invalidateQueries({ queryKey: ['banned-pubkeys'] });
    queryClient.invalidateQueries({ queryKey: ['banned-events'] });
    queryClient.invalidateQueries({ queryKey: ['decisions'] });
  };

  // Purely offline-blocked (a gating source is paused, not merely slow) and
  // not yet overridden: give the same Retry/override affordances as a cold
  // error, with offline-specific copy. fetchStatus 'paused' never times out
  // (React Query does not even issue the fetch), so unlike a cold error this
  // state cannot convert into blockingErrors on its own -- without this
  // branch a moderator stuck behind a `navigator.onLine` false negative
  // (captive portals, some VM/Electron/Linux net stacks) has no way forward
  // at all (#221).
  if (unacknowledgedPaused.length > 0) {
    return (
      <ResolutionUnavailablePane
        offline
        sources={blockingLoadPaused.map(s => ({ key: s.key, label: s.label }))}
        decisionsUnavailable={decisionsUnavailable}
        onRetry={retryResolutionSources}
        onOverride={() => acknowledgeBlockedSources(blockingLoadPaused)}
      />
    );
  }

  // Wait for reports AND every gating resolution source. A source that has not
  // landed contributes nothing to resolvedTargets, so rendering here would show
  // handled work as pending, and would show auto-hidden content in the default
  // view (#221).
  if (isLoading || blockingLoadStillBlocking.length > 0) {
    return (
      <Card className="h-[calc(100vh-200px)]">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Flag className="h-5 w-5" />
            Reports
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3" data-testid="reports-loading-skeleton">
            {[...Array(5)].map((_, i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  // The reports query itself failing is the more fundamental problem: if the
  // relay read is down, resolution state is beside the point, and the
  // resolution pane's Retry can't fix it anyway. Report this first (#221) --
  // but only full-pane when there is nothing to show. When a REFRESH fails
  // (e.g. the worker 502s on a relay timeout), the last good list stays
  // rendered with a stale-data warning below, so one slow poll does not look
  // like "no reports pending".
  if (error && !reports) {
    return (
      <Alert variant="destructive">
        <AlertDescription>
          Failed to load reports: {error instanceof Error ? error.message : "Unknown error"}
        </AlertDescription>
      </Alert>
    );
  }

  // A gating source failed cold (no previous data to fall back on). Rendering
  // the queue here would present handled work as pending; the moderator gets
  // an explicit, named override instead of a silent wrong list or a hard lock-out.
  if (unacknowledgedErrors.length > 0) {
    return (
      <ResolutionUnavailablePane
        sources={blockingErrors.map(s => ({ key: s.key, label: s.label }))}
        decisionsUnavailable={decisionsUnavailable}
        onRetry={retryResolutionSources}
        onOverride={() => acknowledgeBlockedSources(blockingErrors)}
      />
    );
  }

  // Built once and rendered in both the desktop pane and the mobile sheet so
  // the two views cannot drift. Reports render attacker-authored event data:
  // a crashing report degrades to the inline fallback (with the target's
  // identifiers and retry/dismiss) while the reports list stays usable (#158).
  // Lowercase to match the worker's reports filter (buildReportsFilter also
  // lowercases), so decisionsForTarget below keys off the same normalized hex
  // an uppercase-hex deep link would otherwise miss lowercase-keyed decisions.
  const deepLinkTarget = searchParams.get('event')
    ? { type: 'event' as const, value: searchParams.get('event')!.toLowerCase() }
    : { type: 'pubkey' as const, value: (searchParams.get('pubkey') ?? '').toLowerCase() };
  const showDeepLinkFallback =
    !selectedReport && hasDeepLinkParams && (deepLinkStatus === 'gone' || deepLinkStatus === 'unavailable');
  const showDeepLinkResolving =
    !selectedReport && deepLinkStatus === 'resolving' && hasDeepLinkParams;

  const reportDetailPane = showDeepLinkFallback ? (
    <DeepLinkFallback
      status={deepLinkStatus === 'gone' ? 'gone' : 'unavailable'}
      target={deepLinkTarget}
      decisions={decisionsForTarget(allDecisions, deepLinkTarget.value)}
      onRetry={() => {
        attemptedTargetRef.current = null;
        setDeepLinkStatus('resolving');
        setRetryNonce(n => n + 1);
        refetch();
      }}
    />
  ) : showDeepLinkResolving ? (
    <Card className="h-full">
      <CardContent className="p-6 text-sm text-muted-foreground">Looking up this report…</CardContent>
    </Card>
  ) : (
    <ErrorBoundary
      ref={detailBoundaryRef}
      resetKeys={[selectedReport?.id]}
      fallback={reset => (
        <ReportDetailErrorFallback
          report={selectedReport}
          onRetry={reset}
          onDismiss={dismissDetail}
        />
      )}
    >
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
        onDismiss={dismissDetail}
      />
    </ErrorBoundary>
  );

  return (
    <>
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4 h-full">
        {/* Left Pane - Report List */}
        <ErrorBoundary fallback={reset => <ReportsListErrorFallback onRetry={reset} />}>
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

          {/* Stays up for as long as the override is in effect, not a one-off
              toast, so a moderator can't forget they are looking at an
              unfiltered queue (#221). */}
          {overriddenBlockedSources.length > 0 && (
            <ResolutionOverrideWarning
              sources={overriddenBlockedSources.map(s => ({ key: s.key, label: s.label }))}
              decisionsUnavailable={decisionsUnavailable}
            />
          )}

          {staleSources.length > 0 && (
            <StaleResolutionBanner
              sources={staleSources.map(s => ({ key: s.key, label: s.label, updatedAt: s.updatedAt }))}
            />
          )}

          {truncatedOldestCovered !== null && (
            <TruncatedHistoryBanner oldestCovered={truncatedOldestCovered} />
          )}

          {/* Refresh failed but we still hold a previous list: warn instead of
              blanking the queue. The poll keeps retrying every 15s. */}
          {error && (
            <Alert variant="destructive" className="mt-2 py-2">
              <AlertDescription className="text-xs">
                Live refresh is failing. Showing reports loaded {lastUpdatedText || 'earlier'}; retrying automatically.
              </AlertDescription>
            </Alert>
          )}

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

            {/* Pending review filter */}
            {pendingReviewCount > 0 && (
              <div className="flex items-center justify-between pt-2 border-t">
                <Label htmlFor="pending-review" className="text-xs text-muted-foreground flex items-center gap-1.5">
                  <EyeOff className="h-3 w-3 text-orange-500" />
                  Pending review (auto-hidden)
                  <Badge variant="secondary" className="ml-1 text-xs px-1.5 py-0">
                    {pendingReviewCount}
                  </Badge>
                </Label>
                <Switch
                  id="pending-review"
                  checked={showPendingReview}
                  onCheckedChange={(checked) => {
                    setShowPendingReview(checked);
                    if (checked) {
                      setHideResolved(false);
                      setFilterCategory(null);
                    }
                  }}
                />
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
                onCheckedChange={(checked) => {
                  setHideResolved(checked);
                  // When hiding resolved, turn off pending review filter
                  if (checked) setShowPendingReview(false);
                }}
                disabled={showPendingReview}
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
        </ErrorBoundary>

        {/* Right Pane - Report Detail (Desktop) */}
        {!isMobile && (
          <Card className="lg:col-span-3 overflow-hidden h-full">
            {reportDetailPane}
          </Card>
        )}
      </div>

      {/* Mobile Sheet - Report Detail */}
      {isMobile && (
        <Sheet
          open={!!selectedReport || showDeepLinkResolving || showDeepLinkFallback}
          onOpenChange={(open) => !open && handleSelectReport(null)}
        >
          <SheetContent side="right" className="!w-full !max-w-[100vw] pt-10 px-0 pb-0 overflow-y-auto">
            {reportDetailPane}
          </SheetContent>
        </Sheet>
      )}
    </>
  );
}
