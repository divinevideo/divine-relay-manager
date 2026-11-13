// ABOUTME: Full detail view for a selected report in the split-pane layout
// ABOUTME: Combines thread context, user profile, AI summary, and action buttons

import { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
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
import { isRepostKind, looksLikeEventCopy, verifiedRepostedEvent } from "@/lib/nip18";
import { useBannedEvent } from "@/hooks/useBannedEvent";
import { useUserSummary } from "@/hooks/useUserSummary";
import { useModerationStatus } from "@/hooks/useModerationStatus";
import { ThreadContext } from "@/components/ThreadContext";
import { UserProfileCard } from "@/components/UserProfileCard";
import { SuspendedPostViewer } from "@/components/suspended/SuspendedContentPanel";
import { deriveGoneCause } from "@/lib/goneCause";
import { UserIdentifier } from "@/components/UserIdentifier";
import { ReporterInline } from "@/components/ReporterCard";
import { AccountTypeLabel } from "@/components/AccountTypeBadge";
import { refreshAccountStatusAfterMirror } from "@/lib/accountStatusCache";
import { ReportClientText } from "@/components/ReportClientText";
import { AISummary } from "@/components/AISummary";

import { ThreadModal } from "@/components/ThreadModal";
import { useAdminApi, type ModeratorApi } from "@/hooks/useAdminApi";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useAppContext } from "@/hooks/useAppContext";
import { historyCount } from "@/lib/historyCount";
import { overflowLine } from "@/lib/overflowLine";
import { invalidateResolutionState } from "@/lib/queueInvalidation";
import { extractMediaFiles, type ResolutionStatus } from "@/lib/adminApi";
import { useMediaStatus } from "@/hooks/useMediaStatus";
import { useDecisionLog } from "@/hooks/useDecisionLog";
import { HiveAIReport } from "@/components/HiveAIReport";
import { AIDetectionReport } from "@/components/AIDetectionReport";
import { MediaPreview } from "@/components/MediaPreview";
import { BulkDeleteByKind } from "@/components/BulkDeleteByKind";
import { EventActions } from "@/components/EventActions";
import { UserActions, type UserActionChange } from "@/components/UserActions";
import { LinkedTicketPanel } from "@/components/LinkedTicketPanel";
import { linkedTicketTarget } from "@/lib/linkedTicketTarget";
import { HIGH_PRIORITY_CATEGORIES, getCategoryLabel, getReportCategory, hasCsamSignal, isHex64, userStatsQueryKey } from "@/lib/constants";
import { SWITCH_STATE_LABELS, type SwitchState } from "@/lib/sensitiveSwitch";
import { ageReviewCategory, classifyReport } from "../../shared/report-classification";
import { KIND_NAMES } from "@/lib/kindNames";
import { Flag, CheckCircle, History, Ban, ShieldX, User, Repeat2, FileCode, RefreshCw, EyeOff, Eye, AlertTriangle } from "lucide-react";
import { CopyableId, CopyableTags } from "@/components/CopyableId";
import { RelatedReportsCard } from "@/components/RelatedReportsCard";
import { ReportedListCard } from "@/components/ReportedListCard";
import { LIST_KIND_LABEL, isListKind } from "../../shared/list-report";
import { handledBeforeBanText, type HandledBeforeView } from "@/lib/reportResolution";
import type { NostrEvent } from "@nostrify/nostrify";

function getKindLabel(kind: number): string {
  if (isListKind(kind)) return LIST_KIND_LABEL[kind];
  const entry = KIND_NAMES[kind];
  if (!entry) return `Event (kind ${kind})`;
  // Use short, moderator-friendly names
  if ([34235, 34236].includes(kind)) return 'Video';
  if (kind === 1111) return 'Comment';
  if (kind === 1) return 'Note';
  if (isRepostKind(kind)) return 'Repost';
  if (kind === 0) return 'Profile';
  return entry.name;
}

interface ReportDetailProps {
  report: NostrEvent | null;
  allReportsForTarget?: NostrEvent[];
  allReportsForTargetTruncated?: boolean;
  // allReportsForTarget may not be all of this target's reports, so a report on
  // it that signals CSAM may be missing. Media and avatars then start hidden
  // whatever the loaded reports say, until clicked. Not the same as
  // allReportsForTargetTruncated, which only drives the "N+" floor mark: a read
  // that stopped early is partial, but a partial set is also one that was never
  // read for this target (a history page, or a fallback pool).
  targetReportsMayBePartial?: boolean;
  // The open report's target has left the list (handled elsewhere): none of its
  // reports is in hand, and it went missing with no read in flight that could
  // have brought it back. The queue decides this, since only it knows both
  // reads; a target that is only being re-read is not one. Once true, it stays
  // true through later reads until the target's reports are back in hand.
  targetLeftList?: boolean;
  onDismiss?: () => void;
  // Which side of the queue's Pending review switch this report's target is
  // on. Undefined outside it. Only 'not-hidden' gets a badge here: the pane's
  // own auto-hide banner and badge already describe the auto-hidden states.
  switchState?: SwitchState;
  // Set only when the queue counts this report as handled before (#324): a
  // person handled its item, then this report came. The history of that
  // handling (newest first), whose it is, and a relay ban on the account or
  // the post's author, as the queue read them, so the pane and the queue row
  // cannot disagree. The Handled before card lists it.
  handledBefore?: HandledBeforeView;
  // The queue's dated rule has a person's handling on this report's own target
  // since its last reopen: a decision, or a resolution label (#324). A target
  // handled only by a label has no handling row in the decision log, yet the
  // queue counts it and a Reopen cancels it, so Reopen shows on this as well.
  queueHandled?: boolean;
}

const ACCOUNT_HANDLED_BEFORE_PROMPT =
  "This account was handled before. Does this report, with the account's current state, change the call?";

export function ReportDetail({ report, allReportsForTarget, allReportsForTargetTruncated = false, targetReportsMayBePartial = false, targetLeftList = false, onDismiss, switchState, handledBefore, queueHandled = false }: ReportDetailProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const api = useAdminApi();
  const { getModeratorToken } = useCurrentUser();

  // Audit logging is a non-critical side effect. Fire-and-forget so a failing
  // /api/decisions write can't make an action whose authoritative step already
  // SUCCEEDED (markAsReviewed label publish, restoreEvent) report failure. On a
  // successful write, re-invalidate the decision log; on failure, a non-blocking
  // toast. Mirrors UserActions.logAudit.
  // Detached audit write. `act` is the api bound to the moderator's login when
  // the action started, so a logout or switch mid-request can't retarget it.
  // Never blocks the action.
  const logAudit = (
    act: ModeratorApi,
    params: Parameters<ModeratorApi['logDecision']>[0],
  ) =>
    // Started from a resolved promise so that even a synchronous throw lands in
    // the catch below rather than failing the action.
    void Promise.resolve().then(() => act.logDecision(params))
      .then(() => {
        queryClient.invalidateQueries({ queryKey: ['decisions'] });
        // The queue reads its resolved set from the resolution-state
        // projection, not the decision log, and the worker filters both
        // report feeds by the same decisions, so all of them need refreshing
        // or the target stays listed until the next poll.
        invalidateResolutionState(queryClient);
      })
      .catch((e) => {
        console.warn('[ReportDetail] audit log failed', e);
        toast({ title: 'Action applied; audit log not recorded' });
      });

  const { config } = useAppContext();
  const navigate = useNavigate();
  const [showThreadModal, setShowThreadModal] = useState(false);

  const [confirmDismiss, setConfirmDismiss] = useState(false);
  const [dismissReason, setDismissReason] = useState("");

  const context = useReportContext(report);
  const reportedPubkey = context.reportedUser.pubkey;
  // Linked-ticket panel inputs, scoped to the report's own target (see
  // linkedTicketTarget): an event-scoped report looks up only its event, a
  // pubkey-scoped report looks up the author.
  const { eventId: linkedTicketEventId, pubkey: linkedTicketPubkey } =
    linkedTicketTarget(context.target, reportedPubkey);

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

  const historyIncomplete = context.userStats?.reportsIncomplete === true
    || context.userStats?.labelsIncomplete === true;
  const summary = useUserSummary(
    context.reportedUser.pubkey || undefined,
    context.userStats?.recentPosts,
    context.userStats?.existingLabels,
    context.userStats?.previousReports,
    {
      reportsIncomplete: context.userStats?.reportsIncomplete,
      labelsIncomplete: context.userStats?.labelsIncomplete,
    },
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
  // Why a gone post is gone, from what has actually answered (lib/goneCause).
  // The badge (label, icon, tooltip) and the thread panel all read this one answer.
  const goneCause = deriveGoneCause({
    eventGone: isEventDeleted,
    recordedDelete: !!decisionLog.isDeleted,
    autoHidden: decisionLog.isAutoHidden,
    decisionsUnread: decisionLog.isPending ? 'checking' : decisionLog.error ? 'failed' : null,
    userBanned: isUserBanned,
    userBannedStale: moderationStatus.isUserBannedStale,
    eventBanned: moderationStatus.isEventBanned,
    eventBannedStale: moderationStatus.isEventBannedStale,
    suspended: moderationStatus.isUserSuspended,
    suspendedStale: moderationStatus.isUserSuspendedStale,
    // Per status, so each unknown says "still checking" or "couldn't check"
    // for its own read (the ban part agrees with the thread panel's ban line).
    checking: {
      suspension: moderationStatus.isUserSuspensionChecking,
      accountBan: moderationStatus.isUserBanChecking,
      eventBan: moderationStatus.isEventBanChecking,
    },
  });
  // Whether the reported post is banned, for the post actions: `null` when
  // nothing has said (EventActions then keeps Ban and Delete and leaves out
  // Restore). Only the banned-events list answers it: its "no" never comes
  // from a failed refresh, and its "yes" counts only from a refresh that
  // succeeded. The live check is no evidence: its "found it" is kept from when
  // it ran and can predate a ban made since. Unknown and not banned offer the
  // same actions, so all leaning on it would buy is dropping the note. Nor is
  // the getbannedevent read: funnelcake also answers it for a post under a
  // moderation hold, which is not a ban and which Restore does not lift.
  const isEventBannedForActions: boolean | null = moderationStatus.isEventBanned === false ? false
    : moderationStatus.isEventBanned === true && !moderationStatus.isEventBannedStale ? true
    : null;
  // A read still out can settle it: the banned-events list, or the live check,
  // which asks the lists to re-read once it answers.
  const isEventBanForActionsPending = isEventBannedForActions === null
    && (moderationStatus.isEventBanChecking || moderationStatus.isChecking);
  const isResolved = decisionLog.hasHandlingDecisions || pubkeyDecisionLog.hasHandlingDecisions || isUserBanned || isEventDeleted;
  // The banner names what handled the report, not a skip logged after it.
  const lastHandlingDecision = decisionLog.latestHandlingDecision || pubkeyDecisionLog.latestHandlingDecision;

  // The decision log card's "Already Handled" title and colour.
  const showAlreadyHandled = decisionLog.hasHandlingDecisions && !handledBefore;

  // Auto-hide specific status
  const isPendingReview = decisionLog.isPendingReview;

  const reviewMutation = useMutation({
    mutationFn: async ({ status, comment }: { status: ResolutionStatus; comment?: string }) => {
      if (!context.target) throw new Error('No target');
      const act = api.asModerator(getModeratorToken()); // take the login at the click
      const result = await act.markAsReviewed(
        context.target.type,
        context.target.value,
        status,
        comment,
      );
      // Audit log is non-critical; markAsReviewed (the resolution label) is the
      // authoritative action, so don't let a failed decision write report failure.
      logAudit(act, {
        targetType: context.target.type,
        targetId: context.target.value,
        action: status,
        reason: comment,
        reportId: report?.id,
      });
      return result;
    },
    onSuccess: (result, variables) => {
      queryClient.invalidateQueries({ queryKey: ['labels'] });
      // The queue filters on the worker-side projections of labels and
      // decisions, not on the raw reads, so those are the keys to refresh,
      // along with both report feeds, which the worker filters the same way.
      queryClient.invalidateQueries({ queryKey: ['resolution-label-targets'] });
      invalidateResolutionState(queryClient);
      queryClient.invalidateQueries({ queryKey: ['decisions'] });
      decisionLog.refetch();
      if (result.recorded !== true || result.reconciled === false) {
        toast({
          title: 'Resolution saved; visibility needs attention',
          description: result.recorded
            ? 'The review was recorded, but auto-hidden content could not be restored. Use Restore content before closing this report.'
            : 'The resolution label was published, but visibility and review state could not be reconciled.',
          variant: 'destructive',
          duration: Infinity,
        });
        return;
      }
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

  // What a reopen acts on, captured at click time rather than read from
  // `context` when the mutation runs. The degraded toast below outlives this
  // panel's selection (duration Infinity, and selecting another report
  // re-renders ReportDetail rather than remounting it), and mutate() rebuilds
  // the mutation from the observer's LATEST options -- so a mutationFn closing
  // over `context` would send the retry at whichever report is selected when
  // it is clicked, reopening that report instead.
  type ReopenTarget = { type: 'event' | 'pubkey'; value: string; reportedPubkey?: string | null };

  const reopenMutation = useMutation({
    mutationFn: async (target: ReopenTarget | null) => {
      if (!target) throw new Error('No target');
      const act = api.asModerator(getModeratorToken()); // take the login at the click
      // Reopen the target. The worker records a dated `reopened` row and keeps
      // the history (#324); the call keeps its old name and route.
      const primary = await act.deleteDecisions(target.value, target.type);
      // A post's reopen also reopens its author's account, as it did when it
      // deleted both targets' decisions.
      let secondary = { labelCleanupFailed: false };
      if (target.type === 'event' && target.reportedPubkey) {
        secondary = await act.deleteDecisions(target.reportedPubkey, 'pubkey');
      }
      return { labelCleanupFailed: primary.labelCleanupFailed || secondary.labelCleanupFailed };
    },
    onSuccess: ({ labelCleanupFailed }, target) => {
      queryClient.invalidateQueries({ queryKey: ['decisions'] });
      invalidateResolutionState(queryClient);
      // The helper above refreshes the report feeds: a reopen moves the target
      // out of resolved history and back into the needs-attention feed. Reopen
      // no longer changes resolution labels (#324): the reopen row makes older
      // labels stop counting. The label refresh is kept for a rolled-back
      // worker, which bans them, and without a refresh that target would stay
      // hidden for a poll cycle, a full minute on the label source.
      // TODO(#409): remove this label refresh once no worker from before #324
      // can be live.
      queryClient.invalidateQueries({ queryKey: ['resolution-label-targets'] });
      decisionLog.refetch();
      pubkeyDecisionLog.refetch();
      // Report what the reopen did, not where the report ends up: whether it
      // returns to the queue depends on the screen's resolution sources,
      // which a toast cannot see. Under the dated rule a relay ban the
      // decision log dates no longer hides the reopened target's reports
      // (reportResolution.ts), so the copy does not say it does.
      // TODO(#409): remove the labelCleanupFailed toast branch (and labelsDeleted
      // handling); only a pre-#324 worker sets it.
      toast(labelCleanupFailed
        ? {
            // Only a worker from before #324 reports this: it deleted the
            // decisions and banned the resolution labels, and this says the
            // label half fell short. The current worker clears nothing and
            // always answers false. Kept so a rolled-back worker still reads
            // right.
            //
            // Deliberately does not name the relay: one of the causes is our
            // own page cap, where the relay did exactly what it was asked.
            title: "Reopened, but resolution labels could not all be cleared",
            description: "Some may remain, so this report may stay hidden.",
            variant: "destructive" as const,
            // The decisions ARE gone on this path, so hasHandlingDecisions goes false
            // and the Reopen button unmounts. Retrying is the right advice and
            // the cleanup is idempotent, so the retry has to come with it, and
            // it does not expire on a timer.
            //
            // It is still single-use. Radix renders ToastAction as a
            // ToastClose, so the click that fires the retry also dismisses this
            // toast. A retry that comes back still-degraded raises a fresh one
            // carrying a fresh action; a retry that THROWS lands in onError,
            // which has no action, and ends the chain. TOAST_LIMIT is 1, so any
            // later toast evicts it too. The fallback in both cases is to
            // resolve the report again and reopen.
            //
            // Re-sends the target this toast was raised for, not whatever is
            // selected when it is clicked -- see ReopenTarget above.
            action: (
              <ToastAction altText="Retry the reopen" onClick={() => reopenMutation.mutate(target)}>
                Try again
              </ToastAction>
            ),
            duration: Infinity,
          }
        : {
            title: "Report reopened",
            description: "Its history is kept, and reports filed before now count as new again.",
            // Longer than the 5s Radix default can be read in.
            duration: 10000,
          });
    },
    onError: (error: Error) => {
      // The post's reopen row may already be written when the author's call
      // throws. Nothing is removed, but the post now reads as reopened, so the
      // cached decisions and the queue's view can be stale even though the
      // action reports failure. Refresh them rather than leaving the panel
      // calling the post handled.
      queryClient.invalidateQueries({ queryKey: ['decisions'] });
      invalidateResolutionState(queryClient);
      queryClient.invalidateQueries({ queryKey: ['resolution-label-targets'] });
      decisionLog.refetch();
      pubkeyDecisionLog.refetch();
      toast({
        title: "Failed to reopen",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  // The original a repost names, only once it checks out as that event (#337):
  // useThread's, which is checked, or else the repost's own copy when its id
  // and signature check (a banned repost shown from the ban list, or one whose
  // fetch missed). The media buttons and the original's preview both use it,
  // so the moderator sees what the buttons act on. A copy that does not check
  // out is the reposter's writing, and gets neither.
  const isRepostEvent = !!displayEvent && isRepostKind(displayEvent.kind);
  // Content that looks like JSON is taken as the repost's copy of the original,
  // well formed or not: only a copy that checks out is read, so a malformed or
  // cut-off one cannot pass its files on as text. Decided once, here, so the
  // card, the preview and the buttons below cannot disagree about it.
  const repostHasCopy = isRepostEvent && !!displayEvent && looksLikeEventCopy(displayEvent.content);
  const checkedOriginal = useMemo(
    () => context.thread?.repostedEvent ?? (displayEvent && isRepostEvent ? verifiedRepostedEvent(displayEvent) : null),
    [context.thread?.repostedEvent, displayEvent, isRepostEvent],
  );
  const repostCopyUnchecked = repostHasCopy && !checkedOriginal;
  // The same for an original that is itself a repost: its JSON content is its own
  // copy of another event, never checked, and read as text it would give up that
  // event's id and author key as files and its URLs to a preview. Plain text in
  // an out-of-spec one is read as any post's is.
  const originalHasCopy = !!checkedOriginal && isRepostKind(checkedOriginal.kind)
    && looksLikeEventCopy(checkedOriginal.content);
  // The checked original as its preview in the repost card shows it.
  const originalPreviewEvent = useMemo(
    () => (checkedOriginal && originalHasCopy ? { ...checkedOriginal, content: '' } : checkedOriginal),
    [checkedOriginal, originalHasCopy],
  );
  // The reported repost as its own media preview shows it: without a copy of
  // the original in its content, so the preview never shows files the buttons
  // were refused. A checked original has its own preview, in the repost card.
  const displayPreviewEvent = useMemo(
    () => (displayEvent && repostHasCopy ? { ...displayEvent, content: '' } : displayEvent),
    [displayEvent, repostHasCopy],
  );

  // Extract media hashes from the reported event AND reposted event if it's a repost.
  // A video's own thumbnails are kept apart so EventActions acts on them after the
  // video, and a thumbnail failure never fails the video's action.
  const { mediaHashes, thumbnailHashes } = useMemo(() => {
    const media = new Set<string>();
    const thumbnails = new Set<string>();
    const add = (content: string, tags: string[][]) => {
      const files = extractMediaFiles(content, tags);
      files.media.forEach(h => media.add(h));
      files.thumbnails.forEach(h => thumbnails.add(h));
    };
    // A repost's content is the original event as JSON, the reposter's copy of
    // it. Its tags still count, and the original's files come from
    // checkedOriginal only: content that looks like JSON is never read for files,
    // well formed or not. Some out-of-spec reposts carry a media URL as plain
    // text instead, which the preview shows, so that is read too, as any post's
    // text is.
    if (displayEvent && isRepostEvent) {
      add('', displayEvent.tags);
      if (checkedOriginal) add(originalHasCopy ? '' : checkedOriginal.content, checkedOriginal.tags);
      if (!repostHasCopy) add(displayEvent.content, []);
    } else if (displayEvent) {
      add(displayEvent.content, displayEvent.tags);
    }
    // As within one extraction, a file any source names as a thumbnail stays one:
    // a repost's text linking the original's thumbnail does not make it a video,
    // which Unblock Media and Remove Restriction would lift.
    return {
      mediaHashes: Array.from(media).filter(h => !thumbnails.has(h)),
      thumbnailHashes: Array.from(thumbnails),
    };
  }, [displayEvent, isRepostEvent, repostHasCopy, checkedOriginal, originalHasCopy]);

  // Check media status from moderation service. Thumbnails are included, so a
  // gated thumbnail gets its own undo button and Age Restrict skips a blocked one.
  const allMediaHashes = useMemo(() => [...mediaHashes, ...thumbnailHashes], [mediaHashes, thumbnailHashes]);
  const mediaStatus = useMediaStatus(allMediaHashes);
  // Which buttons show follows the video, so a thumbnail blocked on its own can't
  // swap the video's Block and Age Restrict for the undo buttons.
  const videoStatuses = mediaStatus.results.filter(r => mediaHashes.includes(r.hash));
  const videoIsBlocked = videoStatuses.some(r => r.isBlocked);
  const videoIsRestricted = videoStatuses.some(r => r.isRestricted);

  // undefined while loading, then true/false once reports are available. A
  // sensitive report in hand is true even when the reports may not be all of
  // them: what is missing can only add to it. Otherwise partial reports are
  // undefined. undefined and true both start media hidden until clicked. The
  // thread, full-thread and repost avatars have no Show: for them undefined and
  // true both hide, and only false shows them.
  const hasHighPriorityReports = useMemo(() => {
    if (!allReportsForTarget) return undefined;
    const sensitive = allReportsForTarget.some(r => {
      const cat = getReportCategory(r);
      return HIGH_PRIORITY_CATEGORIES.includes(cat);
    }) || hasCsamSignal(allReportsForTarget);
    if (sensitive) return true;
    // On purpose, a target that turns partial with nothing sensitive in hand
    // keeps the post media and the account card that were showing: those take
    // undefined as "no change", and nothing known about the target is
    // sensitive. The thread, full-thread and repost avatars, which have no
    // Show, read undefined as hidden and do hide.
    return targetReportsMayBePartial ? undefined : false;
  }, [allReportsForTarget, targetReportsMayBePartial]);
  // The pane's media viewers take "not known yet" as null rather than false:
  // both start hidden, but only under null does a later false (the reports turn
  // out sensitive) forget a Show the moderator made meanwhile. A target that
  // left the list (see targetLeftList) is treated as sensitive, as main does:
  // what showed by default hides, a Show on a target not known to be sensitive
  // is forgotten, and a Show on a sensitive one is kept.
  const mediaShownByDefault = targetLeftList ? false
    : hasHighPriorityReports === undefined ? null : !hasHighPriorityReports;

  // Confirm auto-hidden content (approve the auto-hide decision)
  const confirmAutoHideMutation = useMutation({
    mutationFn: async ({ targetId, targetType }: { targetId: string; targetType: 'event' | 'pubkey' }) => {
      const act = api.asModerator(getModeratorToken()); // take the login at the click
      if (targetType === 'event') {
        await act.confirmAutoHide({
          eventId: targetId,
          reason: 'Auto-hide confirmed by moderator',
          reportId: report?.id,
          reporterPubkey: report?.pubkey,
        });
      } else {
        await act.logDecision({
          targetType,
          targetId,
          action: 'auto_hide_confirmed',
          reason: 'Auto-hide confirmed by moderator',
          reportId: report?.id,
        });
      }
      return targetId;
    },
    onSuccess: async () => {
      queryClient.invalidateQueries({ queryKey: ['decisions'] });
      // The pending-review view is built from the resolution-state projection's
      // auto-hide states, so a confirm has to refresh it to leave that view.
      invalidateResolutionState(queryClient);

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
      const act = api.asModerator(getModeratorToken()); // take the login at the click
      return act.restoreEvent(eventId, 'Auto-hide reversed by moderator');
    },
    onSuccess: async (result) => {
      queryClient.invalidateQueries({ queryKey: ['banned-events'] });
      queryClient.invalidateQueries({ queryKey: ['decisions'] });
      invalidateResolutionState(queryClient);

      moderationStatus.recheck();
      decisionLog.refetch();
      toast(result.recorded === true && result.reconciled !== false
        ? { title: "Content restored", description: "Auto-hide has been reversed" }
        : {
            title: result.recorded === true
              ? "Restore recorded; final relay state uncertain"
              : "Restore applied but not recorded",
            variant: "destructive",
          });
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to restore content",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  // Every action in the pane lands here. Only UserActions' ban, unban, suspend
  // and unsuspend change the account's status, and it says so. The rest (post,
  // media and bulk content actions, through EventActions, BulkDeleteByKind,
  // UserActions' bulk jobs and the delete below) call it with no change.
  const handleActionComplete = (change?: UserActionChange) => {
    queryClient.invalidateQueries({ queryKey: ['banned-events'] });
    queryClient.invalidateQueries({ queryKey: ['banned-users'] });
    queryClient.invalidateQueries({ queryKey: ['decisions'] });
    invalidateResolutionState(queryClient);
    queryClient.invalidateQueries({ queryKey: ['media-status'] });
    // Reflect any ticket the action auto-closed so the panel flips to "Closed ✓".
    queryClient.invalidateQueries({ queryKey: ['linked-tickets'] });
    if (change?.accountStatusChanged) {
      // The account status on screen predates the action. This check
      // re-reads the account lists (banned and suspended pubkeys) itself.
      moderationStatus.recheckAfterAction();
      // The acted-on account's Keycast label reads the shared account-status query,
      // and the worker mirrors this action into Keycast. Refresh it, or the label
      // keeps its pre-action answer for the query's minute of staleness. The mirror
      // runs after the worker responds, so the first read can beat it; a second
      // read follows once the mirror has had time to land. Only that account
      // changed, so only its entry is refreshed. It comes from UserActions, not
      // from this pane: the moderator may have opened another report since.
      refreshAccountStatusAfterMirror(queryClient, change.pubkey);
      // UserActions drops the acted-on account's authored-content reads itself
      // (and opens the restore window after an unsuspend).
    } else {
      queryClient.invalidateQueries({ queryKey: userStatsQueryKey(config.relayUrl, context.reportedUser.pubkey) });
      // A content action leaves the account status as it was, so the previous
      // answer stands while the check runs.
      queryClient.invalidateQueries({ queryKey: ['banned-pubkeys'] });
      queryClient.invalidateQueries({ queryKey: ['suspended-pubkeys'] });
      moderationStatus.recheck();
    }
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
  const categoryLabel = getCategoryLabel(category);
  // Any report on the target, not just the selected one, so the header agrees
  // with the queue row when an older report carries the CSAM signal.
  const isHighPriorityCategory = HIGH_PRIORITY_CATEGORIES.includes(category)
    || classifyReport(report).csamSignal
    || hasCsamSignal(allReportsForTarget ?? []);

  // Scroll the whole pane, not just an inner region. On a short viewport the
  // tall action footer used to starve the content area (it was a shrink-0 block
  // outside the scroll), squeezing the report context to a sliver and making it
  // unreachable. Scrolling the pane keeps the footer pinned to the bottom when
  // the content fits and lets the content + footer scroll together when it does
  // not.
  return (
    <div className="h-full flex flex-col overflow-y-auto">
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
          hideAvatars={hasHighPriorityReports !== false}
        />
      )}

      {/* Content area. flex-1 without min-h-0: it keeps its natural height and the
          pane above scrolls, instead of collapsing to a sliver under the footer. */}
      <div className="flex-1">
        <div className="p-4 space-y-4 overflow-x-hidden max-w-full">
          {/* Pending Review Banner - for auto-hidden items awaiting human review */}
          {isPendingReview && (
            <div className="bg-orange-100 dark:bg-orange-950/50 border border-orange-300 dark:border-orange-800 rounded-lg p-3">
              <div className="flex items-center gap-3 mb-3">
                <EyeOff className="h-6 w-6 text-orange-600" />
                <div className="flex-1">
                  {/* Read from this pane's own decision log, not the switchState
                      prop: that comes from /api/resolution-state, which may
                      still be loading or have failed. */}
                  <p className="font-medium text-orange-800 dark:text-orange-300">
                    {decisionLog.isAutoHideRestoreFailed
                      ? 'Auto-Hidden — Restore Failed'
                      : decisionLog.isAutoHideUnresolved
                        ? 'Auto-Hidden — Restore Check Failed'
                        : 'Auto-Hidden — Pending Review'}
                  </p>
                  <p className="text-sm text-orange-600 dark:text-orange-400">
                    {decisionLog.isAutoHideRestoreFailed
                      ? 'A moderator restored this while it was being hidden automatically, and undoing the hide failed. Retry restoring this content.'
                      : decisionLog.isAutoHideUnresolved
                        ? 'This content was hidden automatically, but the worker could not check whether a moderator restored it at the same time. Review and confirm or restore.'
                        : 'This content was automatically hidden based on a report. Please review and confirm or restore.'}
                  </p>
                </div>
              </div>
              <div className="flex gap-2">
                {!decisionLog.isAutoHideRestoreFailed && <Tooltip>
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
                </Tooltip>}
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

          {/* Decision log banner - show when there's a recorded moderation action (but not pending review).
              Never on a report handled before (#324): its green check would
              say resolved above the Handled before card, about the report no
              one has answered. */}
          {isResolved && !isPendingReview && lastHandlingDecision && !handledBefore && (
            <div className="bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-800 rounded-lg px-3 py-2 flex items-center gap-2">
              <CheckCircle className="h-4 w-4 text-green-600 shrink-0" />
              <p className="text-sm text-green-700 dark:text-green-400">
                Last action: {lastHandlingDecision.action.replace(/_/g, ' ')} on {new Date(lastHandlingDecision.created_at || '').toLocaleDateString()}
              </p>
            </div>
          )}

          {/* Header */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 flex-wrap">
              <Badge variant={isHighPriorityCategory ? "destructive" : "outline"}>{categoryLabel}</Badge>
              {switchState === 'not-hidden' && (
                <Badge variant="outline">{SWITCH_STATE_LABELS['not-hidden']}</Badge>
              )}
              <Badge variant="secondary">
                {context.target?.type === 'event' ? 'Event' : 'User'}
              </Badge>
              {isUserBanned && (
                moderationStatus.isUserBannedStale ? (
                  // Carried over from a copy of the list that is not current (its
                  // latest refresh failed, or it has not answered since the latest
                  // check), and no live answer confirms it.
                  <Badge variant="outline" className="flex items-center gap-1 text-muted-foreground">
                    <Ban className="h-3 w-3" />
                    Banned (last known)
                  </Badge>
                ) : (
                  <Badge variant="destructive" className="flex items-center gap-1">
                    <Ban className="h-3 w-3" />
                    User Banned
                  </Badge>
                )
              )}
              {isEventDeleted && goneCause.kind !== 'not-gone' && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    {/* Label, icon and tooltip all come from goneCause, so they
                        rank causes the way the thread panel does. Red and
                        ShieldX state a removal the badge names; a post withheld
                        for a suspension, or one nobody has explained, is not one. */}
                    <Badge
                      variant={goneCause.tone === 'removal' ? 'destructive' : 'outline'}
                      className={`flex items-center gap-1 cursor-help${goneCause.tone === 'removal' ? '' : ' text-muted-foreground'}`}
                    >
                      {goneCause.tone === 'withheld' ? <EyeOff className="h-3 w-3" />
                        : goneCause.tone === 'unknown' ? <AlertTriangle className="h-3 w-3" />
                        : <ShieldX className="h-3 w-3" />}
                      {goneCause.badge}
                    </Badge>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="max-w-xs">
                    {goneCause.kind === 'explained' && goneCause.by === 'delete' ? (
                      <p className="text-xs">
                        Deleted via relay admin
                        {decisionLog.decisions.find(d => d.action === 'delete_event' || d.action === 'delete')?.created_at &&
                          ` on ${new Date(decisionLog.decisions.find(d => d.action === 'delete_event' || d.action === 'delete')!.created_at).toLocaleDateString()}`
                        }
                      </p>
                    ) : (
                      // goneCause's own line, which the thread panel shows too,
                      // so the two give the same reason. An auto-hide covers the
                      // states that need a check as well: the worker writes those
                      // only after the relay ban landed, so the content is hidden
                      // either way.
                      <p className="text-xs">{goneCause.line}</p>
                    )}
                  </TooltipContent>
                </Tooltip>
              )}
              {isPendingReview && (
                <Badge variant="outline" className="flex items-center gap-1 border-orange-500 text-orange-600">
                  <EyeOff className="h-3 w-3" />
                  {/* The queue row's label, so the pane and the row agree. */}
                  {decisionLog.isAutoHideUnresolved || decisionLog.isAutoHideRestoreFailed
                    ? SWITCH_STATE_LABELS['hidden-needs-check']
                    : SWITCH_STATE_LABELS['auto-hidden']}
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

          {/* Linked Zendesk ticket(s), when the report has a valid lookup target. */}
          {(linkedTicketEventId || linkedTicketPubkey) && (
            <div className="flex items-start gap-2">
              <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Linked ticket</h4>
              <LinkedTicketPanel eventId={linkedTicketEventId} pubkey={linkedTicketPubkey} />
            </div>
          )}

          {/* Report Reasons - What reporters said */}
          {allReportsForTarget && allReportsForTarget.length > 0 ? (
            <Card className="border-red-200 bg-red-50/50 dark:bg-red-950/20">
              <CardHeader className="py-3">
                <CardTitle className="text-sm flex items-center gap-2 text-red-700 dark:text-red-400">
                  <Flag className="h-4 w-4" />
                  Why This Was Reported ({historyCount(allReportsForTarget.length, allReportsForTargetTruncated)} report{allReportsForTargetTruncated || allReportsForTarget.length !== 1 ? 's' : ''})
                </CardTitle>
              </CardHeader>
              <CardContent className="py-0 pb-3 space-y-3">
                {allReportsForTarget.slice(0, 5).map((r) => {
                  const cat = getReportCategory(r);
                  const catLabel = getCategoryLabel(cat);
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
                        <AccountTypeLabel pubkey={r.pubkey} />
                      </div>
                      {/* Report details */}
                      <div className="flex items-center gap-2 mb-1 min-w-0">
                        {/* The app name is reporter-set and can be long; it truncates
                            while the badge and date keep their size. */}
                        <Badge variant="destructive" className="text-xs shrink-0">{catLabel}</Badge>
                        <span className="text-xs text-muted-foreground shrink-0">
                          {new Date(r.created_at * 1000).toLocaleDateString()}
                        </span>
                        <ReportClientText reports={[r]} />
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
                  <p className="text-xs text-muted-foreground">{overflowLine(allReportsForTarget.length - 5, allReportsForTargetTruncated)}</p>
                )}
              </CardContent>
            </Card>
          ) : (
            // Shown even without a reason, so a report with no group list (no
            // target, or its group filtered out) still says which app it names.
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
                  <AccountTypeLabel pubkey={report.pubkey} />
                  <ReportClientText reports={[report]} />
                </div>
                {report.content ? (
                  <p className="text-sm">{report.content}</p>
                ) : (
                  <p className="text-sm text-muted-foreground italic">No reason provided</p>
                )}
              </CardContent>
            </Card>
          )}

          {/* Handled before (#324): a person handled this item, then this
              report came. Every entry of that handling's history, dated,
              reopens and reversals included, and for an account a prompt to
              look again at its current state. The decision log card stays
              below it for the reasons and the rows that handle nothing. */}
          {handledBefore && (
            <Card className="border-amber-200 bg-amber-50/50 dark:bg-amber-950/20">
              <CardHeader className="py-3">
                <CardTitle className="text-sm flex items-center gap-2 text-amber-700 dark:text-amber-400">
                  <History className="h-4 w-4" />
                  Handled before
                </CardTitle>
              </CardHeader>
              <CardContent className="py-0 pb-3 space-y-2">
                {handledBefore.ban && (
                  <Badge variant="outline" className="text-xs">
                    {handledBeforeBanText(handledBefore.ban)}
                  </Badge>
                )}
                {context.target?.type === 'pubkey' && (
                  <p className="text-sm">{ACCOUNT_HANDLED_BEFORE_PROMPT}</p>
                )}
                {/* Through the post's banned author: not the post's own handling. */}
                {handledBefore.via === 'author' && (
                  <p className="text-xs text-muted-foreground">History of the post's author</p>
                )}
                <div className="space-y-2">
                  {handledBefore.history.map((entry, i) => (
                    <div
                      key={i}
                      data-testid="handled-before-entry"
                      className="flex items-start justify-between text-xs p-2 bg-background rounded"
                    >
                      <Badge variant="outline" className="text-xs">
                        {entry.action.replace(/_/g, ' ')}
                      </Badge>
                      <span className="text-muted-foreground shrink-0">
                        {entry.at === null ? 'date unknown' : new Date(entry.at * 1000).toLocaleDateString()}
                      </span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Decision History - show if target already has decisions. For a
              report handled before (#324) it is never "Already Handled": this
              report is the one no one has answered. */}
          {decisionLog.hasDecisions && (
            <Card className={showAlreadyHandled ? 'border-green-200 bg-green-50/50 dark:bg-green-950/20' : undefined}>
              <CardHeader className="py-3">
                <CardTitle className={`text-sm flex items-center gap-2 ${showAlreadyHandled ? 'text-green-700 dark:text-green-400' : 'text-muted-foreground'}`}>
                  <History className="h-4 w-4" />
                  {showAlreadyHandled ? 'Already Handled' : 'Decision History'} ({decisionLog.decisions.length} action{decisionLog.decisions.length !== 1 ? 's' : ''})
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
                replies={context.thread?.replies}
                reportedPubkey={context.reportedUser.pubkey}
                isEventDeleted={moderationStatus.isEventGone}
                isUserBanned={moderationStatus.isUserBanned}
                isUserBannedStale={moderationStatus.isUserBannedStale}
                goneCause={goneCause}
                isUserBanChecking={moderationStatus.isUserBanChecking}
                checkedAt={moderationStatus.checkedAt}
                onRecheck={moderationStatus.recheck}
                isRechecking={moderationStatus.isChecking}
                hideAvatars={hasHighPriorityReports !== false}
                // The audited viewer, for a post the confirmed suspension
                // explains, or may explain beside a ban nothing could check
                // (Matt, 2026-11-09: a banned post then reads as hidden for
                // another reason). The target id comes from the report's own
                // tags, so only a 64-hex id is offered, the worker checks it
                // again, and the post is checked against the reported account.
                suspendedViewer={(goneCause.kind === 'suspended'
                  || (goneCause.kind === 'unknown' && moderationStatus.isUserSuspended === true))
                  && targetEventId && isHex64(targetEventId) ? (
                  <SuspendedPostViewer
                    key={targetEventId}
                    eventId={targetEventId}
                    surface="report"
                    showMediaByDefault={mediaShownByDefault}
                    expectedAuthor={reportedPubkey || undefined}
                    subject="the reported account"
                  />
                ) : undefined}
              />
            </>
          )}

          {/* A list's content is empty or encrypted, so summarize it from its tags */}
          {displayEvent && isListKind(displayEvent.kind) && (
            <ReportedListCard event={displayEvent} />
          )}

          {/* Repost Original Content - show when the reported event is a repost */}
          {(context.thread?.isRepost || isRepostEvent) && (
            <Card className="border-blue-200 bg-blue-50/50 dark:bg-blue-950/20">
              <CardHeader className="py-3">
                <CardTitle className="text-sm flex items-center gap-2 text-blue-700 dark:text-blue-400">
                  <Repeat2 className="h-4 w-4" />
                  This is a Repost - Original Content Below
                </CardTitle>
              </CardHeader>
              <CardContent className="py-0 pb-3">
                {checkedOriginal ? (
                  <div className="space-y-3">
                    {/* Original author */}
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">Original author:</span>
                      <UserIdentifier
                        pubkey={checkedOriginal.pubkey}
                        showAvatar
                        hideAvatarImage={hasHighPriorityReports !== false}
                        avatarSize="sm"
                        variant="inline"
                        linkToProfile
                      />
                    </div>
                    {/* Original content */}
                    <div className="bg-background p-3 rounded-lg border">
                      <p className="text-sm whitespace-pre-wrap break-words">
                        {checkedOriginal.content}
                      </p>
                      <div className="flex items-center gap-2 mt-2 text-xs text-muted-foreground">
                        <span>Kind {checkedOriginal.kind}</span>
                        <span>·</span>
                        <span>{new Date(checkedOriginal.created_at * 1000).toLocaleString()}</span>
                      </div>
                    </div>
                    {/* Media in original post. Keyed by report, like the other
                        viewers: a revealed one must not carry over to the next
                        report. */}
                    <MediaPreview
                      key={report.id}
                      event={originalPreviewEvent ?? checkedOriginal}
                      showByDefault={mediaShownByDefault}
                      maxItems={6}
                    />
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground italic">
                    {repostCopyUnchecked
                      ? "No copy of the original that checks out was found, so its files aren't offered"
                      : 'Could not load the original event that was reposted'}
                  </p>
                )}
              </CardContent>
            </Card>
          )}

          {/* Media Preview - show the actual content being reported */}
          {/* Keyed by report: the thread of the next report is often cached, so
              this stays mounted. MediaPreview itself starts again for a new
              event, and hides when its default turns false, but another report
              on the same event with the same default would keep a Show the
              moderator made on this one. A fresh mount starts from
              showByDefault. */}
          {displayPreviewEvent && (
            <MediaPreview
              key={report.id}
              event={displayPreviewEvent}
              showByDefault={mediaShownByDefault}
              maxItems={6}
            />
          )}

          {/* User moderation status - for user reports where there's no ThreadContext to show it */}
          {context.target?.type === 'pubkey' && (moderationStatus.checkedAt || moderationStatus.isChecking) && (
            <div className="rounded-md border bg-muted/30 p-3 space-y-2">
              {moderationStatus.isUserBanned === true && moderationStatus.isUserBannedStale ? (
                // Carried over from a copy of the list that is not current (its
                // latest refresh failed, or it has not answered since the latest
                // check), and no live answer confirms it. Green would present it
                // as confirmed, which right after an Unban can be exactly wrong.
                // Ahead of the checking branch below so the last-known ban stays
                // on screen; while something that can settle the ban is still
                // out (every Unban), it has not failed to confirm anything yet.
                <div className="flex items-center gap-2 p-2 rounded bg-muted">
                  <Ban className="h-4 w-4 text-muted-foreground shrink-0" />
                  <span className="text-sm font-medium text-muted-foreground">
                    {moderationStatus.isUserBanChecking
                      ? 'Last known: banned. Checking now.'
                      : 'Last known: banned. The latest check could not confirm it.'}
                  </span>
                </div>
              ) : moderationStatus.isUserBanned === true ? (
                <div className="flex items-center gap-2 p-2 rounded bg-green-100 dark:bg-green-950/50">
                  <Ban className="h-4 w-4 text-green-600 shrink-0" />
                  <span className="text-sm font-medium text-green-700 dark:text-green-400">
                    User is banned on the relay
                  </span>
                </div>
              ) : moderationStatus.isUserBanned === false && moderationStatus.checkedAt ? (
                <div className="flex items-center gap-2 p-2 rounded bg-yellow-100 dark:bg-yellow-950/50">
                  <User className="h-4 w-4 text-yellow-600 shrink-0" />
                  <span className="text-sm font-medium text-yellow-700 dark:text-yellow-400">
                    User is not banned
                  </span>
                </div>
              ) : moderationStatus.isAccountStatusLoading ? (
                // Not answered yet. isAccountStatusLoading rather than
                // isChecking: after a live check that could not answer, the
                // lists' re-read can still settle the ban, and this keeps the
                // panel in step with the "Checking account status" note.
                <div className="flex items-center gap-2 p-2 rounded bg-muted">
                  <RefreshCw className="h-4 w-4 text-muted-foreground shrink-0 animate-spin" />
                  <span className="text-sm font-medium text-muted-foreground">
                    Checking ban status...
                  </span>
                </div>
              ) : moderationStatus.checkedAt ? (
                // The check ran and could not answer. Saying "not banned" here
                // would state a fact nothing observed.
                <div className="flex items-center gap-2 p-2 rounded bg-muted">
                  <RefreshCw className="h-4 w-4 text-muted-foreground shrink-0" />
                  <span className="text-sm font-medium text-muted-foreground">
                    Could not check ban status
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
          <AccountTypeLabel pubkey={context.reportedUser.pubkey} />
          <UserProfileCard
            key={report.id}
            profile={context.reportedUser.profile}
            pubkey={context.reportedUser.pubkey}
            stats={context.userStats}
            isLoading={false}
            isFunnelcakeUser={context.reportedUser.isFunnelcakeUser}
            isSuspended={moderationStatus.isUserSuspended}
            isSuspendedStale={moderationStatus.isUserSuspendedStale}
            isSuspensionChecking={moderationStatus.isUserSuspensionChecking}
            hideMediaByDefault={mediaShownByDefault === null ? null : !mediaShownByDefault}
            suspendedViewerSurface="report"
            onViewActivity={reportedPubkey ? () => {
              // Same drill-down the reporter rows get: Events tab filtered to this
              // user (#156). Encoded: the p tag comes from an attacker-authored
              // 1984 event, so it isn't guaranteed to be clean hex.
              navigate(`/events?pubkey=${encodeURIComponent(reportedPubkey)}`);
            } : undefined}
            onDeleteEvent={async (eventId) => {
              try {
                const act = api.asModerator(getModeratorToken()); // take the login at the click
                await act.deleteEvent(eventId, 'Deleted from report review');
                logAudit(act, {
                  targetType: 'event',
                  targetId: eventId,
                  action: 'delete_event',
                  reason: 'Deleted from report review',
                  reportId: report?.id,
                });
                toast({
                  title: "Event deleted",
                  description: "The event has been removed from the relay.",
                  action: (
                    <ToastAction altText="Undo delete" onClick={async () => {
                      // The undo is its own action, by whoever clicks it.
                      const undo = api.asModerator(getModeratorToken()); // take the login at the click
                      const result = await undo.restoreEvent(eventId, 'Deletion undone by moderator');
                      handleActionComplete();
                      toast(result.recorded === true && result.reconciled !== false
                        ? { title: "Event restored" }
                        : {
                            title: result.recorded === true
                              ? "Restore recorded; final relay state uncertain"
                              : "Restore applied but not recorded",
                            variant: "destructive",
                          });
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
                isLoading={summary.isLoading && !historyIncomplete}
                error={historyIncomplete ? new Error('Account history unavailable') : summary.error as Error | null}
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

          {/* Related Reports: every report naming this account, read in full,
              not just the loaded queue */}
          <RelatedReportsCard pubkey={context.reportedUser.pubkey ?? ''} currentTarget={context.target} />

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

          <Separator />


        </div>
      </div>

      {/* Action buttons. Pinned to the bottom when the pane fits; scrolls into
          view with the content above on short viewports. */}
      <div className="border-t bg-background p-4 space-y-3 shrink-0">
            {/* Resolution actions - dismiss or reopen */}
            <div className="flex flex-wrap gap-2">
              {/* Reopen: only when something handled the target since its last
                  reopen, by the decision log or, for a label, by the queue */}
              {(decisionLog.hasHandlingDecisions || pubkeyDecisionLog.hasHandlingDecisions || queueHandled) && !isUserBanned && !isEventDeleted && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="outline"
                      className="border-orange-500 text-orange-600 hover:bg-orange-50"
                      onClick={() => reopenMutation.mutate(
                        context.target && { ...context.target, reportedPubkey: context.reportedUser.pubkey }
                      )}
                      disabled={reopenMutation.isPending}
                    >
                      <History className="h-4 w-4 mr-1" />
                      {reopenMutation.isPending ? 'Reopening...' : 'Reopen'}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="max-w-xs">
                    <p>Reopen this report for review. Its history is kept, and reports filed before now count as new again.</p>
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
                thumbnailHashes={thumbnailHashes}
                mediaHashStatuses={mediaStatus.results}
                // Whatever explains a missing post (a suspension, nothing at
                // all, a cause still unknown), Restore needs a confirmed ban.
                isEventBanned={isEventBannedForActions}
                statusPending={isEventBanForActionsPending}
                hasBlockedMedia={videoIsBlocked}
                hasRestrictedMedia={videoIsRestricted}
                // Not isLoading, which covers only a first load that is fetching. A
                // re-check after an action keeps showing the old status until it
                // answers (isFetching), a first load held back offline has no
                // status at all yet (isPending), and a re-check held back offline
                // shows the old status while neither pending nor fetching (isPaused).
                mediaStatusLoading={mediaStatus.isPending || mediaStatus.isFetching || mediaStatus.isPaused}
                onActionComplete={handleActionComplete}
              />
            )}

            {/* User actions */}
            {context.reportedUser.pubkey && (
              <UserActions
                pubkey={context.reportedUser.pubkey}
                context="report"
                reportCategory={ageReviewCategory(report)}
                // Pass null through. `?? undefined` handed UserActions an
                // absent prop, which its default turned into a confirmed
                // "not banned" / "not suspended".
                isBanned={isUserBanned}
                isSuspended={moderationStatus.isUserSuspended}
                statusPending={moderationStatus.isAccountStatusLoading}
                statusStale={moderationStatus.isUserBannedStale || moderationStatus.isUserSuspendedStale}
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
                        reportId={report?.id}
                        getModeratorToken={getModeratorToken}
                        isBanned={isUserBanned}
                        isSuspended={moderationStatus.isUserSuspended}
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
