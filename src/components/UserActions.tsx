import { useMutation } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useToast } from '@/hooks/useToast';
import { useAdminApi } from '@/hooks/useAdminApi';
import { useBulkModerateJob } from '@/hooks/useBulkModerateJob';
import { ConfirmDialog } from './ConfirmDialog';
import { UserX, UserCheck, ShieldAlert, Trash2, Pause, Play } from 'lucide-react';

interface UserActionsProps {
  pubkey: string;
  context?: 'report' | 'age-review' | 'users';
  isBanned?: boolean;
  isSuspended?: boolean;
  onActionComplete?: () => void;
}

export function UserActions({
  pubkey,
  context = 'users',
  isBanned = false,
  isSuspended = false,
  onActionComplete,
}: UserActionsProps) {
  const { toast } = useToast();
  const api = useAdminApi();
  const showBulkActions = context !== 'age-review';

  const suspendUserMutation = useMutation({
    mutationFn: async () => {
      await api.suspendPubkey(pubkey, 'Suspended by moderator');
      await api.logDecision({
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
      toast({ title: 'Failed to suspend user', description: error.message, variant: 'destructive' });
    },
  });

  const unsuspendUserMutation = useMutation({
    mutationFn: async () => {
      await api.unsuspendPubkey(pubkey);
      await api.logDecision({
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
      toast({ title: 'Failed to unsuspend user', description: error.message, variant: 'destructive' });
    },
  });

  const banUserMutation = useMutation({
    mutationFn: async () => {
      await api.banPubkey(pubkey, 'Banned by moderator');
      await api.logDecision({
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
      await api.unbanPubkey(pubkey);
      await api.logDecision({
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
        toast({
          title: `Bulk ${job.action === 'delete-all' ? 'delete' : 'age-restrict'} finished with issues`,
          description: job.failures.slice(0, 3).join('; ') || 'The job did not complete cleanly.',
          variant: 'destructive',
        });
      } else {
        const verb = job.action === 'delete-all' ? 'Deleted' : 'Age-restricted';
        toast({ title: `${verb} ${job.mediaProcessed} media file(s) across ${job.eventsProcessed} events` });
      }
      // Non-critical audit log; never block the action.
      void api.logDecision({
        targetType: 'pubkey',
        targetId: pubkey,
        action: job.action === 'delete-all' ? 'bulk_delete' : 'bulk_age_restrict',
        reason: `Bulk ${job.action}: ${job.mediaProcessed} media file(s)`,
      }).catch((e) => console.warn('[UserActions] bulk audit log failed', e));
      onActionComplete?.();
    },
    onError: (error) => {
      toast({ title: 'Failed to start bulk action', description: error.message, variant: 'destructive' });
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
          {isSuspended ? (
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
            summary="Permanently ban this user and purge all their content from the relay. This destroys events across 16+ tables and cannot be fully reversed — unbanning allows new posts but does not restore purged content."
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
                onClick={() => bulkJob.start('age-restrict-all')} disabled={anyPending}>
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
            onConfirm={async () => { await bulkJob.startAsync('delete-all'); }}
            isPending={bulkJob.runningAction === 'delete-all'}
          />
        </>
      )}
    </div>
  );
}
