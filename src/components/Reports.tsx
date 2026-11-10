// ABOUTME: Displays kind 1984 reports with split-pane layout and consolidation
// ABOUTME: Groups multiple reports on same target, shows count and all reporters

import { useState, useMemo, useEffect, useRef, useCallback, useLayoutEffect } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAppContext } from "@/hooks/useAppContext";
import { getEnvironmentById, getCurrentEnvironment } from "@/lib/environments";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { QueueTruncatedBanner, ResolutionUnavailablePane, ResolutionOverrideWarning, StaleResolutionBanner, TruncatedHistoryBanner } from "@/components/ResolutionStateNotice";
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
  ChevronDown,
} from "lucide-react";
import { nip19 } from "nostr-tools";
import { ReportDetail } from "@/components/ReportDetail";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { ReportDetailErrorFallback } from "@/components/ReportDetailErrorFallback";
import { DeepLinkFallback } from "@/components/DeepLinkFallback";
import { ReportClientText } from "@/components/ReportClientText";
import { classifyTargetedFetch, reportsMatchingTarget, type DeepLinkStatus } from "@/lib/deepLinkResolution";
import { useAdminApi } from "@/hooks/useAdminApi";
import { isLoadMoreFailure, rememberLoadMoreFailure } from "@/lib/loadMoreFailure";
import { useResolvedHistory } from "@/hooks/useResolvedHistory";
import { useBannedPubkeys, useBannedEvents } from "@/hooks/useRelayBanLists";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { HIGH_PRIORITY_CATEGORIES, RESOLUTION_READ_TIMEOUT_MS, getCategoryLabel, getReportCategory, hasCsamSignal } from "@/lib/constants";
import { consolidateReports, reportTargetKeys, type ConsolidatedReport } from "@/lib/consolidateReports";
import { historyCount } from "@/lib/historyCount";
import { isConsolidatedReportResolved } from "@/lib/reportResolution";
import { SWITCH_STATE_LABELS, buildSwitchMembership, humanHandledAutoHideTargets, type SwitchState } from "@/lib/sensitiveSwitch";
import { mergeReportFeeds } from "@/lib/reportFeeds";
import { historyFooterState } from "@/lib/historyFooter";
import { captureScrollAnchor, restoreScrollAnchor, type ScrollAnchor } from "@/lib/scrollAnchor";
import { ResolvedHistoryFooter } from "@/components/ResolvedHistoryFooter";
import { getReportTarget, getWrittenReportTarget, reportTargetKey, type ReportTarget } from "../../shared/report-target";
import { canonicalHex64, hexTagFilterValues } from "../../shared/hex-id";
import { pendingReviewTargetStates } from "../../shared/autohide";
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

// The Filters section's open state, per browser. Open unless the moderator
// closed it. Storage can throw (private mode, storage disabled): then it opens
// by default and toggling still works for the session.
const FILTERS_OPEN_KEY = 'reports:filters-open';
function readFiltersOpen(): boolean {
  try {
    return localStorage.getItem(FILTERS_OPEN_KEY) !== '0';
  } catch {
    return true;
  }
}
function writeFiltersOpen(open: boolean): void {
  try {
    localStorage.setItem(FILTERS_OPEN_KEY, open ? '1' : '0');
  } catch {
    // Remembering is a convenience; the toggle already changed on screen.
  }
}

const MEDIUM_PRIORITY_CATEGORIES = ['doxxing_pii', 'malware_scam', 'illegal_goods'];

// How often the queue re-reads the reports that need attention. Each read
// walks every report on the relay and, inside the worker, every resolution
// label and both decision projections, so it runs once a minute: new reports
// reach the queue within a minute. Handled work still leaves sooner, because
// the resolution reads below keep their own cadence (decisions and both ban
// lists every 15s).
// A moderator's own resolve or reopen refreshes this read at once
// (invalidateResolutionState).
const QUEUE_POLL_MS = 60 * 1000;

const NO_REPORTS: NostrEvent[] = [];

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
  countTruncated = false,
}: {
  consolidated: ConsolidatedReport;
  isSelected: boolean;
  onClick: () => void;
  switchState?: SwitchState;
  // The reports of this target may be more than the count: the read that
  // loaded them stopped early. Shown as "N+", as in the open pane.
  countTruncated?: boolean;
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
      data-row-key={reportTargetKey(consolidated.target)}
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
            {countTruncated ? `${historyCount(reportCount, true)} reports` : `${reportCount} report${reportCount !== 1 ? 's' : ''}`}
          </span>
          <span className="flex items-center gap-1 text-muted-foreground">
            <Users className="h-3 w-3" />
            {reporterCount} reporter{reporterCount !== 1 ? 's' : ''}
          </span>
        </div>
        <ReportClientText reports={consolidated.reports} />

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
      data-row-key={report.id}
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
        <ReportClientText reports={[report]} />
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
  const { getDecisions, fetchReportsNeedingAttention, fetchReportsByTarget, fetchResolutionState, fetchResolutionLabelTargets } = useAdminApi();
  const { config, updateConfig } = useAppContext();
  const queryClient = useQueryClient();
  const isMobile = useIsMobile();
  const [selectedReport, setSelectedReport] = useState<NostrEvent | null>(null);
  // The report whose target the queue has called "left", held until its
  // reports are back in hand (see selectedTargetLeftList).
  const [leftListFor, setLeftListFor] = useState<string | null>(null);
  const detailBoundaryRef = useRef<ErrorBoundary | null>(null);
  const [viewMode, setViewMode] = useState<'consolidated' | 'individual'>('consolidated');
  const [hideResolved, setHideResolved] = useState(true);
  const [showPendingReview, setShowPendingReview] = useState(false);
  const [sortBy, setSortBy] = useState<SortOption>('reports');
  const [filterCategory, setFilterCategory] = useState<string | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(readFiltersOpen);
  const onFiltersOpenChange = (open: boolean) => {
    setFiltersOpen(open);
    writeFiltersOpen(open);
  };
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
  // `exact`: the read was for this very target. A ?pubkey= link whose account
  // has no profile report falls back to the reports on the account's posts, and
  // the post it opens was not itself read.
  const [targetedHistory, setTargetedHistory] =
    useState<{ relayUrl: string; target: ReportTarget; truncated: boolean; exact: boolean } | null>(null);
  const selectedTarget = selectedReport ? getReportTarget(selectedReport) : null;
  const targetedHistoryOfSelected =
    targetedHistory !== null && selectedTarget !== null
    && targetedHistory.relayUrl === relayUrl
    && targetedHistory.target.type === selectedTarget.type
    && targetedHistory.target.value === selectedTarget.value
    ? targetedHistory : null;
  const targetedHistoryTruncated = targetedHistoryOfSelected?.truncated === true;
  // Every report of the selected target was read: a targeted read of that same
  // target that did not stop early. "Every" means every report spelling the
  // target lowercase or all uppercase, the spellings the read asks for. An
  // older mixed-case report beside them is not fetched, and can't be asked for.
  const targetedReadComplete = targetedHistoryOfSelected !== null
    && targetedHistoryOfSelected.exact && !targetedHistoryOfSelected.truncated;
  const attemptedTargetRef = useRef<string | null>(null); // one targeted fetch per target
  // The relay and /reports/<id> the history view was last opened for, so it
  // opens once per id in each environment and does not reopen after the
  // moderator turns Hide resolved back on. Keyed like attemptedTargetRef.
  const urlHistoryTriedRef = useRef<string | null>(null);
  // True only while the CURRENT selection came from a deep link. A ref, not
  // state: the unhide effect reads it when it runs, and flipping it must not
  // itself cause a render.
  const deepLinkSelectedRef = useRef(false);
  // What the moderator had set before entering the pending-review view. That
  // view is its own mode and forces Hide resolved off and the category and
  // target-type filters clear, so leaving it has to hand all three back --
  // otherwise a look at the auto-hidden queue silently spends settings they chose.
  const prePendingReviewRef = useRef<{
    hideResolved: boolean;
    filterCategory: string | null;
    filterTargetType: 'all' | 'event' | 'pubkey';
  } | null>(null);
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
  //
  // None of the queue's reads carry `placeholderData: prev => prev`. After an
  // environment switch it seeded the new environment's empty query with the
  // old one's data, reported as a success, so the queue listed and filtered
  // with it until the new environment answered. A failed refresh keeps the
  // last good data without it.
  const { data: queueFeed, isLoading, error, errorUpdateCount: feedErrorUpdateCount, refetch, isFetching, dataUpdatedAt } = useQuery({
    queryKey: ['reports', relayUrl],
    queryFn: fetchReportsNeedingAttention,
    refetchInterval: QUEUE_POLL_MS,
    retry: false,
  });

  // Reports a deep link found through the targeted lookup, held beside the
  // feed rather than written into its cache. The feed carries only targets that
  // still need attention, so a deep link to a resolved target -- the usual way
  // in from a closed ticket -- would drop out of the list at the next poll
  // while its detail pane stayed open. Keyed by relay so an environment switch
  // cannot carry them across.
  const [deepLinked, setDeepLinked] = useState<{ relayUrl: string; events: NostrEvent[] } | null>(null);
  const deepLinkedReports = deepLinked?.relayUrl === relayUrl ? deepLinked.events : NO_REPORTS;
  const reports = useMemo(
    () => (queueFeed ? mergeReportFeeds(queueFeed.events, deepLinkedReports) : undefined),
    [queueFeed, deepLinkedReports],
  );

  // The reports query itself failing is the more fundamental problem: if the
  // relay read is down, resolution state is beside the point, and the
  // resolution pane's Retry can't fix it anyway. Report this first (#221) --
  // but only full-pane when there is nothing to show. When a REFRESH fails
  // (e.g. the worker 502s on a relay timeout), the last good list stays
  // rendered with a stale-data warning below, so one slow poll does not look
  // like "no reports pending".
  //
  // Latched on errorUpdateCount, as hasColdFailed is for resolution sources:
  // every re-read of a feed with no data (Try again, or the minute poll) puts
  // it back to `{error: null, status: 'pending'}`. Keyed on `error` alone,
  // each re-read looked like a first load: the cold-load skeleton took the
  // screen, unmounting a deep-linked report beside the failure and any dialog
  // open in it, and the deep-link effect set a concluded lookup back to
  // 'resolving', where it stayed. Both read this one value.
  const queueFailedCold = !reports && (!!error || feedErrorUpdateCount > 0);

  // The resolved-history view: Hide resolved off, outside the pending-review
  // view. The needs-attention feed no longer carries targets the worker
  // resolved, so this view adds them from their own paged read, fetched only
  // while the view is open.
  const historyView = !hideResolved && !showPendingReview;
  // The history view opens on Newest First, the one order a loaded page cannot
  // rearrange: an older page lands below every row already shown. The control
  // stays usable. Under any other order an older page can add rows anywhere,
  // or move a target it adds reports to, and a note under the control says the
  // sort covers only what is loaded; the scroll anchor keeps the row being read
  // in place either way. Leaving the view hands back the sort chosen before
  // entering it, whatever was picked inside. Adjusted while rendering rather
  // than in an effect, so the list never renders a frame in the old order.
  const [historySort, setHistorySort] = useState<{ inHistory: boolean; before: SortOption | null }>({
    inHistory: false,
    before: null,
  });
  if (historySort.inHistory !== historyView) {
    if (historyView) {
      setHistorySort({ inHistory: true, before: sortBy });
      setSortBy('newest');
    } else {
      setHistorySort({ inHistory: false, before: null });
      if (historySort.before !== null) setSortBy(historySort.before);
    }
  }
  const history = useResolvedHistory(relayUrl, historyView);
  const historyPages = history.data?.pages;
  // What the list is built from: the feed plus deep-linked reports, plus
  // loaded history in the history view. They can hold the same report, and
  // merging keeps one copy.
  const listReports = useMemo(() => {
    if (!reports) return undefined;
    if (!historyView || !historyPages) return reports;
    return mergeReportFeeds(reports, ...historyPages.map(page => page.events));
  }, [reports, historyView, historyPages]);

  // Load more keeps the moderator's place. An older page can land above rows
  // already on screen (ban-resolved posts from the feed sit at every depth), so
  // the row at the top of the viewport is remembered on click and put back
  // where it was once the new page has rendered. Browsers' own scroll anchoring
  // is not relied on: Safari does not do it.
  const listViewportRef = useRef<HTMLDivElement>(null);
  const loadMoreAnchorRef = useRef<ScrollAnchor | null>(null);
  const loadedHistoryPages = historyPages?.length ?? 0;
  useLayoutEffect(() => {
    const anchor = loadMoreAnchorRef.current;
    const viewport = listViewportRef.current;
    if (!anchor || !viewport) return;
    loadMoreAnchorRef.current = null;
    restoreScrollAnchor(viewport, anchor);
  }, [loadedHistoryPages]);

  // fetchNextPage settles into the query's own state (isFetchNextPageError),
  // which the footer renders, so nothing here needs its promise.
  const loadMoreHistory = () => {
    const viewport = listViewportRef.current;
    loadMoreAnchorRef.current = viewport ? captureScrollAnchor(viewport) : null;
    history.fetchNextPage();
  };

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
  const deepLinkParam = searchParams.get('event') || searchParams.get('pubkey') || '';
  const deepLinkTarget = {
    type: searchParams.get('event') ? 'event' as const : 'pubkey' as const,
    value: canonicalHex64(deepLinkParam) ?? deepLinkParam,
  };

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
    //
    // Every source is keyed as stored, though getReportTarget lowercases a
    // report's hex id (#315). Labels and decisions: the pane's history and
    // Reopen read them exactly, so one in another spelling leaves its report
    // in front of a person rather than hiding it where Reopen can't reach.
    // Ban lists are relay state: the relay matches a ban exactly, so an
    // uppercase entry never hid the real, lowercase target. Records written
    // now are lowercase: decisions are stored that way, labels name the
    // lowercase target, and the moderation actions ban through the relay-rpc
    // route or the event coordinator, which refuse any other. Age-review
    // enforcement bans a case's stored pubkey, lowercase for every case
    // opened since #313.
    if (labelTargets) {
      for (const target of labelTargets) {
        resolved.add(reportTargetKey(target));
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

    // Targets only the worker's own decisions resolved: from this read's
    // `automated` flag, and from the feed, which keeps these targets and marks
    // them so Hide resolved does not depend on this read having landed.
    const automated = new Set<string>(queueFeed?.automatedTargets);

    // Add from moderation decisions (ban_user, delete_event, etc.). The worker
    // already excluded auto-hide actions and collapsed the table to distinct
    // targets, so what arrives here is the resolved set itself rather than a
    // capped window of decision rows to filter down.
    if (resolvedDecisionTargets) {
      for (const target of resolvedDecisionTargets) {
        if (target.target_type === 'pubkey' || target.target_type === 'event') {
          const key = `${target.target_type}:${target.target_id}`;
          if (target.automated) {
            automated.add(key);
          } else {
            resolved.add(key);
            handled.add(key);
          }
        }
      }
    }

    // TODO(#332): whether Hide resolved should count a target only automation
    // resolved is open. It does today, as it always has; the switch does not.
    // Dropping this loop is the whole change if #332 decides otherwise.
    for (const key of automated) resolved.add(key);

    return { resolvedTargets: resolved, handledTargets: handled };
  }, [labelTargets, bannedPubkeys, bannedEvents, resolvedDecisionTargets, queueFeed?.automatedTargets]);

  // Set of relay-banned pubkeys, used to cross-resolve an event-scoped report
  // whose author has been banned. banpubkey purges the account's events without
  // registering each in listbannedevents, so the event's own key never lands in
  // resolvedTargets; this bridges that gap. See lib/reportResolution.
  //
  // Kept as written, while the predicate lowercases the report's side. The
  // relay does not canonicalise this list (funnelcake stores whatever
  // `banpubkey` was given) but matches it exactly, so an entry spelled in
  // uppercase (from a ban placed before #217 began refusing that spelling, or
  // from age-review enforcement on a case opened before #313) never banned the
  // lowercase account, and the reports on its posts still need a person. How
  // bans are placed now: see resolvedTargets.
  // Runtime-guarded for the same reason getReportTargetIds is: this is a relay
  // payload, and a malformed entry must not take the whole queue down.
  const bannedPubkeySet = useMemo(
    () => new Set(
      (bannedPubkeys ?? []).flatMap(entry =>
        typeof entry.pubkey === 'string' ? [entry.pubkey] : []),
    ),
    [bannedPubkeys],
  );

  // Targets auto-hidden and still waiting for a human, keyed to their latest
  // auto-hide state so a row can say when a hide needs a check
  // (auto_hide_unresolved / auto_hide_restore_failed). The same definition the
  // worker uses to keep them in the needs-attention payload, so the queue
  // splits out exactly the targets the worker kept for this view.
  const pendingReviewTargets = useMemo(
    () => pendingReviewTargetStates(autoHideStates ?? []),
    [autoHideStates],
  );

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

  // Whether the list filter (Hide resolved on, outside the pending-review
  // view) subtracts resolvedTargets. Only the label truncation bound below
  // still keys on it.
  const resolvedFilterActive = hideResolved && !showPendingReview;
  // Labels and the ban lists gate every view but pending review. The default
  // view subtracts them from the list; the history view counts resolved rows
  // with them in its footer, so a failed or unlanded read there would state a
  // count, even "No resolved reports.", with nothing to back it. The
  // pending-review view lists the switch's members: auto-hidden targets, which
  // the decisions source alone builds, and unhandled CSAM-signal targets, which
  // labels and the ban lists only subtract from. So an unlanded or failed read
  // there keeps a target behind the switch, the safe direction (#323), and does
  // not need to gate that view. Two other consumers -- the deep-link
  // auto-deselect and the deep-link resolved branch -- key on Hide resolved
  // alone, so they stay live in the pending-review view, where these three do
  // not gate. That is deliberate: both fail in the show-more direction on a
  // partially-loaded set, which is safe for a subtractive set, and self-correct
  // once the source lands.
  const gatingSources = resolutionSources.filter(s => s.gatesAlways || !showPendingReview);
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
    if (!listReports) return [];
    const categories = new Set<string>();
    for (const report of listReports) {
      categories.add(getReportCategory(report));
    }
    return Array.from(categories).sort();
  }, [listReports]);

  // The needs-attention feed plus deep-linked reports (`reports`), grouped,
  // without loaded history. The pending-review view lists from `reports`, so
  // its badge counts from here; and a listed target this does not carry came
  // from resolved history.
  const feedConsolidated = useMemo(() => (reports ? consolidateReports(reports) : []), [reports]);

  // Outside the history view the list is the feed itself (listReports is
  // `reports`), so its grouping is feedConsolidated. Group again only for the
  // feed merged with loaded history. The feed can hold tens of thousands of
  // reports, and this runs on every poll.
  const allConsolidated = useMemo(() => {
    if (!listReports) return [];
    return listReports === reports ? feedConsolidated : consolidateReports(listReports);
  }, [listReports, reports, feedConsolidated]);

  // Targets the needs-attention feed itself holds, apart from deep-linked
  // reports merged into `reports`, and whose reports the feed read in full: it
  // carries every report on them only when it did not stop early. A feed that
  // did (the red "stopped reading" banner) is missing reports older than its
  // cut-off for every target in it, so none of them counts as fully read.
  const queueFeedTargetKeys = useMemo(
    () => reportTargetKeys(queueFeed?.events ?? []),
    [queueFeed],
  );
  const needsAttentionTargetKeys = useMemo(
    () => (queueFeed?.truncated ? new Set<string>() : queueFeedTargetKeys),
    [queueFeed, queueFeedTargetKeys],
  );
  const feedTargetKeys = useMemo(
    () => new Set(feedConsolidated.map(c => reportTargetKey(c.target))),
    [feedConsolidated],
  );

  // The reports the switch classifies: the needs-attention feed plus deep-linked
  // reports (`reports`), never loaded history. A history page holds targets the
  // worker already resolved, which a person has handled by definition: one only
  // the worker's own decisions resolved stays in the feed instead. Built
  // over them, a resolved CSAM-signal target the browser cannot yet see as
  // resolved (a label read still loading or overridden) would become a member
  // and leave the list as soon as the switch opened, and the deep-link effects
  // would then open and close the switch without end. With the queue failed
  // cold there is no feed, so the deep link's own reports stand in and the pane
  // still gets its label.
  const deepLinkedConsolidated = useMemo(() => consolidateReports(deepLinkedReports), [deepLinkedReports]);
  const switchCandidates = reports ? feedConsolidated : deepLinkedConsolidated;

  // Who sits behind the Pending review switch: every auto-hidden target, plus
  // any target in the feed or the deep-linked reports with a CSAM signal that
  // no person has handled yet. Not loaded history; see switchCandidates. It
  // does not read hideResolved; see buildSwitchMembership.
  const switchMembership = useMemo(() => buildSwitchMembership({
    consolidated: switchCandidates,
    pendingReview: pendingReviewTargets,
    humanHandled: humanHandledTargets,
    handledTargets,
    bannedPubkeys: bannedPubkeySet,
  }), [switchCandidates, pendingReviewTargets, humanHandledTargets, handledTargets, bannedPubkeySet]);

  const consolidated = useMemo(() => {
    // A copy, so the in-place sort below can never reorder allConsolidated.
    // Today both view branches filter into a new array first, so this is
    // belt and braces against a later change that drops a filter.
    let items = [...allConsolidated];

    // If showing pending review, only show items behind the switch
    if (showPendingReview) {
      items = items.filter(c => switchMembership.has(reportTargetKey(c.target)));
    } else {
      // Default view: EXCLUDE items behind the switch (moderators don't see CSAM unless they opt in)
      items = items.filter(c => !switchMembership.has(reportTargetKey(c.target)));
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
    allConsolidated.map(c => [reportTargetKey(c.target), c.authorPubkey]),
  ), [allConsolidated]);

  // The reports of the open report's target. From every grouped report, not the
  // filtered list: a filter that drops the open row must not empty the pane's
  // report set. With the queue failed cold there is no list to draw the target's
  // reports from; the deep link's own lookup holds them. Searches every group,
  // so it is memoized (and sits above the early returns, as a hook must): it
  // would otherwise rescan the whole feed on every render, including the
  // freshness text's tick every few seconds.
  const selectedPaneReports = useMemo(() => {
    if (!selectedReport) return undefined;
    const paneConsolidated = listReports ? allConsolidated : deepLinkedConsolidated;
    return paneConsolidated.find(c => c.reports.some(r => r.id === selectedReport.id))?.reports;
  }, [selectedReport, listReports, allConsolidated, deepLinkedConsolidated]);

  // Filter individual reports when hideResolved is on
  const filteredReports = useMemo(() => {
    if (!listReports) return [];
    let items = [...listReports];

    // If showing pending review, only show items behind the switch
    if (showPendingReview) {
      items = items.filter(report => {
        const target = getReportTarget(report);
        if (!target) return false;
        return switchMembership.has(reportTargetKey(target));
      });
    } else {
      // Default view: EXCLUDE items behind the switch (moderators don't see CSAM unless they opt in)
      items = items.filter(report => {
        const target = getReportTarget(report);
        if (!target) return true; // Keep reports without targets
        return !switchMembership.has(reportTargetKey(target));
      });
      // Also filter resolved if toggle is on
      if (hideResolved) {
        items = items.filter(report => {
          const target = getReportTarget(report);
          if (!target) return true; // Keep reports without targets
          return !isConsolidatedReportResolved(
            { target, authorPubkey: authorByTarget.get(reportTargetKey(target)) },
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
  }, [listReports, hideResolved, showPendingReview, resolvedTargets, bannedPubkeySet, authorByTarget, switchMembership, filterCategory, filterTargetType, sortBy]);

  const uniqueTargets = consolidated.length;
  const filteredReportsCount = filteredReports.length;
  // The header counts the rows the active tab renders: targets when grouped,
  // reports in the All tab.
  const headerCount = viewMode === 'consolidated' ? uniqueTargets : filteredReportsCount;

  // The pending-review badge counts the rows that view will list on entry: the
  // grouped targets behind the switch, auto-hidden or CSAM-signal and not yet
  // handled. Not switchMembership.size -- auto-hidden members span every
  // decision on record, and a member with no report loaded here is a badge
  // with no row behind it. Counted from the feed and deep-linked reports, which
  // is what the view lists, not from loaded history. "On entry" because
  // entering clears the category and type filters; a filter chosen inside
  // the view narrows the list and its Grouped count, not this badge, which
  // keeps saying how many targets are waiting.
  const pendingReviewRows = useMemo(
    () => feedConsolidated.filter(c => switchMembership.has(reportTargetKey(c.target))),
    [feedConsolidated, switchMembership],
  );
  const pendingReviewCount = pendingReviewRows.length;

  // Whether a listed target is resolved, from both halves of the history view.
  // A target neither the feed nor a deep link carries came from resolved
  // history, which the worker resolved by a person's decision or a label. One
  // they do carry is resolved if the browser's own sources say so: a relay ban,
  // including a banned author's posts, or a decision or label (which is how a
  // deep-linked resolved target counts), or only the worker's own decisions
  // (the feed keeps those; see resolvedTargets).
  const isListedTargetResolved = useCallback(
    (target: ReportTarget, authorPubkey: string | undefined) =>
      !feedTargetKeys.has(reportTargetKey(target))
      || isConsolidatedReportResolved({ target, authorPubkey }, resolvedTargets, bannedPubkeySet),
    [feedTargetKeys, resolvedTargets, bannedPubkeySet],
  );

  // Counted from the rows on screen in the current view (spec: every count
  // beside a list comes from the rows it renders).
  const resolvedRowsShown = useMemo(() => viewMode === 'consolidated'
    ? consolidated.filter(c => isListedTargetResolved(c.target, c.authorPubkey)).length
    : filteredReports.filter(report => {
        const target = getReportTarget(report);
        return !!target && isListedTargetResolved(target, authorByTarget.get(reportTargetKey(target)));
      }).length,
  [viewMode, consolidated, filteredReports, authorByTarget, isListedTargetResolved]);

  // The failure a failed Load more left (see refreshFailed), remembered against
  // the cached query's own error: src/lib/loadMoreFailure.ts says why it is not
  // component state, and why it is the error and its timestamp together.
  // Written during render: it only records values already in the query, and
  // rendering twice records the same ones.
  if (history.isFetchNextPageError) rememberLoadMoreFailure(history.error, history.errorUpdatedAt);
  const isLoadMoreLeftover = isLoadMoreFailure(history.error, history.errorUpdatedAt);

  const lastHistoryPage = historyPages && historyPages.length > 0 ? historyPages[historyPages.length - 1] : undefined;
  const footerState = historyFooterState({
    firstPageFailed: history.isError && !history.data,
    // isRefetchError is an error with data on hand that is not a Load more
    // failure (query-core 5.75 infiniteQueryObserver). It stays true for the
    // error a failed Load more left once a later plain re-read starts, because
    // query-core keeps the error and drops the fetch direction. The re-read has
    // not failed, so that same error is not a refresh failure. A re-read that
    // fails itself is told apart by its newer errorUpdatedAt, even when the
    // error object is shared (see loadMoreFailure.ts).
    refreshFailed: history.isRefetchError && !isLoadMoreLeftover,
    lastPage: lastHistoryPage,
    loadingMore: history.isFetchingNextPage,
    busy: history.isFetching && !history.isFetchingNextPage,
    loadMoreFailed: history.isFetchNextPageError,
    resolvedRowsShown,
    // Sources in currentlyBlockedSources are on screen only once overridden;
    // stale sources are not among them and keep counting.
    incompleteSources: currentlyBlockedSources.map(s => s.label),
    filterActive: filterCategory !== null || filterTargetType !== 'all',
    skippedWithinSecond: !!historyPages?.some(page => page.skippedWithinSecond),
    resolutionTruncated: !!historyPages?.some(page => page.resolutionTruncated),
  });
  // In the history view an empty list is final only once resolved history has
  // been read to its end. While it is loading, failed, cut short or has more,
  // the footer below says so, and the list must not read as empty (#186, #221).
  const listEmptyIsFinal = !historyView || footerState.kind === 'ended';
  // The note on the sort's scope, while a sort other than Newest First
  // orders a history that has more pages to load. Shown only where the footer
  // states its count ('more'), so the note's number is the footer's: not once
  // history has ended, and not while a count is withheld for an unread source
  // or a failed re-read.
  const showSortScopeNote = historyView && sortBy !== 'newest' && footerState.kind === 'more';
  // Rendered under the sort row while Filters is open and under the Filters
  // row while it is closed (see the Collapsible below).
  const sortScopeNote = showSortScopeNote && (
    <p id="sort-scope-note" className="mt-2 text-[10px] italic leading-tight opacity-70">
      Sorted among the {resolvedRowsShown} resolved loaded so far. Load more can add rows anywhere in this order.
    </p>
  );

  // Sync selected report with URL
  useEffect(() => {
    if (selectedReportId && listReports && !selectedReport) {
      const report = listReports.find(r => r.id === selectedReportId);
      if (report) {
        // Arriving at /reports/<id> directly -- a shared link, or a reload after
        // following a Zendesk deep link -- is a deep-link selection too, and
        // needs the same unhide. Safe against the bug this scoping fixes:
        // handleSelectReport(null) navigates to /reports, so the id is gone and
        // this cannot re-select behind a dismissal.
        deepLinkSelectedRef.current = true;
        setSelectedReport(report);
      } else if (hideResolved && !showPendingReview && !isFetching && urlHistoryTriedRef.current !== `${relayUrl}|${selectedReportId}`) {
        // The feed has answered and does not hold it: most likely resolved.
        // Not while it is re-reading: a cached feed from before the report was
        // filed lacks it, and the re-read may bring it. A visit re-reads a
        // cache older than the app's one-minute staleTime; a fresher cache is
        // not re-read, so a report filed within that minute still looks here.
        // Look in resolved history, as the old single read did for its newest
        // 200; this branch selects it once page 1 lands. An id older than
        // page 1 stays unselected, as it did then. A courtesy like the deep
        // link's, so a switch the link opens later saves the setting from
        // before it.
        urlHistoryTriedRef.current = `${relayUrl}|${selectedReportId}`;
        hideResolvedBeforeCourtesyRef.current = hideResolved;
        setHideResolved(false);
      }
    }
  }, [selectedReportId, listReports, selectedReport, hideResolved, showPendingReview, isFetching, relayUrl]);

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
      { target, authorPubkey: authorByTarget.get(reportTargetKey(target)) },
      resolvedTargets,
      bannedPubkeySet,
    )) {
      hideResolvedBeforeCourtesyRef.current = hideResolved;
      setHideResolved(false);
    }
  }, [hideResolved, selectedReport, resolvedTargets, bannedPubkeySet, authorByTarget, switchMembershipKnown]);

  // Memoized because the deep-link effect below depends on it; it reads
  // hideResolved, filterCategory and filterTargetType, so it changes only when
  // those do.
  const enterPendingReview = useCallback(() => {
    setShowPendingReview(true);
    // A failed or offline read counts as settled, so a link's courtesy can
    // turn Hide resolved off before a later read opens the switch. Saving that
    // "off" would hand it back when the switch closes.
    prePendingReviewRef.current = {
      hideResolved: hideResolvedBeforeCourtesyRef.current ?? hideResolved,
      filterCategory,
      filterTargetType,
    };
    setHideResolved(false);
    setFilterCategory(null);
    // The badge counts every target waiting for review, so the view opens on
    // all of them. A Users filter carried in would hide auto-hidden posts under
    // a badge that counted them.
    setFilterTargetType('all');
  }, [hideResolved, filterCategory, filterTargetType]);

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
      // Same rule for the target type.
      if (filterTargetType === 'all') {
        setFilterTargetType(previous.filterTargetType);
      }
      prePendingReviewRef.current = null;
    }
  }, [filterCategory, filterTargetType]);

  // A link that lands on a report behind the pending-review switch opens the
  // switch, or the report sits in the detail pane with no row in the list.
  // Same scoping as the resolved-unhide effect above, and for the same reason:
  // DEEP-LINK selections only. A report the moderator clicked is already in
  // the view they chose, and switchMembership is rebuilt on every poll, so an
  // unscoped effect would reopen the switch underneath them every 15s.
  useEffect(() => {
    if (showPendingReview || !selectedReport || !deepLinkSelectedRef.current) return;
    const target = getReportTarget(selectedReport);
    if (target && switchMembership.has(reportTargetKey(target))) {
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
    if (target && !switchMembership.has(reportTargetKey(target))) {
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
          // RelayManager sees the change, clears the cache and remounts this
          // screen on the new environment, keeping this link.
          updateConfig(c => ({ ...c, relayUrl: targetEnv.relayUrl, apiUrl: targetEnv.apiUrl }));
          return; // The remounted screen's effect runs with the matching environment
        }
      }
    }

    // Still loading the bulk list — resolving, don't conclude yet. We intentionally
    // do NOT gate on isFetchingBanned: ban data affects how a report is displayed,
    // not whether it exists, and gating on it flips a resolved pane back to
    // 'resolving' (and re-fires the lookup) on every background ban refetch.
    // Nor on a re-read of a feed that failed cold: the lookup already ran when
    // the feed failed, and attemptedTargetRef keeps it from running again, so
    // 'resolving' would never clear.
    if (isLoading && !queueFailedCold) {
      setDeepLinkStatus('resolving');
      return;
    }

    // A hex id is lowercased, as getReportTarget lowercases the listed rows'
    // targets, so an uppercase link opens the row its lowercase twin does.
    const target: { type: 'event' | 'pubkey'; value: string } | null = eventParam
      ? { type: 'event', value: canonicalHex64(eventParam) ?? eventParam }
      : pubkeyParam
      ? { type: 'pubkey', value: canonicalHex64(pubkeyParam) ?? pubkeyParam }
      : null;
    if (!target) return;

    // In the history view, loaded history rows count as already listed: the
    // target is selected from them without the targeted lookup, so no floor mark.
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
        && !switchMembership.has(reportTargetKey(inBulk.target))
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

    // The target isn't in what is listed: not in the needs-attention feed (so
    // most likely resolved or gone, unless that read failed or stopped early),
    // nor, in the history view, in any history page loaded so far (outside it
    // the list is the feed plus deep-linked reports). Do one targeted relay
    // fetch per target to tell those apart from "still loading". Key the
    // attempt on the full target identity (relay + type + value) so a
    // same-value target across type, or a relay/environment switch,
    // re-resolves instead of reusing the prior attempt or its stale result.
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
        // The target is canonical where it is built (a hex id lowercased, any
        // other value as written), as getReportTarget keys a report, so an
        // uppercase link opens the same report its lowercase twin does.
        const matching = reportsMatchingTarget(
          events,
          target,
          (e: NostrEvent) => getReportTarget(e),
        );
        if (truncated && events.length === 0) {
          setDeepLinkStatus('unavailable');
          return;
        }
        const verdict = classifyTargetedFetch(events);
        if (verdict === 'found') {
          // Prefer a report whose resolved target IS the deep-link target for display;
          // fall back to any returned report (all of them tag the target).
          const pool = matching.length > 0 ? matching : events;
          // Held beside the feed so the detail pane has full context and the
          // row survives polls (see deepLinked above),
          setDeepLinked({ relayUrl, events: pool });
          // and select the newest report directly — not via a re-run, so a
          // consolidation mismatch can neither loop nor hang the pane on 'resolving'.
          const latest = pool.reduce((a, b) => (b.created_at > a.created_at ? b : a));
          deepLinkSelectedRef.current = true;
          setSelectedReport(latest);
          // Keyed by the selected report's own target, which is the list the
          // pane counts; it can differ from the deep-link target when no
          // returned report resolves to it (the fallback pool above).
          const latestTarget = getReportTarget(latest);
          const latestWritten = getWrittenReportTarget(latest);
          setTargetedHistory(latestTarget && latestWritten
            ? {
                relayUrl,
                target: latestTarget,
                truncated,
                // Only a report whose own tag spells the target one of the ways
                // the worker's filter asked for (lowercase or all uppercase) was
                // read for this target. getReportTarget lowercases the row's
                // target, so the tag as written is compared: a mixed-case tag was
                // never fetched. A malformed report's tag can have no value, and
                // an absent value is never one of those strings.
                exact: latestWritten.type === target.type
                  && hexTagFilterValues(target.value).includes(latestWritten.value),
              }
            : null);
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
  }, [allConsolidated, searchParams, hideResolved, resolvedTargets, bannedPubkeySet, switchMembership, switchMembershipKnown, navigate, isLoading, queueFailedCold, config.relayUrl, config.apiUrl, updateConfig, fetchReportsByTarget, relayUrl, retryNonce]);

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
  if ((isLoading && !queueFailedCold) || blockingLoadStillBlocking.length > 0) {
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

  const showDeepLinkFallback =
    !selectedReport && hasDeepLinkParams && (deepLinkStatus === 'gone' || deepLinkStatus === 'unavailable');
  const showDeepLinkResolving =
    !selectedReport && deepLinkStatus === 'resolving' && hasDeepLinkParams;
  // Whether the detail side has anything to show. Opens the mobile sheet, and
  // keeps a cold queue failure from replacing the screen below.
  const detailPaneOpen = !!selectedReport || showDeepLinkResolving || showDeepLinkFallback;

  // Try again is the only way back short of the next 60s poll: the header's
  // Refresh is not rendered in either layout. During a re-read the query holds
  // no error, so the notice says it is trying again instead of repeating the
  // last reason, and the button waits.
  const queueLoadFailure = (
    <Alert variant="destructive">
      <AlertDescription className="space-y-2">
        <p>
          {error
            ? `Failed to load reports: ${error instanceof Error ? error.message : "Unknown error"}`
            : "Failed to load reports. Trying again…"}
        </p>
        <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCw className={`mr-1 h-3 w-3 ${isFetching ? 'animate-spin' : ''}`} />
          Try again
        </Button>
      </AlertDescription>
    </Alert>
  );
  // A deep link's own lookup does not depend on the queue, so the report it
  // found (or its gone/unavailable pane) still opens, with this failure in
  // place of the list rather than replacing the screen.
  if (queueFailedCold && !detailPaneOpen) {
    return queueLoadFailure;
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

  // Whether the open report's target has left the list: none of its reports is
  // in hand, and no read in flight could bring it back. The feed and resolved
  // history re-read together after a resolve or Refresh, and in the history
  // view the target moves from one to the other (or back, on a reopen); while
  // either is still reading, a target missing from both is only between them.
  // A report with a target is only ever selected from reports in hand, so one
  // missing from them with nothing in flight had them and lost them. (A report
  // with no target is never grouped with a target's reports, so it reads as
  // left as well; with no target, the pane has no target media to hide.)
  //
  // Once called, the call holds until the report's reports are back in hand. A
  // read in flight only stops a target being called "left"; it does not undo
  // the call. Otherwise every later poll, Refresh or Load more would send the
  // pane's default back to "not known" and then to hidden again, which drops a
  // moderator's Show each time. A target that is only between two reads is
  // never called, so it is never held.
  const leftNow = !!selectedReport
    && !selectedPaneReports
    && !isFetching
    && !(historyView && history.isFetching);
  if (leftNow && leftListFor !== selectedReport.id) setLeftListFor(selectedReport.id);
  if (selectedPaneReports && leftListFor !== null) setLeftListFor(null);
  const selectedTargetLeftList = leftNow
    || (!!selectedReport && !selectedPaneReports && leftListFor === selectedReport.id);

  // The open report's side of the switch, so the pane carries the row's label.
  const selectedSwitchKey = selectedTarget ? reportTargetKey(selectedTarget) : undefined;

  // The pane may start a target's media visible only when the reports in hand
  // are all of that target's: the target is in the needs-attention feed itself
  // (not merely in the merged list, which also holds deep-linked reports and,
  // in the history view, pages), or a targeted read of that same target did not
  // stop early. Anything else may be missing a CSAM-signal report: a target
  // opened from history pages not yet loaded, a read cut short by the worker's
  // page bound, a feed that itself stopped early (it gives no credit to any
  // target in it), or a post opened by a ?pubkey= link, whose read was the
  // account's and misses a report that lacks the author's p tag. Those start
  // hidden until clicked.
  const selectedTargetReportsPartial = !!selectedTarget
    && !needsAttentionTargetKeys.has(reportTargetKey(selectedTarget))
    && !targetedReadComplete;
  // Older history pages can contain more reports on an already listed target.
  // Its count is a floor until the walk ends without gaps, unless the feed or
  // an exact targeted read already read that target in full. Use the same rule
  // for the row and pane; the footer counts loaded rows, not reports per target.
  const historyReadComplete = footerState.kind === 'ended'
    && !footerState.notes.length;
  const targetCountTruncated = (key: string) => {
    if (needsAttentionTargetKeys.has(key)) return false;
    if (key === selectedSwitchKey && targetedReadComplete) return false;
    return !(historyReadComplete && !feedTargetKeys.has(key));
  };
  const selectedTargetCountTruncated = !!selectedSwitchKey
    && (targetedHistoryTruncated || (!!selectedPaneReports && targetCountTruncated(selectedSwitchKey)));

  // Built once and rendered in both the desktop pane and the mobile sheet so
  // the two views cannot drift. Reports render attacker-authored event data:
  // a crashing report degrades to the inline fallback (with the target's
  // identifiers and retry/dismiss) while the reports list stays usable (#158).
  // deepLinkTarget is canonical where it is built (a hex id lowercased, any
  // other value as written), the form the worker now stores decisions in, so
  // an uppercase-hex deep link reads the same history, under the same cache
  // key, as its lowercase twin.
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
        allReportsForTarget={selectedPaneReports}
        allReportsForTargetTruncated={selectedTargetCountTruncated}
        targetReportsMayBePartial={selectedTargetReportsPartial}
        targetLeftList={selectedTargetLeftList}
        onDismiss={dismissDetail}
        switchState={selectedSwitchKey ? switchMembership.get(selectedSwitchKey) : undefined}
      />
    </ErrorBoundary>
  );

  return (
    <>
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4 h-full">
        {/* Left Pane - Report List */}
        {queueFailedCold ? (
          <div className="lg:col-span-2">{queueLoadFailure}</div>
        ) : (
        <ErrorBoundary fallback={reset => <ReportsListErrorFallback onRetry={reset} />}>
        {/* The card scrolls when the filter header plus the list's minimum
            height don't fit. The header is ~330 px and grows with categories;
            the list used to take only what was left, so on a short window it
            shrank to nothing with no way to reach it. */}
        <Card className="lg:col-span-2 h-full overflow-y-auto flex flex-col">
        <CardHeader className="pb-3 shrink-0">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2 text-lg">
                <Flag className="h-5 w-5" />
                Reports
              </CardTitle>
              <CardDescription>
                {showPendingReview
                  ? `${headerCount} pending review`
                  : hideResolved
                    ? `${headerCount} pending`
                    : `${headerCount} shown`}
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
                onClick={() => {
                  refetch();
                  // Another moderator's resolutions reach loaded history only
                  // when it is re-read; this re-reads every loaded page.
                  if (historyView) history.refetch();
                }}
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

          {queueFeed?.truncated && (
            <QueueTruncatedBanner oldestCovered={queueFeed.oldestCovered} />
          )}

          {/* Refresh failed but we still hold a previous list: warn instead of
              blanking the queue. The poll retries every minute. */}
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
                All ({filteredReportsCount})
              </TabsTrigger>
            </TabsList>
          </Tabs>

          {/* Sort, type and category fold behind Filters, open by default and
              remembered per browser. Closed, the summary still names the sort
              and every active filter, so a narrowed list is never unexplained.
              The two queue switches below never fold: they change which queue
              is on screen, and hiding that state is how "the toggles don't
              work" reports started. */}
          <Collapsible open={filtersOpen} onOpenChange={onFiltersOpenChange} className="mt-3 pt-3 border-t">
            <div className="flex items-center gap-2 min-w-0">
              <CollapsibleTrigger asChild>
                <Button variant="ghost" size="sm" className="h-7 px-1 -ml-1 text-xs font-medium shrink-0">
                  <ChevronDown className={`h-3 w-3 mr-1 transition-transform motion-reduce:transition-none ${filtersOpen ? '' : '-rotate-90'}`} />
                  Filters
                </Button>
              </CollapsibleTrigger>
              {!filtersOpen && (
                <div data-testid="filters-summary" className="flex items-center gap-1 flex-wrap min-w-0 text-xs text-muted-foreground">
                  <span>
                    {SORT_OPTIONS.find(o => o.value === sortBy)?.label}
                    {filterTargetType !== 'all' && `, ${filterTargetType === 'pubkey' ? 'Users' : 'Events'}`}
                  </span>
                  {filterCategory && (
                    <Badge variant="default" className="text-xs pr-1">
                      {getCategoryLabel(filterCategory)}
                      <button
                        type="button"
                        aria-label="Clear category filter"
                        className="ml-1 rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        onClick={() => setFilterCategory(null)}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </Badge>
                  )}
                </div>
              )}
            </div>
            {/* Closed, the note moves out of the fold: closing Filters hides
                the sort control, not this caveat on the order of the list
                below. Open, it sits under the sort row as before. The closed
                content unmounts, so only one copy (and one id) is ever on
                the page. */}
            {!filtersOpen && sortScopeNote}
            <CollapsibleContent className="space-y-3 mt-2">
              {/* Sort and type share a row, wrapping to two on narrow screens. */}
              <div className="flex flex-wrap items-center gap-2">
                {/* Sort dropdown */}
                <div className="flex items-center gap-2 flex-1 min-w-[10rem]">
                  <ArrowUpDown className="h-3 w-3 text-muted-foreground shrink-0" />
                  <Select
                    value={sortBy}
                    onValueChange={(v) => setSortBy(v as SortOption)}
                  >
                    <SelectTrigger
                      className="h-8 text-xs flex-1"
                      aria-describedby={showSortScopeNote ? 'sort-scope-note' : undefined}
                    >
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
                <div className="flex items-center gap-2 flex-1 min-w-[13rem]">
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

              </div>
              {/* Sorted history covers only the pages loaded so far. */}
              {sortScopeNote}

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
            </CollapsibleContent>
          </Collapsible>

          {/* Queue switches share one row and wrap on narrow screens. */}
          <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 mt-3 pt-3 border-t">
            {/* Pending review filter */}
            {/* Stays rendered while on, even at zero: finishing the last item
                would otherwise remove the only way back, since Hide resolved
                is disabled while this is on. */}
            {(pendingReviewCount > 0 || showPendingReview) && (
              <div className="flex items-center gap-2">
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
            <div className="flex items-center gap-2">
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
        {/* Never below ~2 rows. The list stays the scroller (Load more's
            scroll anchoring reads listViewportRef), so the card only scrolls
            far enough to reveal this minimum. */}
        <CardContent className="p-0 flex-1 min-h-[16rem]">
          {/* Radix wraps the viewport's content in a display:table div, which is
              never narrower than its widest row (a nowrap 63-character ID).
              Block it, or below about 1280 px the list's footer sentences are
              cut off at the card edge. */}
          <ScrollArea className="h-full [&>[data-radix-scroll-area-viewport]>div]:!block" viewportRef={listViewportRef}>
            <div className="space-y-2 p-4 pt-0">
              {viewMode === 'consolidated' ? (
                !consolidated || consolidated.length === 0 ? (
                  listEmptyIsFinal ? (
                    <div className="text-center py-8 text-muted-foreground">
                      <Flag className="h-8 w-8 mx-auto mb-2 opacity-50" />
                      <p className="text-sm">No reports found</p>
                    </div>
                  ) : null
                ) : (
                  consolidated.map((item) => {
                    const key = reportTargetKey(item.target);
                    return (
                      <ConsolidatedReportItem
                        key={key}
                        consolidated={item}
                        isSelected={selectedReport?.id === item.latestReport.id}
                        onClick={() => handleSelectReport(item.latestReport)}
                        switchState={switchMembership.get(key)}
                        countTruncated={key === selectedSwitchKey
                          ? selectedTargetCountTruncated
                          : targetCountTruncated(key)}
                      />
                    );
                  })
                )
              ) : (
                filteredReports.length === 0 ? (
                  listEmptyIsFinal ? (
                    <div className="text-center py-8 text-muted-foreground">
                      <Flag className="h-8 w-8 mx-auto mb-2 opacity-50" />
                      <p className="text-sm">No reports found</p>
                    </div>
                  ) : null
                ) : (
                  filteredReports.map((report) => {
                    const target = getReportTarget(report);
                    const key = target ? reportTargetKey(target) : undefined;
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
              {historyView && (
                <ResolvedHistoryFooter
                  state={footerState}
                  errorMessage={history.error instanceof Error ? history.error.message : undefined}
                  retrying={history.isFetching && !history.isFetchingNextPage}
                  onLoadMore={loadMoreHistory}
                  onRetry={() => history.refetch()}
                />
              )}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>
        </ErrorBoundary>
        )}

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
          open={detailPaneOpen}
          onOpenChange={(open) => !open && handleSelectReport(null)}
        >
          <SheetContent side="right" className="!w-full !max-w-[100vw] pt-10 px-0 pb-0 overflow-y-auto">
            {/* The sheet covers the list column where the failure is drawn, so
                say it here too: the moderator can act on this report but must
                know the queue is not loaded. */}
            {queueFailedCold && <div className="px-4 pb-3">{queueLoadFailure}</div>}
            {reportDetailPane}
          </SheetContent>
        </Sheet>
      )}
    </>
  );
}
