// ABOUTME: Full detail view for a selected report in the split-pane layout
// ABOUTME: Combines thread context, user profile, AI summary, and action buttons

import { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useToast } from "@/hooks/useToast";
import { ToastAction } from "@/components/ui/toast";
import { useReportContext } from "@/hooks/useReportContext";
import { useBannedEvent } from "@/hooks/useBannedEvent";
import { useUserSummary } from "@/hooks/useUserSummary";
import { useModerationStatus } from "@/hooks/useModerationStatus";
import { ThreadContext } from "@/components/ThreadContext";
import { UserProfileCard } from "@/components/UserProfileCard";
import { UserIdentifier } from "@/components/UserIdentifier";
import { ReporterInline } from "@/components/ReporterCard";
import { AISummary } from "@/components/AISummary";

import { ThreadModal } from "@/components/ThreadModal";
import { useAdminApi } from "@/hooks/useAdminApi";
import { useAppContext } from "@/hooks/useAppContext";
import { extractMediaHashes, type ResolutionStatus } from "@/lib/adminApi";
import { useMediaStatus } from "@/hooks/useMediaStatus";
import { useDecisionLog } from "@/hooks/useDecisionLog";
import { HiveAIReport } from "@/components/HiveAIReport";
import { AIDetectionReport } from "@/components/AIDetectionReport";
import { MediaPreview } from "@/components/MediaPreview";
import { BulkDeleteByKind } from "@/components/BulkDeleteByKind";
import { EventActions } from "@/components/EventActions";
import { UserActions } from "@/components/UserActions";
import { CATEGORY_LABELS, HIGH_PRIORITY_CATEGORIES, getReportCategory } from "@/lib/constants";
import { KIND_NAMES } from "@/lib/kindNames";
import { Flag, CheckCircle, History, Ban, ShieldX, Link2, User, FileText, Repeat2, FileCode, RefreshCw, EyeOff, Eye } from "lucide-react";
import { CopyableId, CopyableTags } from "@/components/CopyableId";
import type { NostrEvent } from "@nostrify/nostrify";

function getKindLabel(kind: number): string {
  const entry = KIND_NAMES[kind];
  if (!entry) return `Event (kind ${kind})`;
  // Use short, moderator-friendly names
  if ([34235, 34236].includes(kind)) return 'Video';
  if (kind === 1111) return 'Comment';
  if (kind === 1) return 'Note';
  if (kind === 6 || kind === 16) return 'Repost';
  if (kind === 0) return 'Profile';
  return entry.name;
}

interface ReportDetailProps {
  report: NostrEvent | null;
  allReportsForTarget?: NostrEvent[];
  allReports?: NostrEvent[];
  onDismiss?: () => void;
}

// Helper to extract report target
function getReportTarget(event: NostrEvent): { type: 'event' | 'pubkey'; value: string } | null {
  const eTag = event.tags.find(t => t[0] === 'e');
  if (eTag) return { type: 'event', value: eTag[1] };
  const pTag = event.tags.find(t => t[0] === 'p');
  if (pTag) return { type: 'pubkey', value: pTag[1] };
  return null;
}


export function ReportDetail({ report, allReportsForTarget, allReports = [], onDismiss }: ReportDetailProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const {
    deleteEvent, markAsReviewed, logDecision, deleteDecisions, callRelayRpc,
  } = useAdminApi();
  const { config } = useAppContext();
  const navigate = useNavigate();
  const [showThreadModal, setShowThreadModal] = useState(false);

  const [confirmDismiss, setConfirmDismiss] = useState(false);
  const [dismissReason, setDismissReason] = useState("");

  const context = useReportContext(report);

  // Banned event fallback: if thread found no event and target is an event ID, try management API
  const targetEventId = context.target?.type === 'event' ? context.target.value : undefined;
  const shouldCheckBanned = !context.threadLoading && !context.thread?.event && !!targetEventId;
  const { data: bannedEvent, isLoading: bannedEventQueryLoading } = useBannedEvent(
    targetEventId,
    shouldCheckBanned,
  );

  // Use banned event as fallback for display
  const displayEvent = context.thread?.event || bannedEvent;
  const isDisplayedEventBanned = !context.thread?.event && !!bannedEvent;
  // True from the moment thread finishes with no event, until banned check completes.
  const isBannedEventLoading = shouldCheckBanned && (bannedEventQueryLoading || bannedEvent === undefined);

  const summary = useUserSummary(
    context.reportedUser.pubkey || undefined,
    context.userStats?.recentPosts,
    context.userStats?.existingLabels,
    context.userStats?.previousReports
  );

  // Unified moderation status: ban lists + WebSocket verification.
  // Auto-runs WebSocket check when event is not found via normal queries or banned event lookup.
  const eventNotFound = !context.threadLoading && !isBannedEventLoading && !displayEvent && !!targetEventId;
  const moderationStatus = useModerationStatus(
    context.reportedUser.pubkey,
    context.target?.type === 'event' ? context.target.value : null,
    eventNotFound,
  );

  // Get decision history for this target
  const decisionLog = useDecisionLog(context.target?.value);

  // Also check decision log for the pubkey specifically (in case target is an event)
  const pubkeyDecisionLog = useDecisionLog(
    context.target?.type === 'event' ? context.reportedUser.pubkey : null
  );

  // Relay is source of truth for current ban/delete status
  // D1 decisions are audit log only, not status indicators
  const isUserBanned = moderationStatus.isUserBanned;
  const isEventDeleted = moderationStatus.isEventGone;
  const isResolved = decisionLog.hasDecisions || pubkeyDecisionLog.hasDecisions || isUserBanned || isEventDeleted;

  // Auto-hide specific status
  const isPendingReview = decisionLog.isPendingReview;

  // Find related reports: reports on this user AND reports on their events
  const relatedReports = useMemo(() => {
    if (!context.reportedUser.pubkey || !allReports.length) return { userReports: [], eventReports: [] };

    const userPubkey = context.reportedUser.pubkey;
    const currentTargetKey = context.target ? `${context.target.type}:${context.target.value}` : '';

    // Reports directly on this user
    const userReports = allReports.filter(r => {
      const target = getReportTarget(r);
      if (!target) return false;
      // Don't include current report's target
      if (`${target.type}:${target.value}` === currentTargetKey) return false;
      return target.type === 'pubkey' && target.value === userPubkey;
    });

    // Reports on events by this user (we need to check if event author matches)
    // For now, we use any 'e' reports where the report references this user via 'p' tag
    // OR we check if the thread/event was authored by this user
    const eventReports = allReports.filter(r => {
      const target = getReportTarget(r);
      if (!target || target.type !== 'event') return false;
      // Don't include current report's target
      if (`${target.type}:${target.value}` === currentTargetKey) return false;
      // Check if report has a 'p' tag referencing this user
      const pTag = r.tags.find(t => t[0] === 'p' && t[1] === userPubkey);
      return !!pTag;
    });

    return { userReports, eventReports };
  }, [allReports, context.reportedUser.pubkey, context.target]);

  const reviewMutation = useMutation({
    mutationFn: async ({ status, comment }: { status: ResolutionStatus; comment?: string }) => {
      if (!context.target) throw new Error('No target');
      await markAsReviewed(context.target.type, context.target.value, status, comment);
      // Log the decision
      await logDecision({
        targetType: context.target.type,
        targetId: context.target.value,
        action: status,
        reason: comment,
        reportId: report?.id,
      });
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['reports'] });
      queryClient.invalidateQueries({ queryKey: ['labels'] });
      queryClient.invalidateQueries({ queryKey: ['resolution-labels'] });
      queryClient.invalidateQueries({ queryKey: ['decisions'] });
      decisionLog.refetch();
      toast({
        title: variables.status === 'reviewed' ? "Marked as reviewed" : "Marked as false positive",
        description: "A resolution label has been created",
      });
      onDismiss?.();
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to mark as reviewed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const reopenMutation = useMutation({
    mutationFn: async () => {
      if (!context.target) throw new Error('No target');
      // Delete all decisions for this target
      await deleteDecisions(context.target.value);
      // Also delete decisions for the pubkey if this is an event report
      if (context.target.type === 'event' && context.reportedUser.pubkey) {
        await deleteDecisions(context.reportedUser.pubkey);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['decisions'] });
      decisionLog.refetch();
      pubkeyDecisionLog.refetch();
      toast({
        title: "Report reopened",
        description: "This report is now back in the pending queue",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to reopen",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  // Extract media hashes from the reported event AND reposted event if it's a repost
  const mediaHashes = useMemo(() => {
    const hashes = new Set<string>();

    // From the reported event itself (or banned event fallback)
    if (displayEvent) {
      const eventHashes = extractMediaHashes(displayEvent.content, displayEvent.tags);
      eventHashes.forEach(h => hashes.add(h));
    }

    // From the reposted original event
    if (context.thread?.repostedEvent) {
      const repostHashes = extractMediaHashes(context.thread.repostedEvent.content, context.thread.repostedEvent.tags);
      repostHashes.forEach(h => hashes.add(h));
    }

    return Array.from(hashes);
  }, [displayEvent, context.thread?.repostedEvent]);

  // Check media status from moderation service
  const mediaStatus = useMediaStatus(mediaHashes);

  // undefined while loading, then true/false once reports are available
  const hasHighPriorityReports = useMemo(() => {
    if (!allReportsForTarget) return undefined;
    return allReportsForTarget.some(r => {
      const cat = getReportCategory(r);
      return HIGH_PRIORITY_CATEGORIES.includes(cat);
    });
  }, [allReportsForTarget]);

  // Confirm auto-hidden content (approve the auto-hide decision)
  const confirmAutoHideMutation = useMutation({
    mutationFn: async ({ targetId, targetType }: { targetId: string; targetType: 'event' | 'pubkey' }) => {
      await logDecision({
        targetType,
        targetId,
        action: 'auto_hide_confirmed',
        reason: 'Auto-hide confirmed by moderator',
        reportId: report?.id,
      });
      return targetId;
    },
    onSuccess: async () => {
      queryClient.invalidateQueries({ queryKey: ['decisions'] });

      decisionLog.refetch();
      toast({ title: "Auto-hide confirmed", description: "Content will remain hidden" });
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to confirm auto-hide",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  // Restore auto-hidden content (reverse the auto-hide)
  const restoreAutoHideMutation = useMutation({
    mutationFn: async ({ eventId }: { eventId: string }) => {
      await callRelayRpc('allowevent', [eventId]);
      await logDecision({
        targetType: 'event',
        targetId: eventId,
        action: 'auto_hide_restored',
        reason: 'Auto-hide reversed by moderator',
        reportId: report?.id,
      });
      return eventId;
    },
    onSuccess: async () => {
      queryClient.invalidateQueries({ queryKey: ['reports'] });
      queryClient.invalidateQueries({ queryKey: ['banned-events'] });
      queryClient.invalidateQueries({ queryKey: ['decisions'] });

      moderationStatus.recheck();
      decisionLog.refetch();
      toast({ title: "Content restored", description: "Auto-hide has been reversed" });
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to restore content",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const handleActionComplete = () => {
    queryClient.invalidateQueries({ queryKey: ['reports'] });
    queryClient.invalidateQueries({ queryKey: ['banned-events'] });
    queryClient.invalidateQueries({ queryKey: ['banned-users'] });
    queryClient.invalidateQueries({ queryKey: ['banned-pubkeys'] });
    queryClient.invalidateQueries({ queryKey: ['suspended-pubkeys'] });
    queryClient.invalidateQueries({ queryKey: ['decisions'] });
    queryClient.invalidateQueries({ queryKey: ['media-status'] });
    queryClient.invalidateQueries({ queryKey: ['user-stats', context.reportedUser.pubkey] });
    moderationStatus.recheck();
    decisionLog.refetch();
  };

  if (!report) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground">
        <div className="text-center">
          <Flag className="h-12 w-12 mx-auto mb-4 opacity-50" />
          <p>Select a report to view details</p>
        </div>
      </div>
    );
  }

  const category = getReportCategory(report);
  const categoryLabel = CATEGORY_LABELS[category] || category;
  const isHighPriorityCategory = HIGH_PRIORITY_CATEGORIES.includes(category);

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Dialogs - rendered as portals, don't affect flex layout */}
      {/* Ban Confirmation Dialog */}
      {/* Dismiss Report Dialog */}
      <AlertDialog open={confirmDismiss} onOpenChange={(open) => { setConfirmDismiss(open); if (!open) setDismissReason(''); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Dismiss Report</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                <p>No action will be taken. Content stays up, user is not banned.</p>
                <div>
                  <Label htmlFor="dismiss-reason" className="text-sm">Reason (optional)</Label>
                  <Input
                    id="dismiss-reason"
                    placeholder="e.g. Not a violation, duplicate report, context misunderstood..."
                    value={dismissReason}
                    onChange={(e) => setDismissReason(e.target.value)}
                    className="mt-1"
                  />
                </div>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={reviewMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                reviewMutation.mutate({
                  status: 'dismissed' as ResolutionStatus,
                  comment: dismissReason.trim() || 'Dismissed - no action needed',
                });
                setConfirmDismiss(false);
                setDismissReason('');
              }}
              disabled={reviewMutation.isPending}
              className="bg-green-600 text-white hover:bg-green-700"
            >
              {reviewMutation.isPending ? 'Dismissing...' : 'Dismiss Report'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Thread Modal */}
      {context.target?.type === 'event' && (
        <ThreadModal
          eventId={context.target.value}
          open={showThreadModal}
          onOpenChange={setShowThreadModal}
        />
      )}

      {/* Scrollable content area */}
      <ScrollArea className="flex-1 min-h-0 [&>div>div]:!block">
        <div className="p-4 space-y-4 overflow-x-hidden max-w-full">
          {/* Pending Review Banner - for auto-hidden items awaiting human review */}
          {isPendingReview && (
            <div className="bg-orange-100 dark:bg-orange-950/50 border border-orange-300 dark:border-orange-800 rounded-lg p-3">
              <div className="flex items-center gap-3 mb-3">
                <EyeOff className="h-6 w-6 text-orange-600" />
                <div className="flex-1">
                  <p className="font-medium text-orange-800 dark:text-orange-300">
                    Auto-Hidden — Pending Review
                  </p>
                  <p className="text-sm text-orange-600 dark:text-orange-400">
                    This content was automatically hidden based on a report. Please review and confirm or restore.
                  </p>
                </div>
              </div>
              <div className="flex gap-2">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="default"
                      className="bg-green-600 hover:bg-green-700"
                      onClick={() => {
                        if (context.target) {
                          confirmAutoHideMutation.mutate({
                            targetId: context.target.value,
                            targetType: context.target.type,
                          });
                        }
                      }}
                      disabled={confirmAutoHideMutation.isPending}
                    >
                      <CheckCircle className="h-4 w-4 mr-1" />
                      {confirmAutoHideMutation.isPending ? 'Confirming...' : 'Confirm Hide'}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="max-w-xs">
                    <p>Confirm this auto-hide decision. The content will remain hidden.</p>
                  </TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="outline"
                      onClick={() => {
                        if (context.target?.type === 'event' && context.target.value) {
                          restoreAutoHideMutation.mutate({ eventId: context.target.value });
                        }
                      }}
                      disabled={restoreAutoHideMutation.isPending || context.target?.type !== 'event'}
                    >
                      <Eye className="h-4 w-4 mr-1" />
                      {restoreAutoHideMutation.isPending ? 'Restoring...' : 'Restore Content'}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="max-w-xs">
                    <p>Reverse the auto-hide. The content will be visible again.</p>
                  </TooltipContent>
                </Tooltip>
              </div>
            </div>
          )}

          {/* Decision log banner - show when there's a recorded moderation action (but not pending review) */}
          {isResolved && !isPendingReview && (decisionLog.latestDecision || pubkeyDecisionLog.latestDecision) && (
            <div className="bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-800 rounded-lg px-3 py-2 flex items-center gap-2">
              <CheckCircle className="h-4 w-4 text-green-600 shrink-0" />
              <p className="text-sm text-green-700 dark:text-green-400">
                Last action: {(decisionLog.latestDecision || pubkeyDecisionLog.latestDecision)?.action.replace(/_/g, ' ')} on {new Date((decisionLog.latestDecision || pubkeyDecisionLog.latestDecision)?.created_at || '').toLocaleDateString()}
              </p>
            </div>
          )}

          {/* Header */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 flex-wrap">
              <Badge variant={isHighPriorityCategory ? "destructive" : "outline"}>{categoryLabel}</Badge>
              <Badge variant="secondary">
                {context.target?.type === 'event' ? 'Event' : 'User'}
              </Badge>
              {isUserBanned && (
                <Badge variant="destructive" className="flex items-center gap-1">
                  <Ban className="h-3 w-3" />
                  User Banned
                </Badge>
              )}
              {isEventDeleted && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Badge variant="destructive" className="flex items-center gap-1 cursor-help">
                      <ShieldX className="h-3 w-3" />
                      {decisionLog.isDeleted ? 'Removed by Moderation'
                        : (decisionLog.isAutoHidden && !decisionLog.isAutoHideRestored) ? 'Auto-Hidden'
                        : isUserBanned ? 'User Banned'
                        : moderationStatus.isEventBanned ? 'Event Banned'
                        : 'Not Found on Relay'}
                    </Badge>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="max-w-xs">
                    {decisionLog.isDeleted ? (
                      <p className="text-xs">
                        Deleted via relay admin
                        {decisionLog.decisions.find(d => d.action === 'delete_event' || d.action === 'delete')?.created_at &&
                          ` on ${new Date(decisionLog.decisions.find(d => d.action === 'delete_event' || d.action === 'delete')!.created_at).toLocaleDateString()}`
                        }
                      </p>
                    ) : (decisionLog.isAutoHidden && !decisionLog.isAutoHideRestored) ? (
                      <p className="text-xs">Auto-hidden by AI classification</p>
                    ) : isUserBanned ? (
                      <p className="text-xs">User is banned — event removed as part of ban</p>
                    ) : moderationStatus.isEventBanned ? (
                      <p className="text-xs">Event is in the relay ban list</p>
                    ) : (
                      <p className="text-xs">Event not found on relay. May have been self-deleted by the author or never stored here.</p>
                    )}
                  </TooltipContent>
                </Tooltip>
              )}
              {isPendingReview && (
                <Badge variant="outline" className="flex items-center gap-1 border-orange-500 text-orange-600">
                  <EyeOff className="h-3 w-3" />
                  Auto-Hidden
                </Badge>
              )}
            </div>
            <span className="text-xs text-muted-foreground">
              Reported: {new Date(report.created_at * 1000).toLocaleString(undefined, {
                year: 'numeric',
                month: 'short',
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
                timeZoneName: 'short'
              })}
            </span>
          </div>

          {/* Report Reasons - What reporters said */}
          {allReportsForTarget && allReportsForTarget.length > 0 ? (
            <Card className="border-red-200 bg-red-50/50 dark:bg-red-950/20">
              <CardHeader className="py-3">
                <CardTitle className="text-sm flex items-center gap-2 text-red-700 dark:text-red-400">
                  <Flag className="h-4 w-4" />
                  Why This Was Reported ({allReportsForTarget.length} report{allReportsForTarget.length !== 1 ? 's' : ''})
                </CardTitle>
              </CardHeader>
              <CardContent className="py-0 pb-3 space-y-3">
                {allReportsForTarget.slice(0, 5).map((r) => {
                  const cat = getReportCategory(r);
                  const catLabel = CATEGORY_LABELS[cat] || cat;
                  return (
                    <div key={r.id} className="p-3 bg-background rounded-lg border">
                      {/* Reporter info */}
                      <div className="mb-2">
                        <ReporterInline
                          pubkey={r.pubkey}
                          onViewProfile={(pubkey) => {
                            // Navigate to Events tab filtered by this user
                            navigate(`/events?pubkey=${pubkey}`);
                          }}
                        />
                      </div>
                      {/* Report details */}
                      <div className="flex items-center gap-2 mb-1">
                        <Badge variant="destructive" className="text-xs">{catLabel}</Badge>
                        <span className="text-xs text-muted-foreground">
                          {new Date(r.created_at * 1000).toLocaleDateString()}
                        </span>
                      </div>
                      {r.content ? (
                        <p className="text-sm text-muted-foreground">{r.content}</p>
                      ) : (
                        <p className="text-sm text-muted-foreground italic">No reason provided</p>
                      )}
                    </div>
                  );
                })}
                {allReportsForTarget.length > 5 && (
                  <p className="text-xs text-muted-foreground">+{allReportsForTarget.length - 5} more reports</p>
                )}
              </CardContent>
            </Card>
          ) : report.content ? (
            <Card className="border-red-200 bg-red-50/50 dark:bg-red-950/20">
              <CardHeader className="py-3">
                <CardTitle className="text-sm flex items-center gap-2 text-red-700 dark:text-red-400">
                  <Flag className="h-4 w-4" />
                  Report Reason
                </CardTitle>
              </CardHeader>
              <CardContent className="py-0 pb-3">
                {/* Single report - show reporter info */}
                <div className="mb-2">
                  <ReporterInline
                    pubkey={report.pubkey}
                    onViewProfile={(pubkey) => {
                      navigate(`/events?pubkey=${pubkey}`);
                    }}
                  />
                </div>
                <p className="text-sm">{report.content}</p>
              </CardContent>
            </Card>
          ) : null}

          {/* Decision History - show if target already has decisions */}
          {decisionLog.hasDecisions && (
            <Card className="border-green-200 bg-green-50/50 dark:bg-green-950/20">
              <CardHeader className="py-3">
                <CardTitle className="text-sm flex items-center gap-2 text-green-700 dark:text-green-400">
                  <History className="h-4 w-4" />
                  Already Handled ({decisionLog.decisions.length} action{decisionLog.decisions.length !== 1 ? 's' : ''})
                </CardTitle>
              </CardHeader>
              <CardContent className="py-0 pb-3">
                <div className="space-y-2">
                  {decisionLog.decisions.slice(0, 5).map((decision) => (
                    <div key={decision.id} className="flex items-start justify-between text-xs p-2 bg-background rounded">
                      <div>
                        <Badge variant="outline" className="text-xs mb-1">
                          {decision.action.replace(/_/g, ' ')}
                        </Badge>
                        {decision.reason && (
                          <p className="text-muted-foreground mt-1">{decision.reason}</p>
                        )}
                      </div>
                      <span className="text-muted-foreground shrink-0">
                        {new Date(decision.created_at).toLocaleDateString()}
                      </span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Section: Reported Content (event reports only; user reports skip to profile card) */}
          {context.target?.type === 'event' && (
            <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              {displayEvent ? `Reported ${getKindLabel(displayEvent.kind)}` : 'Reported Content'}
            </h4>
          )}

          {/* Thread Context - the text content being reported */}
          {context.target?.type === 'event' && (
            <>
              {isDisplayedEventBanned && (
                <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-red-50 border border-red-200 dark:bg-red-950/30 dark:border-red-800">
                  <Ban className="h-4 w-4 text-red-600" />
                  <span className="text-sm font-medium text-red-700 dark:text-red-400">Event is banned on relay</span>
                  <span className="text-xs text-red-600/70 dark:text-red-400/70">Content retrieved via admin API</span>
                </div>
              )}
              <ThreadContext
                ancestors={context.thread?.ancestors || []}
                reportedEvent={displayEvent || null}
                onViewFullThread={() => setShowThreadModal(true)}
                isLoading={context.threadLoading}
                isCheckingBanned={isBannedEventLoading || (moderationStatus.isChecking && !displayEvent)}
                apiUrl={config.apiUrl}
                fetchSource={context.thread?.fetchSource}
                triedExternalRelay={context.thread?.triedExternalRelay || context.relayHint}
                reportTags={context.reportTags}
                targetEventId={context.target?.type === 'event' ? context.target.value : undefined}
                isEventDeleted={moderationStatus.isEventGone === true}
                isUserBanned={moderationStatus.isUserBanned === true}
                checkedAt={moderationStatus.checkedAt}
                onRecheck={moderationStatus.recheck}
                isRechecking={moderationStatus.isChecking}
              />
            </>
          )}

          {/* Repost Original Content - show when the reported event is a repost */}
          {context.thread?.isRepost && (
            <Card className="border-blue-200 bg-blue-50/50 dark:bg-blue-950/20">
              <CardHeader className="py-3">
                <CardTitle className="text-sm flex items-center gap-2 text-blue-700 dark:text-blue-400">
                  <Repeat2 className="h-4 w-4" />
                  This is a Repost - Original Content Below
                </CardTitle>
              </CardHeader>
              <CardContent className="py-0 pb-3">
                {context.thread?.repostedEvent ? (
                  <div className="space-y-3">
                    {/* Original author */}
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">Original author:</span>
                      <UserIdentifier
                        pubkey={context.thread.repostedEvent.pubkey}
                        showAvatar
                        avatarSize="sm"
                        variant="inline"
                        linkToProfile
                      />
                    </div>
                    {/* Original content */}
                    <div className="bg-background p-3 rounded-lg border">
                      <p className="text-sm whitespace-pre-wrap break-words">
                        {context.thread.repostedEvent.content}
                      </p>
                      <div className="flex items-center gap-2 mt-2 text-xs text-muted-foreground">
                        <span>Kind {context.thread.repostedEvent.kind}</span>
                        <span>·</span>
                        <span>{new Date(context.thread.repostedEvent.created_at * 1000).toLocaleString()}</span>
                      </div>
                    </div>
                    {/* Media in original post */}
                    <MediaPreview
                      event={context.thread.repostedEvent}
                      showByDefault={hasHighPriorityReports === false}
                      maxItems={6}
                    />
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground italic">
                    Could not load the original event that was reposted
                  </p>
                )}
              </CardContent>
            </Card>
          )}

          {/* Media Preview - show the actual content being reported */}
          {displayEvent && (
            <MediaPreview
              event={displayEvent}
              showByDefault={hasHighPriorityReports === false}
              maxItems={6}
            />
          )}

          {/* User moderation status - for user reports where there's no ThreadContext to show it */}
          {context.target?.type === 'pubkey' && (moderationStatus.checkedAt || moderationStatus.isChecking) && (
            <div className="rounded-md border bg-muted/30 p-3 space-y-2">
              {moderationStatus.isUserBanned ? (
                <div className="flex items-center gap-2 p-2 rounded bg-green-100 dark:bg-green-950/50">
                  <Ban className="h-4 w-4 text-green-600 shrink-0" />
                  <span className="text-sm font-medium text-green-700 dark:text-green-400">
                    User is banned on the relay
                  </span>
                </div>
              ) : moderationStatus.checkedAt ? (
                <div className="flex items-center gap-2 p-2 rounded bg-yellow-100 dark:bg-yellow-950/50">
                  <User className="h-4 w-4 text-yellow-600 shrink-0" />
                  <span className="text-sm font-medium text-yellow-700 dark:text-yellow-400">
                    User is not banned
                  </span>
                </div>
              ) : null}
              <div className="flex items-center justify-between">
                {moderationStatus.checkedAt && (
                  <span className="text-xs text-muted-foreground">
                    Checked: {moderationStatus.checkedAt.toLocaleTimeString()}
                  </span>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={moderationStatus.recheck}
                  disabled={moderationStatus.isChecking}
                  className="h-6 text-xs px-2"
                >
                  <RefreshCw className={`h-3 w-3 mr-1 ${moderationStatus.isChecking ? 'animate-spin' : ''}`} />
                  {moderationStatus.isChecking ? 'Checking...' : 'Re-check'}
                </Button>
              </div>
            </div>
          )}

          {/* Reported User - who created the reported content. Don't show skeleton while still searching for event. */}
          {(context.reportedUser.pubkey || (!context.isLoading && !isBannedEventLoading)) && (
          <>
          <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Reported User</h4>
          <UserProfileCard
            profile={context.reportedUser.profile}
            pubkey={context.reportedUser.pubkey}
            stats={context.userStats}
            isLoading={false}
            isFunnelcakeUser={context.reportedUser.isFunnelcakeUser}
            onDeleteEvent={async (eventId) => {
              try {
                await deleteEvent(eventId, 'Deleted from report review');
                toast({
                  title: "Event deleted",
                  description: "The event has been removed from the relay.",
                  action: (
                    <ToastAction altText="Undo delete" onClick={async () => {
                      await callRelayRpc('allowevent', [eventId]);
                      handleActionComplete();
                      toast({ title: "Event restored" });
                    }}>
                      Undo
                    </ToastAction>
                  ),
                });
                handleActionComplete();
              } catch (error) {
                toast({ title: "Failed to delete event", description: String(error), variant: "destructive" });
              }
            }}
          />
          </>
          )}

          <Separator />

          {/* Section: Investigation Helpers */}
          <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Investigation Helpers</h4>

          {displayEvent ? (
            <>
              {/* Hive AI Content Moderation */}
              <HiveAIReport eventTags={displayEvent.tags} />

              {/* AI Detection (Reality Defender multi-provider) */}
              <AIDetectionReport
                eventTags={displayEvent.tags}
                eventId={displayEvent.id}
              />

              {/* AI Summary */}
              <AISummary
                summary={summary.data?.summary}
                riskLevel={summary.data?.riskLevel}
                isLoading={summary.isLoading}
                error={summary.error as Error | null}
              />
            </>
          ) : context.target?.type === 'pubkey' ? (
            <p className="text-sm text-muted-foreground">
              User report. AI analysis is only available for reported content events.
            </p>
          ) : context.isLoading || isBannedEventLoading ? (
            <p className="text-sm text-muted-foreground">Waiting for content to load...</p>
          ) : (
            <p className="text-sm text-muted-foreground">
              No AI analysis available.
              {context.relayHint
                ? ` The reported content could not be found on our relay or on ${context.relayHint}.`
                : ' The reported content could not be found on our relay. No external relay hint was provided in the report.'}
            </p>
          )}

          <Separator />

          {/* Related Reports - show reports on this user AND their events */}
          {(relatedReports.userReports.length > 0 || relatedReports.eventReports.length > 0) && (
            <Card className="border-orange-200 bg-orange-50/50 dark:bg-orange-950/20">
              <CardHeader className="py-3">
                <CardTitle className="text-sm flex items-center gap-2 text-orange-700 dark:text-orange-400">
                  <Link2 className="h-4 w-4" />
                  Related Reports ({relatedReports.userReports.length + relatedReports.eventReports.length} on same user)
                </CardTitle>
              </CardHeader>
              <CardContent className="py-0 pb-3">
                <div className="space-y-2">
                  {relatedReports.userReports.length > 0 && (
                    <div>
                      <p className="text-xs font-medium flex items-center gap-1 mb-1.5 text-muted-foreground">
                        <User className="h-3 w-3" />
                        Reports on this User ({relatedReports.userReports.length})
                      </p>
                      <div className="space-y-1">
                        {relatedReports.userReports.slice(0, 3).map((r) => {
                          const cat = getReportCategory(r);
                          const catLabel = CATEGORY_LABELS[cat] || cat;
                          return (
                            <div key={r.id} className="flex items-center gap-2 text-xs p-1.5 bg-background rounded">
                              <Badge variant="outline" className="text-xs">{catLabel}</Badge>
                              <span className="text-muted-foreground truncate flex-1">
                                {r.content?.slice(0, 40) || 'No description'}
                                {(r.content?.length || 0) > 40 && '...'}
                              </span>
                            </div>
                          );
                        })}
                        {relatedReports.userReports.length > 3 && (
                          <p className="text-xs text-muted-foreground pl-1">
                            +{relatedReports.userReports.length - 3} more user reports
                          </p>
                        )}
                      </div>
                    </div>
                  )}
                  {relatedReports.eventReports.length > 0 && (
                    <div>
                      <p className="text-xs font-medium flex items-center gap-1 mb-1.5 text-muted-foreground">
                        <FileText className="h-3 w-3" />
                        Reports on their Events ({relatedReports.eventReports.length})
                      </p>
                      <div className="space-y-1">
                        {relatedReports.eventReports.slice(0, 3).map((r) => {
                          const cat = getReportCategory(r);
                          const catLabel = CATEGORY_LABELS[cat] || cat;
                          const target = getReportTarget(r);
                          return (
                            <div key={r.id} className="flex items-center gap-2 text-xs p-1.5 bg-background rounded">
                              <Badge variant="outline" className="text-xs">{catLabel}</Badge>
                              {target?.value && (
                                <CopyableId
                                  value={target.value}
                                  type="note"
                                  truncateStart={10}
                                  truncateEnd={4}
                                  size="xs"
                                />
                              )}
                            </div>
                          );
                        })}
                        {relatedReports.eventReports.length > 3 && (
                          <p className="text-xs text-muted-foreground pl-1">
                            +{relatedReports.eventReports.length - 3} more event reports
                          </p>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Section: Technical Details */}
          <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Technical Details</h4>

          {/* Event Metadata - Show IDs and tags for copying */}
          <Card>
            <CardHeader className="py-3">
              <CardTitle className="text-sm flex items-center gap-2">
                <FileCode className="h-4 w-4" />
                Reported Event Details
              </CardTitle>
            </CardHeader>
            <CardContent className="py-0 pb-3 space-y-3">
              {/* Report Event ID */}
              <div className="space-y-1">
                <span className="text-xs font-medium text-muted-foreground">Report Event</span>
                <div className="flex flex-col gap-1">
                  <CopyableId value={report.id} type="note" label="ID:" size="xs" />
                  <CopyableId value={report.pubkey} type="npub" label="Reporter:" size="xs" />
                </div>
              </div>

              {/* Reported Target */}
              {context.target && (
                <div className="space-y-1">
                  <span className="text-xs font-medium text-muted-foreground">
                    Reported {context.target.type === 'event' ? 'Event' : 'User'}
                  </span>
                  <div className="flex flex-col gap-1">
                    <CopyableId
                      value={context.target.value}
                      type={context.target.type === 'event' ? 'note' : 'npub'}
                      label={context.target.type === 'event' ? 'ID:' : 'npub:'}
                      size="xs"
                    />
                    {context.reportedUser.pubkey && context.target.type === 'event' && (
                      <CopyableId value={context.reportedUser.pubkey} type="npub" label="Author:" size="xs" />
                    )}
                  </div>
                </div>
              )}

              {/* Report Tags */}
              {report.tags.length > 0 && (
                <CopyableTags tags={report.tags} maxTags={8} />
              )}

              {/* Reported Event Tags (if different from report) */}
              {displayEvent && displayEvent.tags.length > 0 && (
                <div className="pt-2 border-t">
                  <span className="text-xs font-medium text-muted-foreground block mb-1">
                    Reported Event Tags
                  </span>
                  <CopyableTags tags={displayEvent.tags} maxTags={8} />
                </div>
              )}
            </CardContent>
          </Card>

          {/*
            REMOVED: Redundant reporter section (Jan 2026)
            - Was showing ReporterList (multiple) or ReporterInfo (single) here
            - Now redundant because "Why This Was Reported" section above shows reporters
              with trust level badges via ReporterInline component
            - To restore: use <ReporterList reports={allReportsForTarget} maxVisible={5} />
              for multiple reports, or <ReporterInfo profile={context.reporter.profile}
              pubkey={context.reporter.pubkey} reportCount={context.reporter.reportCount} />
              for single reporter
          */}

          <Separator />


        </div>
      </ScrollArea>

      {/* Action Buttons - fixed at bottom */}
      <div className="border-t bg-background p-4 space-y-3 shrink-0">
            {/* Resolution actions - dismiss or reopen */}
            <div className="flex flex-wrap gap-2">
              {/* Reopen: only when there are decisions to undo */}
              {(decisionLog.hasDecisions || pubkeyDecisionLog.hasDecisions) && !isUserBanned && !isEventDeleted && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="outline"
                      className="border-orange-500 text-orange-600 hover:bg-orange-50"
                      onClick={() => reopenMutation.mutate()}
                      disabled={reopenMutation.isPending}
                    >
                      <History className="h-4 w-4 mr-1" />
                      {reopenMutation.isPending ? 'Reopening...' : 'Reopen'}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="max-w-xs">
                    <p>Reopen this report for review. Removes the dismiss decision and puts it back in the pending queue.</p>
                  </TooltipContent>
                </Tooltip>
              )}
              {/* Dismiss: always available. Logs a "reviewed" decision to resolve the report. */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    className="border-green-500 text-green-600 hover:bg-green-50"
                    onClick={() => setConfirmDismiss(true)}
                    disabled={reviewMutation.isPending}
                  >
                    <CheckCircle className="h-4 w-4 mr-1" />
                    Dismiss Report
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="max-w-xs">
                  <p>Dismiss this report. Logs a review decision so it moves out of the pending queue.</p>
                </TooltipContent>
              </Tooltip>
            </div>

            {/* Event & media actions */}
            {context.target?.type === 'event' && context.target.value && (
              <EventActions
                eventId={context.target.value}
                pubkey={context.reportedUser.pubkey || ''}
                mediaHashes={mediaHashes}
                isEventBanned={isEventDeleted ?? undefined}
                hasBlockedMedia={mediaStatus.hasBlockedMedia}
                hasRestrictedMedia={mediaStatus.hasRestrictedMedia}
                onActionComplete={handleActionComplete}
              />
            )}

            {/* User actions */}
            {context.reportedUser.pubkey && (
              <UserActions
                pubkey={context.reportedUser.pubkey}
                context="report"
                isBanned={isUserBanned ?? undefined}
                isSuspended={moderationStatus.isUserSuspended ?? undefined}
                onActionComplete={handleActionComplete}
              />
            )}

            {/* Report-specific actions */}
            <div className="flex flex-wrap gap-2">
              {context.reportedUser.pubkey && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div>
                      <BulkDeleteByKind
                        pubkey={context.reportedUser.pubkey}
                        logDecision={logDecision}
                        reportId={report?.id}
                        onComplete={handleActionComplete}
                      />
                    </div>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="max-w-xs">
                    <p>Delete all events of a specific kind (e.g., all video views) from this user without banning them entirely.</p>
                  </TooltipContent>
                </Tooltip>
              )}

            </div>
        </div>
    </div>
  );
}
