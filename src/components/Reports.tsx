// ABOUTME: Displays kind 1984 reports with split-pane layout and consolidation
// ABOUTME: Groups multiple reports on same target, shows count and all reporters

import { useState, useMemo, useEffect, useRef, useCallback } from "react";

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
import { classifyTargetedFetch, reportsMatchingTarget, type DeepLinkStatus } from "@/lib/deepLinkResolution";
import { useAdminApi } from "@/hooks/useAdminApi";
import { useBannedPubkeys, useBannedEvents } from "@/hooks/useRelayBanLists";
import { AUTO_HIDE_ACTION, HIGH_PRIORITY_CATEGORIES, RESOLUTION_READ_TIMEOUT_MS, getCategoryLabel, getLatestAutoHideState, getReportCategory, getReportTargetIds, hasCsamSignal } from "@/lib/constants";
import { isConsolidatedReportResolved } from "@/lib/reportResolution";
import { SWITCH_STATE_LABELS, buildSwitchMembership, humanHandledAutoHideTargets, type SwitchState } from "@/lib/sensitiveSwitch";
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

// The four polled reads that build resolvedTargets. Named at module scope so the
// acknowledged-override state can be keyed by it.
type ResolutionSourceKey = 'labels' | 'banned-pubkeys' | 'banned-events' | 'decisions';

// Category priority for sorting
function getCategoryPriority(categories: string[], csamSignal = false): number {
  if (csamSignal || categories.some(c => HIGH_PRIORITY_CATEGORIES.includes(c))) return 0;
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

// Says which side of the Pending review switch a row is on. Rendered only for
// rows behind the switch, so the default view carries no extra label.
function SwitchStateBadge({ state }: { state?: SwitchState }) {
  if (!state) return null;
  return (
    <Badge variant="outline" className="text-xs">
      {SWITCH_STATE_LABELS[state]}
    </Badge>
  );
}

function ConsolidatedReportItem({
  consolidated,
  isSelected,
  onClick,
  switchState,
}: {
  consolidated: ConsolidatedReport;
  isSelected: boolean;
  onClick: () => void;
  switchState?: SwitchState;
}) {
  const reportCount = consolidated.reports.length;
  const reporterCount = consolidated.reporters.length;
  const primaryCategory = consolidated.categories[0];
  const categoryLabel = getCategoryLabel(primaryCategory);
  const isHighPriority = consolidated.categories.some(c => HIGH_PRIORITY_CATEGORIES.includes(c))
    || hasCsamSignal(consolidated.reports);
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
            <SwitchStateBadge state={switchState} />
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
  switchState,
}: {
  report: NostrEvent;
  isSelected: boolean;
  onClick: () => void;
  switchState?: SwitchState;
}) {
  const category = getReportCategory(report);
  const target = getReportTarget(report);
  const categoryLabel = getCategoryLabel(category);
  const isHighPriority = HIGH_PRIORITY_CATEGORIES.includes(category) || hasCsamSignal([report]);
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
            <SwitchStateBadge state={switchState} />
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
  const { getDecisions, fetchReports, fetchReportsByTarget, fetchResolutionState, fetchResolutionLabelTargets } = useAdminApi();
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
  // Whether a targeted lookup stopped before reading a target's whole report
  // history. The floor mark describes that target's report list, so it is
  // keyed to the target (on its relay), not to the one report the lookup
  // selected: any report of that target reads it as true, and a report of any
  // other target, or the same target after a relay switch, reads it as false.
  const [targetedHistory, setTargetedHistory] =
    useState<{ relayUrl: string; target: ReportTarget; truncated: boolean } | null>(null);
  const selectedTarget = selectedReport ? getReportTarget(selectedReport) : null;
  const targetedHistoryTruncated =
    targetedHistory !== null && targetedHistory.truncated && selectedTarget !== null
    && targetedHistory.relayUrl === relayUrl
    && targetedHistory.target.type === selectedTarget.type
    && targetedHistory.target.value === selectedTarget.value;
  const attemptedTargetRef = useRef<string | null>(null); // one targeted fetch per target
  // True only while the CURRENT selection came from a deep link. A ref, not
  // state: the unhide effect reads it when it runs, and flipping it must not
  // itself cause a render.
  const deepLinkSelectedRef = useRef(false);
  // What the moderator had set before entering the pending-review view. That
  // view is its own mode and forces Hide resolved off and the category filter
  // clear, so leaving it has to hand both back -- otherwise a look at the
  // auto-hidden queue silently spends settings they chose.
  const prePendingReviewRef = useRef<{ hideResolved: boolean; filterCategory: string | null } | null>(null);
  // Hide resolved as the moderator had it before a deep link's courtesy last
  // turned it off to show a resolved linked report. Null until a courtesy
  // does, and again once the moderator sets Hide resolved or the switch
  // themselves. If the link opens the switch later, for a target only a later
  // read showed to be auto-hidden, it saves this rather than the courtesy's
  // "off".
  const hideResolvedBeforeCourtesyRef = useRef<boolean | null>(null);
  // True only while the pending-review switch is on because a deep link
  // opened it, not the moderator. Only then may the switch close itself when
  // the linked target leaves it; a switch the moderator turned on is theirs.
  const switchOpenedByDeepLinkRef = useRef(false);
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
    queryKey: ['resolution-label-targets', relayUrl],
    queryFn: () => fetchResolutionLabelTargets({ timeoutMs: RESOLUTION_READ_TIMEOUT_MS }),
    // 60s, not the 15s the other sources use. This one walks every page of
    // resolution labels on the relay (two today, and one more every few
    // months), so a 15s poll opens a socket per page per tab per interval to
    // re-derive a set that barely moves. A moderator's OWN action still clears
    // instantly, because the action handlers (ReportDetail, UserActions,
    // EventActions) invalidate ['resolution-state'] and, for label-writing
    // actions, this query -- not because of either poll. Only another
    // moderator's label-only resolution can lag, by at most a minute.
    refetchInterval: 60 * 1000,
    placeholderData: (previousData) => previousData,
    retry: 1,
  });
  const labelTargets = labelsResult?.targets;

  // Query banned pubkeys from relay (NIP-86 RPC)
  // Force fresh fetch (staleTime: 0) when deep linking to ensure accurate ban status
  const {
    data: bannedPubkeys,
    error: bannedPubkeysError,
    dataUpdatedAt: bannedPubkeysUpdatedAt,
    isPending: bannedPubkeysPending,
    fetchStatus: bannedPubkeysFetchStatus,
    errorUpdateCount: bannedPubkeysErrorUpdateCount,
  } = useBannedPubkeys({
    // 0 on a deep link so an arriving report reads current ban status rather
    // than a cached one.
    staleTime: hasDeepLinkParams ? 0 : 30 * 1000,
    refetchInterval: 15 * 1000,
  });

  // Query banned/deleted events from relay (NIP-86 RPC)
  const {
    data: bannedEvents,
    error: bannedEventsError,
    dataUpdatedAt: bannedEventsUpdatedAt,
    isPending: bannedEventsPending,
    fetchStatus: bannedEventsFetchStatus,
    errorUpdateCount: bannedEventsErrorUpdateCount,
  } = useBannedEvents({ refetchInterval: 15 * 1000 });

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
    queryKey: ['resolution-state'],
    queryFn: async () => {
      try {
        return await fetchResolutionState({ timeoutMs: RESOLUTION_READ_TIMEOUT_MS });
      } catch (error) {
        console.warn('[Reports] Resolution state query failed:', error);
        throw error;
      }
    },
    staleTime: 30 * 1000,
    refetchInterval: 15 * 1000,
    placeholderData: (previousData) => previousData,
    retry: 1,
  });
  const resolvedDecisionTargets = decisionsResult?.resolved;
  const autoHideStates = decisionsResult?.states;
  // The switch's auto-hidden members come only from this read, so membership
  // is known once it has answered. A read that failed, or one paused because
  // the browser is offline (which never settles on its own), leaves membership
  // unknown, but this still treats it as settled. So a deep link's
  // resolved-unhide is held, never stranded: on those reads it falls back to
  // unhiding as it did before the hold.
  const switchMembershipKnown = !decisionsPending || decisionsFetchStatus === 'paused';

  // The deep-link target, resolved here rather than beside the pane that renders
  // it: the per-target decisions read below is a hook, and the pane sits after
  // this component's early returns.
  const deepLinkTarget = searchParams.get('event')
    ? { type: 'event' as const, value: searchParams.get('event')!.toLowerCase() }
    : { type: 'pubkey' as const, value: (searchParams.get('pubkey') ?? '').toLowerCase() };

  // The fallback pane used to filter the bulk decisions list, which was capped at
  // the newest 1000 rows -- so "No prior moderation actions recorded for this
  // target" could be a statement about the cap rather than about the target.
  // GET /api/decisions/<id> has no cap, so the claim is now answerable -- once
  // the read has answered. `data` stays undefined until then, and the pane
  // renders that as loading (or as failed) rather than as an empty history.
  const { data: deepLinkDecisions, isError: deepLinkDecisionsFailed } = useQuery({
    queryKey: ['decisions', deepLinkTarget.value],
    queryFn: () => getDecisions(deepLinkTarget.value),
    enabled: hasDeepLinkParams
      && !!deepLinkTarget.value
      && (deepLinkStatus === 'gone' || deepLinkStatus === 'unavailable'),
    staleTime: 30 * 1000,
  });

  // The oldest point each capped source can still speak to, kept apart because
  // the two are load-bearing in different views. A target resolved before a
  // source's bound is invisible to whatever that source feeds, and would sit in
  // the queue forever with nothing explaining why.
  // Only the label source can still report a bound, and only if the relay pager
  // hits its page cap -- a safety valve, not a working limit. The decisions read
  // is now a projection over the whole table with no cap, so it has no bound to
  // report and no entry here.
  const truncationBounds = useMemo(() => ({
    labels: labelsResult?.truncated ? labelsResult.oldestCovered : null,
  }), [labelsResult]);

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
  //
  // handledTargets is the same set without the decisions only the worker wrote
  // (`automated`, today an age-review case it opened on a reported account).
  // Only the sensitive switch reads it: Hide resolved still counts those
  // targets as handled, but no person has looked at them.
  const { resolvedTargets, handledTargets } = useMemo(() => {
    const resolved = new Set<string>();

    // Add from resolution labels. The worker now walks every page of labels and
    // reduces them to target keys, so this no longer re-derives tags in the
    // browser over a single capped page.
    if (labelTargets) {
      for (const target of labelTargets) {
        resolved.add(`${target.type}:${target.value}`);
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

    const handled = new Set(resolved);

    // Add from moderation decisions (ban_user, delete_event, etc.). The worker
    // already excluded auto-hide actions and collapsed the table to distinct
    // targets, so what arrives here is the resolved set itself rather than a
    // capped window of decision rows to filter down.
    if (resolvedDecisionTargets) {
      for (const target of resolvedDecisionTargets) {
        if (target.target_type === 'pubkey' || target.target_type === 'event') {
          const key = `${target.target_type}:${target.target_id}`;
          resolved.add(key);
          if (!target.automated) handled.add(key);
        }
      }
    }

    return { resolvedTargets: resolved, handledTargets: handled };
  }, [labelTargets, bannedPubkeys, bannedEvents, resolvedDecisionTargets]);

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

  // Targets pending review (auto-hidden but not yet confirmed/restored), keyed
  // to their latest auto-hide state so a row can say when a hide needs a check
  // (auto_hide_unresolved / auto_hide_restore_failed).
  // TODO(#284): share this with pendingReviewTargetKeys in shared/autohide.ts in the
  // queue-screen change. That helper returns a Set, so it would first need to
  // return the latest action per key, which the switch labels depend on.
  const pendingReviewTargets = useMemo(() => {
    const pending = new Map<string, string>();
    if (!autoHideStates) return pending;

    // Group by target to check status. The worker sends only the auto-hide STATE
    // actions, already newest-first, which is exactly what
    // getLatestAutoHideState reads -- that function stays the sole authority on
    // what the state machine means, and is still applied here rather than in SQL.
    const targetDecisions = new Map<string, string[]>();
    for (const decision of autoHideStates) {
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
        pending.set(key, latestAction);
      }
    }

    return pending;
  }, [autoHideStates]);

  const humanHandledTargets = useMemo(
    () => humanHandledAutoHideTargets(autoHideStates ?? []),
    [autoHideStates],
  );

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
      hasData: !!labelTargets,
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
      // Decisions feeds the switch membership (through pendingReviewTargets)
      // as well as resolvedTargets, and the membership is applied on every
      // path (filtered TO it in the pending view, filtered OUT of it
      // otherwise). So it gates regardless of the hide-resolved toggle, which
      // is what the old decisionsLoading guard did for loading and failed to
      // do for errors.
      key: 'decisions',
      label: 'Moderation decisions',
      hasData: !!resolvedDecisionTargets,
      error: decisionsError,
      updatedAt: decisionsUpdatedAt,
      isPending: decisionsPending,
      isPaused: decisionsFetchStatus === 'paused',
      errorUpdateCount: decisionsErrorUpdateCount,
      gatesAlways: true,
    },
  ], [
    labelTargets, labelsError, labelsUpdatedAt, labelsPending, labelsFetchStatus, labelsErrorUpdateCount,
    bannedPubkeys, bannedPubkeysError, bannedPubkeysUpdatedAt, bannedPubkeysPending, bannedPubkeysFetchStatus, bannedPubkeysErrorUpdateCount,
    bannedEvents, bannedEventsError, bannedEventsUpdatedAt, bannedEventsPending, bannedEventsFetchStatus, bannedEventsErrorUpdateCount,
    resolvedDecisionTargets, decisionsError, decisionsUpdatedAt, decisionsPending, decisionsFetchStatus, decisionsErrorUpdateCount,
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

  // How far back the banner can honestly claim history reaches. Only the label
  // source can still report a bound, and only if the relay pager hits its page
  // cap -- a safety valve that nothing reaches today, not a working limit. The
  // decisions source used to carry a bound too, and it was the one that mattered
  // everywhere, because it also feeds pendingReviewTargets; that read is now
  // uncapped, so it has no bound to contribute.
  //
  // Still gated on resolvedFilterActive: a bounded LABELS read only matters
  // where resolvedTargets is actually being subtracted. It contributes nothing
  // to pendingReviewTargets, which is built entirely from the decisions source.
  // It does feed the switch's not-hidden group, but only subtractively: a
  // label missing from a bounded read keeps a CSAM target behind the switch
  // rather than in the default view, which is the safe direction.
  const activeTruncationBounds = [
    resolvedFilterActive ? truncationBounds.labels : null,
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

  const allConsolidated = useMemo(() => {
    if (!reports) return [];
    return consolidateReports(reports);
  }, [reports]);

  // Who sits behind the Pending review switch: every auto-hidden target, plus
  // any loaded target with a CSAM signal that no person has handled yet. It
  // does not read hideResolved; see buildSwitchMembership.
  const switchMembership = useMemo(() => buildSwitchMembership({
    consolidated: allConsolidated,
    pendingReview: pendingReviewTargets,
    humanHandled: humanHandledTargets,
    handledTargets,
    bannedPubkeys: bannedPubkeySet,
  }), [allConsolidated, pendingReviewTargets, humanHandledTargets, handledTargets, bannedPubkeySet]);

  const consolidated = useMemo(() => {
    // A copy, so the in-place sort below can never reorder allConsolidated.
    // Today both view branches filter into a new array first, so this is
    // belt and braces against a later change that drops a filter.
    let items = [...allConsolidated];

    // If showing pending review, only show items behind the switch
    if (showPendingReview) {
      items = items.filter(c => switchMembership.has(`${c.target.type}:${c.target.value}`));
    } else {
      // Default view: EXCLUDE items behind the switch (moderators don't see CSAM unless they opt in)
      items = items.filter(c => !switchMembership.has(`${c.target.type}:${c.target.value}`));
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

    // Classify each target once, not on every comparison: the CSAM signal
    // reads each report's content.
    const categoryPriority = new Map<ConsolidatedReport, number>();
    if (sortBy === 'category') {
      for (const c of items) {
        categoryPriority.set(c, getCategoryPriority(c.categories, hasCsamSignal(c.reports)));
      }
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
          const aPriority = categoryPriority.get(a)!;
          const bPriority = categoryPriority.get(b)!;
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
  }, [allConsolidated, hideResolved, showPendingReview, resolvedTargets, bannedPubkeySet, switchMembership, filterCategory, filterTargetType, sortBy]);

  const authorByTarget = useMemo(() => new Map(
    allConsolidated.map(c => [`${c.target.type}:${c.target.value}`, c.authorPubkey]),
  ), [allConsolidated]);

  // Filter individual reports when hideResolved is on
  const filteredReports = useMemo(() => {
    if (!reports) return [];
    let items = [...reports];

    // If showing pending review, only show items behind the switch
    if (showPendingReview) {
      items = items.filter(report => {
        const target = getReportTarget(report);
        if (!target) return false;
        return switchMembership.has(`${target.type}:${target.value}`);
      });
    } else {
      // Default view: EXCLUDE items behind the switch (moderators don't see CSAM unless they opt in)
      items = items.filter(report => {
        const target = getReportTarget(report);
        if (!target) return true; // Keep reports without targets
        return !switchMembership.has(`${target.type}:${target.value}`);
      });
      // Also filter resolved if toggle is on
      if (hideResolved) {
        items = items.filter(report => {
          const target = getReportTarget(report);
          if (!target) return true; // Keep reports without targets
          return !isConsolidatedReportResolved(
            { target, authorPubkey: authorByTarget.get(`${target.type}:${target.value}`) },
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

    // Classify each report once, not on every comparison: the CSAM signal
    // reads its content.
    const categoryKeys = new Map<NostrEvent, { category: string; priority: number }>();
    if (sortBy === 'category') {
      for (const report of items) {
        const category = getReportCategory(report);
        categoryKeys.set(report, { category, priority: getCategoryPriority([category], hasCsamSignal([report])) });
      }
    }

    // Apply sorting
    items.sort((a, b) => {
      switch (sortBy) {
        case 'newest':
          return b.created_at - a.created_at;
        case 'oldest':
          return a.created_at - b.created_at;
        case 'category': {
          const aKey = categoryKeys.get(a)!;
          const bKey = categoryKeys.get(b)!;
          if (aKey.priority !== bKey.priority) return aKey.priority - bKey.priority;
          return aKey.category.localeCompare(bKey.category);
        }
        default:
          // For 'reports' and 'reporters', just use date for individual view
          return b.created_at - a.created_at;
      }
    });

    return items;
  }, [reports, hideResolved, showPendingReview, resolvedTargets, bannedPubkeySet, authorByTarget, switchMembership, filterCategory, filterTargetType, sortBy]);

  const uniqueTargets = consolidated.length;
  const pendingReviewCount = switchMembership.size;
  const totalTargets = allConsolidated.length;
  const totalReports = reports?.length || 0;
  const filteredReportsCount = filteredReports.length;
  // Loaded targets behind the switch are pending review, not resolved, so the
  // header's "N resolved" must not count them.
  const switchMembersLoaded = allConsolidated.filter(
    c => switchMembership.has(`${c.target.type}:${c.target.value}`),
  ).length;
  const resolvedCount = totalTargets - uniqueTargets - switchMembersLoaded;

  // Sync selected report with URL
  useEffect(() => {
    if (selectedReportId && reports && !selectedReport) {
      const report = reports.find(r => r.id === selectedReportId);
      if (report) {
        // Arriving at /reports/<id> directly -- a shared link, or a reload after
        // following a Zendesk deep link -- is a deep-link selection too, and
        // needs the same unhide. Safe against the bug this scoping fixes:
        // handleSelectReport(null) navigates to /reports, so the id is gone and
        // this cannot re-select behind a dismissal.
        deepLinkSelectedRef.current = true;
        setSelectedReport(report);
      }
    }
  }, [selectedReportId, reports, selectedReport]);

  // A deep link can select a report before ban/label/decision queries finish.
  // Re-check the selected target as resolution data arrives so it cannot stay
  // hidden from the list while its detail pane is open.
  //
  // Scoped to DEEP-LINK selections only. Unscoped, this fights the moderator:
  // `resolvedTargets` is a dependency and changes on every poll and after every
  // action, so opening a report and actioning it force-cleared Hide resolved
  // underneath them, and clicking it back on re-ran the same branch and cleared
  // it again. Reloading appeared to fix it only because that drops
  // selectedReport. #274 made it far more frequent by widening resolvedTargets
  // from a week to all of history, which is when moderators started reporting it.
  //
  // Held until switch membership is known. Labels or bans can resolve the
  // target first; unhiding then would turn Hide resolved off before the switch
  // opens, and the switch would save "off" as the moderator's setting.
  useEffect(() => {
    if (!hideResolved || !selectedReport || !deepLinkSelectedRef.current || !switchMembershipKnown) return;
    const target = getReportTarget(selectedReport);
    if (target && isConsolidatedReportResolved(
      { target, authorPubkey: authorByTarget.get(`${target.type}:${target.value}`) },
      resolvedTargets,
      bannedPubkeySet,
    )) {
      hideResolvedBeforeCourtesyRef.current = hideResolved;
      setHideResolved(false);
    }
  }, [hideResolved, selectedReport, resolvedTargets, bannedPubkeySet, authorByTarget, switchMembershipKnown]);

  // Memoized because the deep-link effect below depends on it; it reads
  // hideResolved and filterCategory, so it changes only when those do.
  const enterPendingReview = useCallback(() => {
    setShowPendingReview(true);
    // A failed or offline read counts as settled, so a link's courtesy can
    // turn Hide resolved off before a later read opens the switch. Saving that
    // "off" would hand it back when the switch closes.
    prePendingReviewRef.current = {
      hideResolved: hideResolvedBeforeCourtesyRef.current ?? hideResolved,
      filterCategory,
    };
    setHideResolved(false);
    setFilterCategory(null);
  }, [hideResolved, filterCategory]);

  // Memoized for the same reason: the auto-leave effect below depends on it.
  const leavePendingReview = useCallback(({ keepDeepLinkCourtesy = false } = {}) => {
    setShowPendingReview(false);
    // Turning the switch off is a stated preference, so the deep-link arrival
    // courtesy is spent, as the Hide resolved handler does. Without this the
    // effect below sees the deep-linked report still open behind the switch
    // and turns it straight back on, then again on every poll. The auto-leave
    // is not the moderator's choice, so it keeps the courtesy.
    if (!keepDeepLinkCourtesy) deepLinkSelectedRef.current = false;
    const previous = prePendingReviewRef.current;
    if (previous) {
      setHideResolved(previous.hideResolved);
      // Only hand the category back if the moderator did not
      // choose one inside the view. The chips stay live in
      // there, so an in-view pick is a deliberate choice, and
      // overwriting it would be the same silent discard this
      // is meant to stop.
      if (filterCategory === null) {
        setFilterCategory(previous.filterCategory);
      }
      prePendingReviewRef.current = null;
    }
  }, [filterCategory]);

  // A link that lands on a report behind the pending-review switch opens the
  // switch, or the report sits in the detail pane with no row in the list.
  // Same scoping as the resolved-unhide effect above, and for the same reason:
  // DEEP-LINK selections only. A report the moderator clicked is already in
  // the view they chose, and switchMembership is rebuilt on every poll, so an
  // unscoped effect would reopen the switch underneath them every 15s.
  useEffect(() => {
    if (showPendingReview || !selectedReport || !deepLinkSelectedRef.current) return;
    const target = getReportTarget(selectedReport);
    if (target && switchMembership.has(`${target.type}:${target.value}`)) {
      enterPendingReview();
      switchOpenedByDeepLinkRef.current = true;
    }
  }, [showPendingReview, selectedReport, switchMembership, enterPendingReview]);

  // The other half: a switch a deep link opened closes again once the linked
  // target leaves it. While resolution sources load, an unresolved-looking
  // CSAM target counts as a member, so the effect above can open the switch
  // for a target that turns out to be resolved. The switch view shows members
  // only and Hide resolved is off inside it, so the resolved-unhide effect
  // cannot help, and the open report would have no row. Leaving keeps the
  // deep-link courtesy, so that effect then shows it in the default view.
  // A switch the moderator turned on is never closed for them.
  useEffect(() => {
    if (!showPendingReview || !switchOpenedByDeepLinkRef.current || !selectedReport) return;
    const target = getReportTarget(selectedReport);
    if (target && !switchMembership.has(`${target.type}:${target.value}`)) {
      switchOpenedByDeepLinkRef.current = false;
      leavePendingReview({ keepDeepLinkCourtesy: true });
    }
  }, [showPendingReview, selectedReport, switchMembership, leavePendingReview]);

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
      // If target is resolved and we're hiding resolved, temporarily show it.
      // Not for a switch member: the switch-opening effect turns Hide resolved
      // off itself and saves the moderator's setting first. Turning it off here
      // would make the switch save "off" and hand that back when it closes.
      // Held until membership is known; the resolved-unhide effect above
      // applies it once it is.
      if (
        hideResolved
        && switchMembershipKnown
        && !switchMembership.has(`${inBulk.target.type}:${inBulk.target.value}`)
        && isConsolidatedReportResolved(inBulk, resolvedTargets, bannedPubkeySet)
      ) {
        hideResolvedBeforeCourtesyRef.current = hideResolved;
        setHideResolved(false);
      }
      deepLinkSelectedRef.current = true;
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
        const { events, truncated } = await fetchReportsByTarget(
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
        if (truncated && events.length === 0) {
          setDeepLinkStatus('unavailable');
          return;
        }
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
          deepLinkSelectedRef.current = true;
          setSelectedReport(latest);
          // Keyed by the selected report's own target, which is the list the
          // pane counts; it can differ from the deep-link target when no
          // returned report resolves to it (the fallback pool above).
          const latestTarget = getReportTarget(latest);
          setTargetedHistory(latestTarget ? { relayUrl, target: latestTarget, truncated } : null);
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
  }, [allConsolidated, searchParams, hideResolved, resolvedTargets, bannedPubkeySet, switchMembership, switchMembershipKnown, navigate, isLoading, config.relayUrl, config.apiUrl, updateConfig, queryClient, fetchReportsByTarget, relayUrl, retryNonce]);

  // Update URL when report selection changes
  const handleSelectReport = (report: NostrEvent | null) => {
    // Re-clicking the already-selected report's row is a natural retry
    // gesture after a crash, but it doesn't change resetKeys — clear the
    // boundary explicitly (no-op when the pane is healthy).
    detailBoundaryRef.current?.reset();
    // A manual pick supersedes any deep link, so the unhide effect must not
    // treat this selection as one.
    deepLinkSelectedRef.current = false;
    // Nor may the switch close itself under a report the moderator picked.
    switchOpenedByDeepLinkRef.current = false;
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
  //
  // These keys are hand-written and must match the queryKey of every source in
  // resolutionSources. Nothing type-checks that: a renamed key leaves Retry
  // invalidating a query that no longer exists, so the button appears to do
  // nothing and the blocked pane never clears.
  const retryResolutionSources = () => {
    refetch();
    queryClient.invalidateQueries({ queryKey: ['resolution-label-targets'] });
    queryClient.invalidateQueries({ queryKey: ['banned-pubkeys'] });
    queryClient.invalidateQueries({ queryKey: ['banned-events'] });
    queryClient.invalidateQueries({ queryKey: ['resolution-state'] });
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
  // deepLinkTarget is lowercased where it is built, matching the worker's
  // reports filter (reportsMode lowercases too), so the per-target
  // decisions read keys off the same normalized hex an uppercase-hex deep link
  // would otherwise miss.
  const showDeepLinkFallback =
    !selectedReport && hasDeepLinkParams && (deepLinkStatus === 'gone' || deepLinkStatus === 'unavailable');
  const showDeepLinkResolving =
    !selectedReport && deepLinkStatus === 'resolving' && hasDeepLinkParams;

  // The open report's side of the switch, so the pane carries the row's label.
  const selectedSwitchKey = selectedTarget ? `${selectedTarget.type}:${selectedTarget.value}` : undefined;

  const reportDetailPane = showDeepLinkFallback ? (
    <DeepLinkFallback
      status={deepLinkStatus === 'gone' ? 'gone' : 'unavailable'}
      target={deepLinkTarget}
      decisions={deepLinkDecisions}
      decisionsFailed={deepLinkDecisionsFailed}
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
        allReportsForTargetTruncated={targetedHistoryTruncated}
        allReports={reports || []}
        onDismiss={dismissDetail}
        switchState={selectedSwitchKey ? switchMembership.get(selectedSwitchKey) : undefined}
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
                      {getCategoryLabel(filterCategory)}
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
                      {getCategoryLabel(cat)}
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            {/* Pending review filter */}
            {/* Stays rendered while on, even at zero: finishing the last item
                would otherwise remove the only way back, since Hide resolved
                is disabled while this is on. */}
            {(pendingReviewCount > 0 || showPendingReview) && (
              <div className="flex items-center justify-between pt-2 border-t">
                <Label htmlFor="pending-review" className="text-xs text-muted-foreground flex items-center gap-1.5">
                  <EyeOff className="h-3 w-3 text-orange-500" />
                  Pending review (sensitive)
                  <Badge variant="secondary" className="ml-1 text-xs px-1.5 py-0">
                    {pendingReviewCount}
                  </Badge>
                </Label>
                <Switch
                  id="pending-review"
                  checked={showPendingReview}
                  onCheckedChange={(checked) => {
                    // The moderator owns the switch from here on.
                    switchOpenedByDeepLinkRef.current = false;
                    // Opened by hand, the switch saves Hide resolved as it is
                    // on screen: a value a link's courtesy remembered is only
                    // for a switch that link opens.
                    hideResolvedBeforeCourtesyRef.current = null;
                    if (checked) enterPendingReview();
                    else leavePendingReview();
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
              {/* A switch dimmed to 50% still reads as live, and clicking it
                  does nothing -- one of the shapes the "toggles don't work"
                  report took. Say why it is inert. Referenced by
                  aria-describedby rather than nested in the Label, so the
                  switch keeps "Hide resolved" as its accessible NAME and this
                  becomes its description. Nesting it made the control's name
                  contain "Pending review" and collide with that switch. */}
              {showPendingReview && (
                <span id="hide-resolved-disabled-reason" className="text-[10px] italic opacity-70">
                  unavailable while Pending review is on
                </span>
              )}
              <Switch
                id="hide-resolved"
                checked={hideResolved}
                onCheckedChange={(checked) => {
                  // The moderator has stated a preference, so the deep-link
                  // arrival courtesy is spent. Without this, re-enabling the
                  // toggle re-arms the effect that just cleared it.
                  deepLinkSelectedRef.current = false;
                  hideResolvedBeforeCourtesyRef.current = null;
                  setHideResolved(checked);
                  // When hiding resolved, turn off pending review filter
                  if (checked) setShowPendingReview(false);
                }}
                disabled={showPendingReview}
                aria-describedby={showPendingReview ? 'hide-resolved-disabled-reason' : undefined}
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
                  consolidated.map((item) => {
                    const key = `${item.target.type}:${item.target.value}`;
                    return (
                      <ConsolidatedReportItem
                        key={key}
                        consolidated={item}
                        isSelected={selectedReport?.id === item.latestReport.id}
                        onClick={() => handleSelectReport(item.latestReport)}
                        switchState={switchMembership.get(key)}
                      />
                    );
                  })
                )
              ) : (
                filteredReports.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground">
                    <Flag className="h-8 w-8 mx-auto mb-2 opacity-50" />
                    <p className="text-sm">No reports found</p>
                  </div>
                ) : (
                  filteredReports.map((report) => {
                    const target = getReportTarget(report);
                    const key = target ? `${target.type}:${target.value}` : undefined;
                    return (
                      <IndividualReportItem
                        key={report.id}
                        report={report}
                        isSelected={selectedReport?.id === report.id}
                        onClick={() => handleSelectReport(report)}
                        switchState={key ? switchMembership.get(key) : undefined}
                      />
                    );
                  })
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
