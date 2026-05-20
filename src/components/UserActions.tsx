import { useMutation } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useToast } from '@/hooks/useToast';
import { useAdminApi } from '@/hooks/useAdminApi';
import { DeleteConfirmDialog } from './DeleteConfirmDialog';
import { UserX, UserCheck, ShieldAlert, Trash2 } from 'lucide-react';

interface UserActionsProps {
  pubkey: string;
  context?: 'report' | 'age-review' | 'users';
  isBanned?: boolean;
  onActionComplete?: () => void;
}

export function UserActions({
  pubkey,
  context = 'users',
  isBanned = false,
  onActionComplete,
}: UserActionsProps) {
  const { toast } = useToast();
  const api = useAdminApi();
  const showBulkActions = context !== 'age-review';

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

  const bulkAgeRestrictMutation = useMutation({
    mutationFn: async () => {
      const result = await api.bulkModerate(pubkey, 'age-restrict-all', 'Bulk age-restricted by moderator');
      await api.logDecision({
        targetType: 'pubkey',
        targetId: pubkey,
        action: 'bulk_age_restrict',
        reason: `Bulk age-restricted: ${result.mediaProcessed} media file(s)`,
      });
      return result;
    },
    onSuccess: (result) => {
      toast({ title: `Age-restricted ${result.mediaProcessed} media file(s) across ${result.eventsProcessed} events` });
      onActionComplete?.();
    },
    onError: (error: Error) => {
      toast({ title: 'Failed to bulk age-restrict', description: error.message, variant: 'destructive' });
    },
  });

  const bulkDeleteMutation = useMutation({
    mutationFn: async () => {
      const result = await api.bulkModerate(pubkey, 'delete-all', 'Bulk deleted by moderator');
      await api.logDecision({
        targetType: 'pubkey',
        targetId: pubkey,
        action: 'bulk_delete',
        reason: `Bulk deleted: ${result.mediaProcessed} media file(s)`,
      });
      return result;
    },
    onSuccess: (result) => {
      toast({ title: `Deleted ${result.mediaProcessed} media file(s) across ${result.eventsProcessed} events` });
      onActionComplete?.();
    },
    onError: (error: Error) => {
      toast({ title: 'Failed to bulk delete', description: error.message, variant: 'destructive' });
    },
  });

  const anyPending = banUserMutation.isPending || unbanUserMutation.isPending ||
    bulkAgeRestrictMutation.isPending || bulkDeleteMutation.isPending;

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
          <TooltipContent><p>Unban this user. They will be able to post again.</p></TooltipContent>
        </Tooltip>
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="destructive" onClick={() => banUserMutation.mutate()} disabled={anyPending}>
              <UserX className="h-4 w-4 mr-1" />
              {banUserMutation.isPending ? 'Banning...' : 'Ban User'}
            </Button>
          </TooltipTrigger>
          <TooltipContent><p>Ban this user from the relay. Can be reversed.</p></TooltipContent>
        </Tooltip>
      )}

      {showBulkActions && (
        <>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="outline" className="border-orange-500 text-orange-600 hover:bg-orange-50"
                onClick={() => bulkAgeRestrictMutation.mutate()} disabled={anyPending}>
                <ShieldAlert className="h-4 w-4 mr-1" />
                {bulkAgeRestrictMutation.isPending ? 'Restricting...' : 'Age Restrict All'}
              </Button>
            </TooltipTrigger>
            <TooltipContent><p>Age-restrict all media from this user. Can be reversed.</p></TooltipContent>
          </Tooltip>

          <DeleteConfirmDialog
            trigger={
              <Button variant="destructive" disabled={anyPending}>
                <Trash2 className="h-4 w-4 mr-1" />
                Delete All Content
              </Button>
            }
            title="Delete All Content"
            summary="This will permanently delete all media files from this user. This cannot be undone."
            onConfirm={() => bulkDeleteMutation.mutateAsync()}
            isPending={bulkDeleteMutation.isPending}
          />
        </>
      )}
    </div>
  );
}
