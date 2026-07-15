import { useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useToast } from '@/hooks/useToast';
import { useAdminApi } from '@/hooks/useAdminApi';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { ApiError } from '@/lib/adminApi';
import { UNDERAGE_REPORT_CATEGORY } from '@/lib/constants';
import { useBulkModerateJob } from '@/hooks/useBulkModerateJob';
import { ConfirmDialog } from './ConfirmDialog';
import { useNavigate } from 'react-router-dom';
import { UserX, UserCheck, ShieldAlert, Trash2, Pause, Play, ArrowRight } from 'lucide-react';

interface UserActionsProps {
  pubkey: string;
  context?: 'report' | 'age-review' | 'users';
  reportCategory?: string;
  isBanned?: boolean;
  isSuspended?: boolean;
  onActionComplete?: () => void;
}

export function UserActions({
  pubkey,
  context = 'users',
  reportCategory,
  isBanned = false,
  isSuspended = false,
  onActionComplete,
}: UserActionsProps) {
  const { toast } = useToast();
  const api = useAdminApi();
  const { getModeratorPubkey } = useCurrentUser();
  const queryClient = useQueryClient();
  // Snapshot of the moderator at bulk-job start; a logout/switch during the long
  // job must not retarget its completion audit write (#178).
  const bulkModeratorRef = useRef<Promise<string | undefined>>();
  const navigate = useNavigate();

  // An under-16 report must be worked through the Age Review flow, not the
  // generic Suspend/Unsuspend (which would enforce without advancing the case).
  // Exact category only: CSAM/child-safety are a separate, non-reversible path.
  const isUnderageReport = context === 'report' && reportCategory === UNDERAGE_REPORT_CATEGORY;

  // Bulk content actions are hidden in the age-review context (the case screen
  // has its own enforcement controls) and for an underage report (content
  // enforcement runs through the case; the /api/bulk-moderate guard refuses it
  // on an open case regardless). Ban stays as the severe-action escape hatch.
  const showBulkActions = context !== 'age-review' && !isUnderageReport;

  // The worker guard refuses a bare suspend/unsuspend on an account under age
  // review (any context). Route the moderator to the case instead of surfacing
  // a raw error, so enforcement can't drift from the case out of band.
  const routeToAgeReviewIfGuarded = (error: Error): boolean => {
    if (error instanceof ApiError && error.code === 'age_review_active') {
      toast({ title: 'This account is under age review', description: 'Opening it in the Age Review flow.' });
      navigate(`/age-review?pubkey=${encodeURIComponent(pubkey)}`);
      return true;
    }
    return false;
  };

  // Whether this account has an open age-review case, which changes the Ban
  // copy (a ban purges content the review may still need). For an underage
  // report we already know one exists; otherwise look it up. Skipped once
  // banned (no Ban button) and in the age-review context (already on the case).
  // If the lookup errors we read only `data`, so hasActiveAgeCase stays false
  // and the ban falls back to the generic copy — a non-critical enrichment that
  // degrades quietly rather than blocking the action.
  const { data: activeAgeCase } = useQuery({
    queryKey: ['age-review-active-case', pubkey],
    queryFn: () => api.getActiveAgeReviewCase(pubkey),
    enabled: !isBanned && !isUnderageReport && context !== 'age-review',
    staleTime: 30_000,
  });
  const hasActiveAgeCase = isUnderageReport || !!activeAgeCase?.case;

  // Audit logging is a non-critical side effect. Fire-and-forget so a slow or
  // hung /api/decisions write can never stall the moderation action or leave the
  // confirm dialog stuck on "Banning…". The relay action is the source of truth;
  // on failure we surface a non-blocking toast so the moderator knows the decision
  // log lagged, without blocking the action or the dialog close.
  //
  // When the write SUCCEEDS, re-invalidate the decision log. Suspend and bulk
  // age-restrict derive resolved-state ONLY from the D1 decision row (unlike
  // ban/delete, which read live relay state), and onActionComplete refetches
  // decisions synchronously in onSuccess — racing this detached write. Without a
  // post-write invalidation the report reads back before the row exists and stays
  // "pending" until a manual refresh. The ['decisions'] prefix covers
  // useDecisionLog's ['decisions', targetId]. A report legitimately stays
  // unresolved when no row was written (the .catch path), which is correct.
  // Detached audit write. `moderator` is captured by the caller BEFORE the
  // authoritative request (so a logout/switch mid-request can't retarget it) and
  // reused across the action. Waits for the in-flight identity, attributes or
  // falls back to null, and never blocks the action.
  const logAudit = (
    moderator: Promise<string | undefined>,
    params: Parameters<typeof api.logDecision>[0],
  ) =>
    void moderator.then((moderatorPubkey) =>
      api.logDecision({ ...params, moderatorPubkey })
      .then(() => {
        queryClient.invalidateQueries({ queryKey: ['decisions'] });
      })
      .catch((e) => {
        console.warn('[UserActions] audit log failed', e);
        toast({ title: 'Action applied; audit log not recorded' });
      }));

  const suspendUserMutation = useMutation({
    mutationFn: async () => {
      const moderator = getModeratorPubkey(); // capture before the authoritative request
      await api.suspendPubkey(pubkey, 'Suspended by moderator');
      logAudit(moderator, {
        targetType: 'pubkey',
        targetId: pubkey,
        action: 'suspend_user',
        reason: 'Suspended by moderator',
      });
    },
    onSuccess: () => {
      toast({ title: 'User suspended' });
      onActionComplete?.();
    },
    onError: (error: Error) => {
      if (routeToAgeReviewIfGuarded(error)) return;
      toast({ title: 'Failed to suspend user', description: error.message, variant: 'destructive' });
    },
  });

  const unsuspendUserMutation = useMutation({
    mutationFn: async () => {
      const moderator = getModeratorPubkey(); // capture before the authoritative request
      await api.unsuspendPubkey(pubkey);
      logAudit(moderator, {
        targetType: 'pubkey',
        targetId: pubkey,
        action: 'unsuspend_user',
        reason: 'Unsuspended by moderator',
      });
    },
    onSuccess: () => {
      toast({ title: 'User unsuspended' });
      onActionComplete?.();
    },
    onError: (error: Error) => {
      if (routeToAgeReviewIfGuarded(error)) return;
      toast({ title: 'Failed to unsuspend user', description: error.message, variant: 'destructive' });
    },
  });

  const banUserMutation = useMutation({
    mutationFn: async () => {
      const moderator = getModeratorPubkey(); // capture before the authoritative request
      await api.banPubkey(pubkey, 'Banned by moderator');
      logAudit(moderator, {
        targetType: 'pubkey',
        targetId: pubkey,
        action: 'ban_user',
        reason: 'Banned by moderator',
      });
    },
    onSuccess: () => {
      toast({ title: 'User banned from relay' });
      onActionComplete?.();
    },
    onError: (error: Error) => {
      toast({ title: 'Failed to ban user', description: error.message, variant: 'destructive' });
    },
  });

  const unbanUserMutation = useMutation({
    mutationFn: async () => {
      const moderator = getModeratorPubkey(); // capture before the authoritative request
      await api.unbanPubkey(pubkey);
      logAudit(moderator, {
        targetType: 'pubkey',
        targetId: pubkey,
        action: 'unban_user',
        reason: 'Unbanned by moderator',
      });
    },
    onSuccess: () => {
      toast({ title: 'User unbanned' });
      onActionComplete?.();
    },
    onError: (error: Error) => {
      toast({ title: 'Failed to unban user', description: error.message, variant: 'destructive' });
    },
  });

  // Bulk actions are async jobs: enqueue returns a jobId immediately, then the
  // hook polls until the queue consumer finishes and reports the outcome.
  const bulkJob = useBulkModerateJob({
    pubkey,
    onComplete: (job) => {
      const partial = job.status === 'failed' || job.failures.length > 0;
      if (partial) {
        const counts = `${job.mediaProcessed} media across ${job.eventsProcessed} events`;
        const detail = job.failures.length
          ? `${counts}; ${job.failures.length} issue(s): ${job.failures.slice(0, 3).join('; ')}`
          : `${counts}. The job did not complete cleanly.`;
        toast({
          title: `Bulk ${job.action === 'delete-all' ? 'delete' : 'age-restrict'} finished with issues`,
          description: detail,
          variant: 'destructive',
        });
      } else {
        const verb = job.action === 'delete-all' ? 'Deleted' : 'Age-restricted';
        toast({ title: `${verb} ${job.mediaProcessed} media file(s) across ${job.eventsProcessed} events` });
      }
      // Non-critical audit log; never block the action. Attribute to the
      // moderator snapshotted at job START (not now), so a mid-job logout/switch
      // can't retarget it.
      void (bulkModeratorRef.current ?? Promise.resolve(undefined))
        .then((moderatorPubkey) =>
          api.logDecision({
            targetType: 'pubkey',
            targetId: pubkey,
            action: job.action === 'delete-all' ? 'bulk_delete' : 'bulk_age_restrict',
            reason: `Bulk ${job.action}: ${job.mediaProcessed} media file(s)`,
            moderatorPubkey,
          }))
        .catch((e) => console.warn('[UserActions] bulk audit log failed', e));
      onActionComplete?.();
    },
    onError: (error) => {
      // A guard-refused enqueue (open age-review case) routes to the case, for
      // the contexts where the buttons still render (Users tab, non-underage
      // report on an account that also has an open case).
      if (routeToAgeReviewIfGuarded(error)) return;
      // Covers both enqueue failure and a persistent status-poll failure
      // (the job may have started; error.message carries the specific reason).
      toast({ title: 'Bulk action failed', description: error.message, variant: 'destructive' });
    },
  });

  const anyPending = suspendUserMutation.isPending || unsuspendUserMutation.isPending ||
    banUserMutation.isPending || unbanUserMutation.isPending || bulkJob.isRunning;

  return (
    <div className="flex flex-wrap gap-2">
      {isBanned ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="outline" onClick={() => unbanUserMutation.mutate()} disabled={anyPending}>
              <UserCheck className="h-4 w-4 mr-1" />
              {unbanUserMutation.isPending ? 'Unbanning...' : 'Unban User'}
            </Button>
          </TooltipTrigger>
          <TooltipContent><p>Unban this user. They can post new content, but previously purged content is not restored.</p></TooltipContent>
        </Tooltip>
      ) : (
        <>
          {isUnderageReport ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="outline" className="border-blue-500 text-blue-600 hover:bg-blue-50"
                  onClick={() => navigate(`/age-review?pubkey=${encodeURIComponent(pubkey)}`)} disabled={anyPending}>
                  <ArrowRight className="h-4 w-4 mr-1" />
                  Handle in Age Review
                </Button>
              </TooltipTrigger>
              <TooltipContent><p>This account was reported as under 16. Account and content enforcement run through the Age Review flow so the case, content age-restriction, and deadline stay in sync.</p></TooltipContent>
            </Tooltip>
          ) : isSuspended ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="outline" className="border-green-500 text-green-600 hover:bg-green-50"
                  onClick={() => unsuspendUserMutation.mutate()} disabled={anyPending}>
                  <Play className="h-4 w-4 mr-1" />
                  {unsuspendUserMutation.isPending ? 'Unsuspending...' : 'Unsuspend User'}
                </Button>
              </TooltipTrigger>
              <TooltipContent><p>Unsuspend this user. Their content will be visible again.</p></TooltipContent>
            </Tooltip>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="outline" className="border-amber-500 text-amber-600 hover:bg-amber-50"
                  onClick={() => suspendUserMutation.mutate()} disabled={anyPending}>
                  <Pause className="h-4 w-4 mr-1" />
                  {suspendUserMutation.isPending ? 'Suspending...' : 'Suspend User'}
                </Button>
              </TooltipTrigger>
              <TooltipContent><p>Suspend this user. Hides their content without deleting it. Can be reversed.</p></TooltipContent>
            </Tooltip>
          )}

          <ConfirmDialog
            trigger={
              <Button variant="destructive" disabled={anyPending}>
                <UserX className="h-4 w-4 mr-1" />
                Ban User
              </Button>
            }
            title="Ban User"
            summary={hasActiveAgeCase
              ? "This account is under age review. Banning purges all their content across 16+ tables and cannot be fully reversed, which destroys evidence the review may need. Resolve through the Age Review flow unless this is a separate severe violation (e.g. CSAM) that requires an immediate ban."
              : "Permanently ban this user and purge all their content from the relay. This destroys events across 16+ tables and cannot be fully reversed — unbanning allows new posts but does not restore purged content."}
            confirmLabel="Ban User"
            pendingLabel="Banning..."
            onConfirm={async () => { await banUserMutation.mutateAsync(); }}
            isPending={banUserMutation.isPending}
          />
        </>
      )}

      {showBulkActions && (
        <>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="outline" className="border-orange-500 text-orange-600 hover:bg-orange-50"
                onClick={() => { bulkModeratorRef.current = getModeratorPubkey(); bulkJob.start('age-restrict-all'); }} disabled={anyPending}>
                <ShieldAlert className="h-4 w-4 mr-1" />
                {bulkJob.runningAction === 'age-restrict-all' ? 'Restricting...' : 'Age Restrict All'}
              </Button>
            </TooltipTrigger>
            <TooltipContent><p>Age-restrict all media from this user. Can be reversed.</p></TooltipContent>
          </Tooltip>

          <ConfirmDialog
            trigger={
              <Button variant="destructive" disabled={anyPending}>
                <Trash2 className="h-4 w-4 mr-1" />
                {bulkJob.runningAction === 'delete-all' ? 'Deleting...' : 'Delete All Content'}
              </Button>
            }
            title="Delete All Content"
            summary="This will permanently delete all events and media from this user. This cannot be undone."
            confirmLabel="Confirm Delete"
            pendingLabel="Starting..."
            onConfirm={async () => { bulkModeratorRef.current = getModeratorPubkey(); await bulkJob.startAsync('delete-all'); }}
            isPending={bulkJob.runningAction === 'delete-all'}
          />
        </>
      )}
    </div>
  );
}
