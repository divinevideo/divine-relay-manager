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
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useToast } from "@/hooks/useToast";
import { useReportContext } from "@/hooks/useReportContext";
import { useUserSummary } from "@/hooks/useUserSummary";
import { useModerationStatus } from "@/hooks/useModerationStatus";
import { ThreadContext } from "@/components/ThreadContext";
import { UserProfileCard } from "@/components/UserProfileCard";
import { UserIdentifier } from "@/components/UserIdentifier";
import { ReporterInfo } from "@/components/ReporterInfo";
import { ReporterList, ReporterInline } from "@/components/ReporterCard";
import { AISummary } from "@/components/AISummary";
import { LabelPublisherInline } from "@/components/LabelPublisher";
import { ThreadModal } from "@/components/ThreadModal";
import { useAdminApi } from "@/hooks/useAdminApi";
import { extractMediaHashes, type ResolutionStatus, type ModerationAction } from "@/lib/adminApi";
import { useMediaStatus } from "@/hooks/useMediaStatus";
import { useDecisionLog } from "@/hooks/useDecisionLog";
import { HiveAIReport } from "@/components/HiveAIReport";
import { AIDetectionReport } from "@/components/AIDetectionReport";
import { MediaPreview } from "@/components/MediaPreview";
import { CATEGORY_LABELS } from "@/lib/constants";
import { UserX, Tag, Flag, Trash2, CheckCircle, Video, History, Ban, ShieldX, Link2, User, FileText, Unlock, Repeat2, FileCode, Loader2, XCircle, RefreshCw } from "lucide-react";
import { CopyableId, CopyableTags } from "@/components/CopyableId";
import type { NostrEvent } from "@nostrify/nostrify";

function getReportCategory(event: NostrEvent): string {
  const reportTag = event.tags.find(t => t[0] === 'report');
  if (reportTag && reportTag[1]) return reportTag[1];
  const lTag = event.tags.find(t => t[0] === 'l');
  if (lTag && lTag[1]) return lTag[1];
  return 'other';
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
    banPubkey, deleteEvent, markAsReviewed, moderateMedia, unblockMedia,
    logDecision, deleteDecisions, verifyModerationAction, verifyPubkeyBanned,
    verifyEventDeleted, verifyMediaBlocked,
  } = useAdminApi();
  const navigate = useNavigate();
  const [showThreadModal, setShowThreadModal] = useState(false);
  const [showLabelForm, setShowLabelForm] = useState(false);
  const [confirmBan, setConfirmBan] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmBlockMedia, setConfirmBlockMedia] = useState(false);
  const [confirmBlockAndDelete, setConfirmBlockAndDelete] = useState(false);
  const [banOptions, setBanOptions] = useState({ deleteEvents: true, blockMedia: true });
  const [isVerifying, setIsVerifying] = useState(false);
  const [verificationResult, setVerificationResult] = useState<{
    type: 'ban' | 'delete' | 'media';
    success: boolean;
    message: string;
  } | null>(null);
  const [liveStatus, setLiveStatus] = useState<{
    userBanned: boolean | null;
    eventDeleted: boolean | null;
    checkedAt: Date | null;
    isChecking: boolean;
  }>({ userBanned: null, eventDeleted: null, checkedAt: null, isChecking: false });

  const context = useReportContext(report);

  const summary = useUserSummary(
    context.reportedUser.pubkey || undefined,
    context.userStats?.recentPosts,
    context.userStats?.existingLabels,
    context.userStats?.previousReports
  );

  // Function to check live status from relay
  const checkLiveStatus = async () => {
    setLiveStatus(prev => ({ ...prev, isChecking: true }));
    try {
      const results: { userBanned: boolean | null; eventDeleted: boolean | null } = {
        userBanned: null,
        eventDeleted: null,
      };

      // Check if user is banned
      if (context.reportedUser.pubkey) {
        results.userBanned = await verifyPubkeyBanned(context.reportedUser.pubkey);
      }

      // Check if event is deleted
      if (context.target?.type === 'event') {
        results.eventDeleted = await verifyEventDeleted(context.target.value);
      }

      setLiveStatus({
        userBanned: results.userBanned,
        eventDeleted: results.eventDeleted,
        checkedAt: new Date(),
        isChecking: false,
      });
    } catch (error) {
      console.error('Failed to check live status:', error);
      setLiveStatus(prev => ({ ...prev, isChecking: false }));
      toast({
        title: "Failed to check status",
        description: "Could not verify moderation status from relay",
        variant: "destructive",
      });
    }
  };

  // Check moderation status (banned/deleted)
  const moderationStatus = useModerationStatus(
    context.reportedUser.pubkey,
    context.target?.type === 'event' ? context.target.value : null
  );

  // Get decision history for this target
  const decisionLog = useDecisionLog(context.target?.value);

  // Also check decision log for the pubkey specifically (in case target is an event)
  const pubkeyDecisionLog = useDecisionLog(
    context.target?.type === 'event' ? context.reportedUser.pubkey : null
  );

  // Relay is source of truth for current ban/delete status
  // D1 decisions are audit log only, not status indicators
  const isUserBanned = moderationStatus.isBanned;
  const isEventDeleted = moderationStatus.isDeleted;
  const isResolved = decisionLog.hasDecisions || pubkeyDecisionLog.hasDecisions || isUserBanned || isEventDeleted;

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

  const banMutation = useMutation({
    mutationFn: async ({ pubkey, reason, deleteEvents, blockMedia }: {
      pubkey: string;
      reason: string;
      deleteEvents?: boolean;
      blockMedia?: boolean;
    }) => {
      const results = { banned: false, eventsDeleted: 0, mediaBlocked: 0 };

      // Ban the pubkey
      await banPubkey(pubkey, reason);
      results.banned = true;

      // Log the ban decision
      await logDecision({
        targetType: 'pubkey',
        targetId: pubkey,
        action: 'ban_user',
        reason,
        reportId: report?.id,
      });

      // Optionally delete all their events
      if (deleteEvents && context.userStats?.recentPosts) {
        for (const event of context.userStats.recentPosts) {
          try {
            await deleteEvent(event.id, `User banned: ${reason}`);
            await logDecision({
              targetType: 'event',
              targetId: event.id,
              action: 'delete_event',
              reason: `User banned: ${reason}`,
              reportId: report?.id,
            });
            results.eventsDeleted++;
          } catch {
            // Continue even if some fail
          }
        }
      }

      // Optionally block all their media
      if (blockMedia && context.userStats?.recentPosts) {
        const allHashes = new Set<string>();
        for (const event of context.userStats.recentPosts) {
          const hashes = extractMediaHashes(event.content, event.tags);
          hashes.forEach(h => allHashes.add(h));
        }
        for (const hash of allHashes) {
          try {
            await moderateMedia(hash, 'PERMANENT_BAN', `User banned: ${reason}`);
            await logDecision({
              targetType: 'media',
              targetId: hash,
              action: 'block_media',
              reason: `User banned: ${reason}`,
              reportId: report?.id,
            });
            results.mediaBlocked++;
          } catch {
            // Continue even if some fail
          }
        }
      }

      return results;
    },
    onSuccess: async (results, variables) => {
      queryClient.invalidateQueries({ queryKey: ['banned-users'] });
      queryClient.invalidateQueries({ queryKey: ['banned-pubkeys'] });
      queryClient.invalidateQueries({ queryKey: ['banned-events'] });
      queryClient.invalidateQueries({ queryKey: ['decisions'] });
      moderationStatus.refetch();
      decisionLog.refetch();

      let message = "User banned";
      if (results.eventsDeleted > 0) {
        message += `, ${results.eventsDeleted} event(s) deleted`;
      }
      if (results.mediaBlocked > 0) {
        message += `, ${results.mediaBlocked} media file(s) blocked`;
      }

      toast({ title: message, description: "Verifying..." });
      setConfirmBan(false);

      // Verify the ban worked
      setIsVerifying(true);
      setVerificationResult(null);
      try {
        const verified = await verifyPubkeyBanned(variables.pubkey);
        setVerificationResult({
          type: 'ban',
          success: verified,
          message: verified
            ? 'Ban verified - user is in banned list'
            : 'Warning: User may not be banned',
        });
        toast({
          title: verified ? "Ban Verified" : "Verification Warning",
          description: verified
            ? "User confirmed banned on relay"
            : "Could not confirm ban - check manually",
          variant: verified ? "default" : "destructive",
        });
      } catch {
        setVerificationResult({
          type: 'ban',
          success: false,
          message: 'Could not verify ban status',
        });
      } finally {
        setIsVerifying(false);
      }
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to ban user",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async ({ eventId, reason }: { eventId: string; reason: string }) => {
      await deleteEvent(eventId, reason);
      // Log the decision
      await logDecision({
        targetType: 'event',
        targetId: eventId,
        action: 'delete_event',
        reason,
        reportId: report?.id,
      });
      return eventId;
    },
    onSuccess: async (eventId) => {
      queryClient.invalidateQueries({ queryKey: ['reports'] });
      queryClient.invalidateQueries({ queryKey: ['banned-events'] });
      queryClient.invalidateQueries({ queryKey: ['decisions'] });
      moderationStatus.refetch();
      decisionLog.refetch();
      toast({ title: "Event deleted from relay", description: "Verifying..." });
      setConfirmDelete(false);

      // Verify the delete worked
      setIsVerifying(true);
      setVerificationResult(null);
      try {
        const isDeleted = await verifyEventDeleted(eventId);
        setVerificationResult({
          type: 'delete',
          success: isDeleted,
          message: isDeleted
            ? 'Delete verified - event removed from relay'
            : 'Warning: Event may still exist on relay',
        });
        toast({
          title: isDeleted ? "Delete Verified" : "Verification Warning",
          description: isDeleted
            ? "Event confirmed removed from relay"
            : "Could not confirm event removal - check manually",
          variant: isDeleted ? "default" : "destructive",
        });
      } catch {
        setVerificationResult({
          type: 'delete',
          success: false,
          message: 'Could not verify delete status',
        });
      } finally {
        setIsVerifying(false);
      }
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to delete event",
        description: error.message,
        variant: "destructive",
      });
    },
  });

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

  const blockMediaMutation = useMutation({
    mutationFn: async ({ hashes, action, reason }: { hashes: string[]; action: ModerationAction; reason: string }) => {
      // Block all media hashes found in the event
      const results = await Promise.all(
        hashes.map(sha256 => moderateMedia(sha256, action, reason))
      );
      // Log decisions for each hash
      await Promise.all(
        hashes.map(sha256 => logDecision({
          targetType: 'media',
          targetId: sha256,
          action: 'block_media',
          reason,
          reportId: report?.id,
        }))
      );
      return { results, hashes };
    },
    onSuccess: async ({ hashes }) => {
      queryClient.invalidateQueries({ queryKey: ['decisions'] });
      queryClient.invalidateQueries({ queryKey: ['media-status'] });
      decisionLog.refetch();
      toast({
        title: "Media blocked",
        description: `${hashes.length} media file(s) permanently banned. Verifying...`,
      });
      setConfirmBlockMedia(false);

      // Verify the media block worked
      setIsVerifying(true);
      setVerificationResult(null);
      try {
        // Verify each hash individually
        const verificationResults = await Promise.all(
          hashes.map(async (hash) => ({
            hash,
            blocked: await verifyMediaBlocked(hash),
          }))
        );
        const allBlocked = verificationResults.every(v => v.blocked);
        const failedCount = verificationResults.filter(v => !v.blocked).length;
        setVerificationResult({
          type: 'media',
          success: allBlocked,
          message: allBlocked
            ? 'Media block verified - all files blocked'
            : `Warning: ${failedCount} file(s) may not be blocked`,
        });
        toast({
          title: allBlocked ? "Block Verified" : "Verification Warning",
          description: allBlocked
            ? "All media confirmed blocked"
            : "Some media may not be blocked - check manually",
          variant: allBlocked ? "default" : "destructive",
        });
      } catch {
        setVerificationResult({
          type: 'media',
          success: false,
          message: 'Could not verify media block status',
        });
      } finally {
        setIsVerifying(false);
      }
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to block media",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  // Extract media hashes from the reported event AND reposted event if it's a repost
  const mediaHashes = useMemo(() => {
    const hashes = new Set<string>();

    // From the reported event itself
    if (context.thread?.event) {
      const eventHashes = extractMediaHashes(context.thread.event.content, context.thread.event.tags);
      eventHashes.forEach(h => hashes.add(h));
    }

    // From the reposted original event
    if (context.thread?.repostedEvent) {
      const repostHashes = extractMediaHashes(context.thread.repostedEvent.content, context.thread.repostedEvent.tags);
      repostHashes.forEach(h => hashes.add(h));
    }

    return Array.from(hashes);
  }, [context.thread?.event, context.thread?.repostedEvent]);

  // Check media status from moderation service
  const mediaStatus = useMediaStatus(mediaHashes);

  const unblockMediaMutation = useMutation({
    mutationFn: async ({ hashes, reason }: { hashes: string[]; reason: string }) => {
      // Unblock all media hashes
      const results = await Promise.all(
        hashes.map(sha256 => unblockMedia(sha256, reason))
      );
      // Log decisions for each hash
      await Promise.all(
        hashes.map(sha256 => logDecision({
          targetType: 'media',
          targetId: sha256,
          action: 'unblock_media',
          reason,
          reportId: report?.id,
        }))
      );
      return results;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['decisions'] });
      queryClient.invalidateQueries({ queryKey: ['media-status'] });
      mediaStatus.refetch();
      decisionLog.refetch();
      toast({
        title: "Media unblocked",
        description: `${variables.hashes.length} media file(s) unblocked`,
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to unblock media",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  // Combined action: Block media AND delete event
  const blockAndDeleteMutation = useMutation({
    mutationFn: async ({ eventId, hashes, reason }: { eventId: string; hashes: string[]; reason: string }) => {
      const results = { mediaBlocked: 0, eventDeleted: false };

      // First block all media
      for (const sha256 of hashes) {
        try {
          await moderateMedia(sha256, 'PERMANENT_BAN', reason);
          await logDecision({
            targetType: 'media',
            targetId: sha256,
            action: 'block_media',
            reason,
            reportId: report?.id,
          });
          results.mediaBlocked++;
        } catch {
          // Continue even if some fail
        }
      }

      // Then delete the event
      await deleteEvent(eventId, reason);
      await logDecision({
        targetType: 'event',
        targetId: eventId,
        action: 'delete_event',
        reason,
        reportId: report?.id,
      });
      results.eventDeleted = true;

      return results;
    },
    onSuccess: async (results, variables) => {
      queryClient.invalidateQueries({ queryKey: ['reports'] });
      queryClient.invalidateQueries({ queryKey: ['banned-events'] });
      queryClient.invalidateQueries({ queryKey: ['decisions'] });
      queryClient.invalidateQueries({ queryKey: ['media-status'] });
      moderationStatus.refetch();
      decisionLog.refetch();
      toast({
        title: "Content removed",
        description: `${results.mediaBlocked} media file(s) blocked and event deleted. Verifying...`,
      });
      setConfirmBlockAndDelete(false);

      // Verify the moderation action worked
      setIsVerifying(true);
      try {
        const verification = await verifyModerationAction(
          variables.eventId,
          variables.hashes
        );

        if (verification.allSuccessful) {
          toast({
            title: "Verified",
            description: "Event deleted and all media blocked successfully",
          });
        } else {
          const issues: string[] = [];
          if (!verification.eventDeleted) {
            issues.push("Event may still be accessible");
          }
          const failedMedia = verification.mediaBlocked.filter(m => !m.blocked);
          if (failedMedia.length > 0) {
            issues.push(`${failedMedia.length} media file(s) may not be blocked`);
          }
          toast({
            title: "Verification Warning",
            description: issues.join(". "),
            variant: "destructive",
          });
        }
      } catch (verifyError) {
        console.error('Verification failed:', verifyError);
        toast({
          title: "Verification unavailable",
          description: "Could not verify moderation action",
        });
      } finally {
        setIsVerifying(false);
      }
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to remove content",
        description: error.message,
        variant: "destructive",
      });
    },
  });

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

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Dialogs - rendered as portals, don't affect flex layout */}
      {/* Ban Confirmation Dialog */}
      <AlertDialog open={confirmBan} onOpenChange={setConfirmBan}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Ban User?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                <p>This will permanently ban this user from the relay.</p>
                {context.reportedUser.pubkey && (
                  <div className="bg-muted px-2 py-1.5 rounded">
                    <UserIdentifier
                      pubkey={context.reportedUser.pubkey}
                      showAvatar
                      avatarSize="sm"
                      variant="block"
                      linkToProfile
                    />
                  </div>
                )}

                <div className="space-y-2 pt-2">
                  <div className="flex items-center space-x-2">
                    <Checkbox
                      id="deleteEvents"
                      checked={banOptions.deleteEvents}
                      onCheckedChange={(checked) =>
                        setBanOptions(prev => ({ ...prev, deleteEvents: !!checked }))
                      }
                    />
                    <Label htmlFor="deleteEvents" className="text-sm font-normal">
                      Delete all events from this user ({context.userStats?.recentPosts?.length || 0} found)
                    </Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <Checkbox
                      id="blockMedia"
                      checked={banOptions.blockMedia}
                      onCheckedChange={(checked) =>
                        setBanOptions(prev => ({ ...prev, blockMedia: !!checked }))
                      }
                    />
                    <Label htmlFor="blockMedia" className="text-sm font-normal">
                      Block all media/videos from this user
                    </Label>
                  </div>
                </div>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={banMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (context.reportedUser.pubkey) {
                  banMutation.mutate({
                    pubkey: context.reportedUser.pubkey,
                    reason: `Report: ${categoryLabel}`,
                    deleteEvents: banOptions.deleteEvents,
                    blockMedia: banOptions.blockMedia,
                  });
                }
              }}
              disabled={banMutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {banMutation.isPending ? 'Banning...' : 'Ban User'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete Event Confirmation Dialog */}
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Event?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div>
                <p>This will remove this event from the relay. The content will no longer be served.</p>
                {context.target?.value && (
                  <div className="mt-2">
                    <CopyableId
                      value={context.target.value}
                      type="note"
                      truncateStart={16}
                      truncateEnd={8}
                      size="xs"
                    />
                  </div>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (context.target?.type === 'event' && context.target.value) {
                  deleteMutation.mutate({
                    eventId: context.target.value,
                    reason: `Report: ${categoryLabel}`,
                  });
                }
              }}
              disabled={deleteMutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteMutation.isPending ? 'Deleting...' : 'Delete Event'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Block Media Confirmation Dialog */}
      <AlertDialog open={confirmBlockMedia} onOpenChange={setConfirmBlockMedia}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Block Media?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div>
                <p>This will permanently ban {mediaHashes.length} media file(s) from being served.</p>
                <div className="mt-2 space-y-1">
                  {mediaHashes.map(hash => (
                    <CopyableId
                      key={hash}
                      value={hash}
                      type="hash"
                      truncateStart={16}
                      truncateEnd={8}
                      size="xs"
                    />
                  ))}
                </div>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={blockMediaMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                blockMediaMutation.mutate({
                  hashes: mediaHashes,
                  action: 'PERMANENT_BAN',
                  reason: `Report: ${categoryLabel}`,
                });
              }}
              disabled={blockMediaMutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {blockMediaMutation.isPending ? 'Blocking...' : 'Block Media'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Block Media AND Delete Event Combined Confirmation Dialog */}
      <AlertDialog open={confirmBlockAndDelete} onOpenChange={setConfirmBlockAndDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove Content?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>This will:</p>
                <ul className="list-disc list-inside space-y-1 text-sm">
                  <li>Permanently ban {mediaHashes.length} media file(s)</li>
                  <li>Delete the event from the relay</li>
                </ul>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={blockAndDeleteMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (context.target?.type === 'event' && context.target.value) {
                  blockAndDeleteMutation.mutate({
                    eventId: context.target.value,
                    hashes: mediaHashes,
                    reason: `Report: ${categoryLabel}`,
                  });
                }
              }}
              disabled={blockAndDeleteMutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {blockAndDeleteMutation.isPending ? 'Removing...' : 'Remove Content'}
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
      <ScrollArea className="flex-1 min-h-0">
        <div className="p-4 space-y-4 overflow-hidden">
          {/* Live Status Check - Verify current moderation state */}
          <Card className="border-blue-200 bg-blue-50/50 dark:bg-blue-950/20">
            <CardHeader className="py-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm flex items-center gap-2 text-blue-700 dark:text-blue-400">
                  <RefreshCw className={`h-4 w-4 ${liveStatus.isChecking ? 'animate-spin' : ''}`} />
                  Live Moderation Status
                </CardTitle>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={checkLiveStatus}
                  disabled={liveStatus.isChecking}
                  className="h-7 text-xs"
                >
                  {liveStatus.isChecking ? 'Checking...' : liveStatus.checkedAt ? 'Re-check' : 'Check Now'}
                </Button>
              </div>
            </CardHeader>
            <CardContent className="py-0 pb-3">
              {liveStatus.checkedAt ? (
                <div className="space-y-2">
                  {/* User ban status */}
                  {context.reportedUser.pubkey && (
                    <div className={`flex items-center gap-2 p-2 rounded ${
                      liveStatus.userBanned
                        ? 'bg-green-100 dark:bg-green-950/50'
                        : 'bg-yellow-100 dark:bg-yellow-950/50'
                    }`}>
                      {liveStatus.userBanned ? (
                        <>
                          <Ban className="h-4 w-4 text-green-600" />
                          <span className="text-sm font-medium text-green-700 dark:text-green-400">
                            User IS BANNED on relay
                          </span>
                        </>
                      ) : (
                        <>
                          <User className="h-4 w-4 text-yellow-600" />
                          <span className="text-sm font-medium text-yellow-700 dark:text-yellow-400">
                            User is NOT banned
                          </span>
                        </>
                      )}
                    </div>
                  )}
                  {/* Event deletion status */}
                  {context.target?.type === 'event' && (
                    <div className={`flex items-center gap-2 p-2 rounded ${
                      liveStatus.eventDeleted
                        ? 'bg-green-100 dark:bg-green-950/50'
                        : 'bg-yellow-100 dark:bg-yellow-950/50'
                    }`}>
                      {liveStatus.eventDeleted ? (
                        <>
                          <ShieldX className="h-4 w-4 text-green-600" />
                          <span className="text-sm font-medium text-green-700 dark:text-green-400">
                            Event IS DELETED from relay
                          </span>
                        </>
                      ) : (
                        <>
                          <FileText className="h-4 w-4 text-yellow-600" />
                          <span className="text-sm font-medium text-yellow-700 dark:text-yellow-400">
                            Event is still on relay
                          </span>
                        </>
                      )}
                    </div>
                  )}
                  <p className="text-xs text-muted-foreground">
                    Checked: {liveStatus.checkedAt.toLocaleTimeString()}
                  </p>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Click "Check Now" to verify current moderation status from the relay
                </p>
              )}
            </CardContent>
          </Card>

          {/* Verification Status - for just-completed actions */}
          {(isVerifying || verificationResult) && (
            <div
              className={`p-3 rounded-lg flex items-center gap-3 ${
                verificationResult?.success
                  ? "bg-green-100 dark:bg-green-950/50 border border-green-300 dark:border-green-800"
                  : "bg-red-100 dark:bg-red-950/50 border border-red-300 dark:border-red-800"
              }`}
            >
              {isVerifying ? (
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              ) : verificationResult?.success ? (
                <CheckCircle className="h-5 w-5 text-green-600" />
              ) : (
                <XCircle className="h-5 w-5 text-red-600" />
              )}
              <div className="flex-1">
                <p className={`text-sm font-medium ${verificationResult?.success ? "text-green-800 dark:text-green-300" : "text-red-800 dark:text-red-300"}`}>
                  {isVerifying
                    ? "Verifying moderation action..."
                    : verificationResult?.message}
                </p>
              </div>
              {verificationResult && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setVerificationResult(null)}
                  className="h-6 px-2"
                >
                  Dismiss
                </Button>
              )}
            </div>
          )}

          {/* Resolved Banner - prominently show when already handled */}
          {isResolved && (
            <div className="bg-green-100 dark:bg-green-950/50 border border-green-300 dark:border-green-800 rounded-lg p-3 flex items-center gap-3">
              <CheckCircle className="h-6 w-6 text-green-600" />
              <div className="flex-1">
                <p className="font-medium text-green-800 dark:text-green-300">
                  {isUserBanned ? 'User Already Banned' : isEventDeleted ? 'Event Already Deleted' : 'Already Reviewed'}
                </p>
                <p className="text-sm text-green-600 dark:text-green-400">
                  {decisionLog.latestDecision || pubkeyDecisionLog.latestDecision
                    ? `Last action: ${(decisionLog.latestDecision || pubkeyDecisionLog.latestDecision)?.action.replace(/_/g, ' ')} on ${new Date((decisionLog.latestDecision || pubkeyDecisionLog.latestDecision)?.created_at || '').toLocaleDateString()}`
                    : 'This target has been moderated'}
                </p>
              </div>
            </div>
          )}

          {/* Header */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 flex-wrap">
              <Badge variant="outline">{categoryLabel}</Badge>
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
                <Badge variant="destructive" className="flex items-center gap-1">
                  <ShieldX className="h-3 w-3" />
                  Event Deleted
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

          {/* Section: Reported Content */}
          <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Reported Content</h4>

          {/* Thread Context - the text content being reported */}
          {context.target?.type === 'event' && (
            <ThreadContext
              ancestors={context.thread?.ancestors || []}
              reportedEvent={context.thread?.event || null}
              onViewFullThread={() => setShowThreadModal(true)}
              isLoading={context.isLoading}
            />
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
                      showByDefault={true}
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
          {context.thread?.event && (
            <MediaPreview
              event={context.thread.event}
              showByDefault={true}
              maxItems={6}
            />
          )}

          {/* Reported User - who created the reported content */}
          <UserProfileCard
            profile={context.reportedUser.profile}
            pubkey={context.reportedUser.pubkey}
            stats={context.userStats}
            isLoading={context.isLoading}
          />

          <Separator />

          {/* Section: Investigation Helpers */}
          <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Investigation Helpers</h4>

          {/* Hive AI Content Moderation */}
          {context.thread?.event && (
            <HiveAIReport eventTags={context.thread.event.tags} />
          )}

          {/* AI Detection (Reality Defender multi-provider) */}
          {context.thread?.event && (
            <AIDetectionReport
              eventTags={context.thread.event.tags}
              eventId={context.thread.event.id}
            />
          )}

          {/* AI Summary */}
          <AISummary
            summary={summary.data?.summary}
            riskLevel={summary.data?.riskLevel}
            isLoading={summary.isLoading}
            error={summary.error as Error | null}
          />

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
              {context.thread?.event && context.thread.event.tags.length > 0 && (
                <div className="pt-2 border-t">
                  <span className="text-xs font-medium text-muted-foreground block mb-1">
                    Reported Event Tags
                  </span>
                  <CopyableTags tags={context.thread.event.tags} maxTags={8} />
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

          {/* Inline Label Form */}
          {showLabelForm && context.target && (
            <LabelPublisherInline
              targetType={context.target.type}
              targetValue={context.target.value}
              onSuccess={() => setShowLabelForm(false)}
              onCancel={() => setShowLabelForm(false)}
            />
          )}

        </div>
      </ScrollArea>

      {/* Action Buttons - fixed at bottom */}
      <div className="border-t bg-background p-4 space-y-3 shrink-0">
            {/* Resolution actions - dismiss or reopen */}
            <div className="flex flex-wrap gap-2">
              {(decisionLog.hasDecisions || pubkeyDecisionLog.hasDecisions) && !isUserBanned && !isEventDeleted ? (
                /* Show Reopen button if dismissed but not banned/deleted */
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
              ) : (
                /* Show Dismiss button if not yet resolved */
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="outline"
                      className="border-green-500 text-green-600 hover:bg-green-50"
                      onClick={() => reviewMutation.mutate({ status: 'reviewed', comment: 'Dismissed - no action needed' })}
                      disabled={reviewMutation.isPending || isResolved}
                    >
                      <CheckCircle className="h-4 w-4 mr-1" />
                      {reviewMutation.isPending ? 'Dismissing...' : 'Dismiss Report'}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="max-w-xs">
                    <p>Dismiss this report - no action needed. Content stays up, user is not banned. Use this when the report doesn't warrant action.</p>
                  </TooltipContent>
                </Tooltip>
              )}
            </div>

            {/* Primary enforcement action - combined when media present and not already blocked */}
            {context.target?.type === 'event' && mediaHashes.length > 0 && !isEventDeleted && !mediaStatus.hasBlockedMedia && (
              <div>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="destructive"
                      size="lg"
                      className="w-full"
                      onClick={() => setConfirmBlockAndDelete(true)}
                      disabled={blockAndDeleteMutation.isPending || mediaStatus.isLoading || isVerifying}
                    >
                      <Trash2 className="h-4 w-4 mr-2" />
                      {blockAndDeleteMutation.isPending ? 'Removing...' : isVerifying ? 'Verifying...' : mediaStatus.isLoading ? 'Checking media...' : `Block Media & Delete Event`}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="max-w-xs">
                    <p>Permanently block all media files (images/videos) AND delete the event from the relay. The media will be blocked by hash so re-uploads are prevented.</p>
                  </TooltipContent>
                </Tooltip>
              </div>
            )}

            {/* Secondary enforcement actions */}
            <div className="flex flex-wrap gap-2">
              {context.target?.type === 'event' && (
                isEventDeleted ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button variant="outline" disabled className="border-green-500 text-green-600">
                        <CheckCircle className="h-4 w-4 mr-1" />
                        Event Deleted
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="max-w-xs">
                      <p>This event has already been deleted from the relay.</p>
                    </TooltipContent>
                  </Tooltip>
                ) : (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="outline"
                        onClick={() => setConfirmDelete(true)}
                        disabled={deleteMutation.isPending}
                      >
                        <Trash2 className="h-4 w-4 mr-1" />
                        Delete Event
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="max-w-xs">
                      <p>Delete this event from the relay. The event will no longer be served, but the user can still post new content.</p>
                    </TooltipContent>
                  </Tooltip>
                )
              )}
              {mediaHashes.length > 0 && (
                mediaStatus.hasBlockedMedia ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="outline"
                        className="border-green-500 text-green-600 hover:bg-green-50"
                        onClick={() => {
                          const blockedHashes = mediaStatus.results
                            .filter(r => r.isBlocked)
                            .map(r => r.hash);
                          unblockMediaMutation.mutate({
                            hashes: blockedHashes,
                            reason: 'Unblocked by moderator',
                          });
                        }}
                        disabled={unblockMediaMutation.isPending || mediaStatus.isLoading}
                      >
                        <Unlock className="h-4 w-4 mr-1" />
                        {unblockMediaMutation.isPending ? 'Unblocking...' : `Unblock Media (${mediaStatus.blockedCount})`}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="max-w-xs">
                      <p>Unblock previously blocked media files. They will be allowed to be served again.</p>
                    </TooltipContent>
                  </Tooltip>
                ) : (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="outline"
                        onClick={() => setConfirmBlockMedia(true)}
                        disabled={blockMediaMutation.isPending || mediaStatus.isLoading}
                      >
                        <Video className="h-4 w-4 mr-1" />
                        {mediaStatus.isLoading ? 'Checking...' : `Block Media (${mediaHashes.length})`}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="max-w-xs">
                      <p>Permanently block media files by their hash. They won't be served and re-uploads of the same file will be blocked.</p>
                    </TooltipContent>
                  </Tooltip>
                )
              )}
              {context.reportedUser.pubkey && (
                isUserBanned ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button variant="outline" disabled className="border-green-500 text-green-600">
                        <CheckCircle className="h-4 w-4 mr-1" />
                        User Banned
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="max-w-xs">
                      <p>This user has already been banned from the relay.</p>
                    </TooltipContent>
                  </Tooltip>
                ) : (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="destructive"
                        onClick={() => setConfirmBan(true)}
                        disabled={banMutation.isPending}
                      >
                        <UserX className="h-4 w-4 mr-1" />
                        Ban User
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="max-w-xs">
                      <p>Permanently ban this user from the relay. They won't be able to post new content. Optionally delete all their events and block their media.</p>
                    </TooltipContent>
                  </Tooltip>
                )
              )}
              {context.target && !showLabelForm && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="outline"
                      onClick={() => setShowLabelForm(true)}
                    >
                      <Tag className="h-4 w-4 mr-1" />
                      Create Label
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="max-w-xs">
                    <p>Create a custom NIP-32 label for this content. Labels can be used for categorization without taking enforcement action.</p>
                  </TooltipContent>
                </Tooltip>
              )}
            </div>
        </div>
    </div>
  );
}
