import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useToast } from '@/hooks/useToast';
import { useAdminApi } from '@/hooks/useAdminApi';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { DeleteConfirmDialog } from './DeleteConfirmDialog';
import { ShieldX, Undo2, Video, ShieldAlert, Unlock, Trash2 } from 'lucide-react';

export interface MediaHashStatus {
  hash: string;
  isBlocked: boolean;
  isRestricted: boolean;
}

interface EventActionsProps {
  eventId: string;
  pubkey: string;
  mediaHashes?: string[];
  mediaHashStatuses?: MediaHashStatus[];
  isEventBanned?: boolean;
  hasBlockedMedia?: boolean;
  hasRestrictedMedia?: boolean;
  onActionComplete?: () => void;
}

export function EventActions({
  eventId,
  pubkey,
  mediaHashes = [],
  mediaHashStatuses = [],
  isEventBanned = false,
  hasBlockedMedia = false,
  hasRestrictedMedia = false,
  onActionComplete,
}: EventActionsProps) {
  const { toast } = useToast();
  const api = useAdminApi();
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();
  const hasMedia = mediaHashes.length > 0;

  // Audit logging is a non-critical side effect. Fire-and-forget so a slow, hung,
  // or failing /api/decisions write can never make a relay/media action that already
  // SUCCEEDED report failure (or leave a confirm dialog stuck open). The relay/media
  // action is the source of truth. On a successful write, re-invalidate the decision
  // log so the report converges without a manual refresh; on failure, surface a
  // non-blocking toast. Mirrors UserActions.logAudit.
  const logAudit = (params: Parameters<typeof api.logDecision>[0]) =>
    void api.logDecision({ moderatorPubkey: user?.pubkey, ...params })
      .then(() => { queryClient.invalidateQueries({ queryKey: ['decisions'] }); })
      .catch((e) => {
        console.warn('[EventActions] audit log failed', e);
        toast({ title: 'Action applied; audit log not recorded' });
      });

  const banEventMutation = useMutation({
    mutationFn: async () => {
      await api.banEvent(eventId, 'Banned by moderator');
      logAudit({
        targetType: 'event',
        targetId: eventId,
        action: 'ban_event',
        reason: 'Banned by moderator',
      });
    },
    onSuccess: () => {
      toast({ title: 'Event banned from relay' });
      onActionComplete?.();
    },
    onError: (error: Error) => {
      toast({ title: 'Failed to ban event', description: error.message, variant: 'destructive' });
    },
  });

  const restoreEventMutation = useMutation({
    mutationFn: async () => {
      await api.allowEvent(eventId);
      logAudit({
        targetType: 'event',
        targetId: eventId,
        action: 'restore_event',
        reason: 'Restored by moderator',
      });
    },
    onSuccess: () => {
      toast({ title: 'Event restored' });
      onActionComplete?.();
    },
    onError: (error: Error) => {
      toast({ title: 'Failed to restore event', description: error.message, variant: 'destructive' });
    },
  });

  const deleteEventMutation = useMutation({
    mutationFn: async () => {
      await api.deleteEvent(eventId, 'Permanently deleted by moderator', pubkey);
      logAudit({
        targetType: 'event',
        targetId: eventId,
        action: 'delete_event_permanent',
        reason: 'Permanently deleted (banevent)',
      });
    },
    onSuccess: () => {
      toast({ title: 'Event permanently deleted', description: 'Banned from relay' });
      onActionComplete?.();
    },
    onError: (error: Error) => {
      toast({ title: 'Failed to delete event', description: error.message, variant: 'destructive' });
    },
  });

  const blockMediaMutation = useMutation({
    mutationFn: async () => {
      for (const hash of mediaHashes) {
        await api.moderateMedia(hash, 'PERMANENT_BAN', 'Blocked by moderator');
      }
      logAudit({
        targetType: 'event',
        targetId: eventId,
        action: 'block_media',
        reason: `Blocked ${mediaHashes.length} media file(s)`,
      });
    },
    onSuccess: () => {
      toast({ title: `Blocked ${mediaHashes.length} media file(s)` });
      onActionComplete?.();
    },
    onError: (error: Error) => {
      toast({ title: 'Failed to block media', description: error.message, variant: 'destructive' });
    },
  });

  const ageRestrictMutation = useMutation({
    mutationFn: async () => {
      for (const hash of mediaHashes) {
        await api.moderateMedia(hash, 'AGE_RESTRICTED', 'Age restricted by moderator');
      }
      logAudit({
        targetType: 'event',
        targetId: eventId,
        action: 'age_restrict_media',
        reason: `Age restricted ${mediaHashes.length} media file(s)`,
      });
    },
    onSuccess: () => {
      toast({ title: `Age restricted ${mediaHashes.length} media file(s)` });
      onActionComplete?.();
    },
    onError: (error: Error) => {
      toast({ title: 'Failed to age restrict', description: error.message, variant: 'destructive' });
    },
  });

  const unblockMediaMutation = useMutation({
    mutationFn: async () => {
      const blockedHashes = mediaHashStatuses.filter(s => s.isBlocked).map(s => s.hash);
      if (blockedHashes.length === 0) return;
      for (const hash of blockedHashes) {
        await api.moderateMedia(hash, 'SAFE', 'Unblocked by moderator');
      }
      logAudit({
        targetType: 'event',
        targetId: eventId,
        action: 'unblock_media',
        reason: `Unblocked ${blockedHashes.length} media file(s)`,
      });
    },
    onSuccess: () => {
      toast({ title: 'Media unblocked' });
      onActionComplete?.();
    },
    onError: (error: Error) => {
      toast({ title: 'Failed to unblock media', description: error.message, variant: 'destructive' });
    },
  });

  const removeRestrictionMutation = useMutation({
    mutationFn: async () => {
      const restrictedHashes = mediaHashStatuses.filter(s => s.isRestricted).map(s => s.hash);
      if (restrictedHashes.length === 0) return;
      for (const hash of restrictedHashes) {
        await api.moderateMedia(hash, 'SAFE', 'Restriction removed by moderator');
      }
      logAudit({
        targetType: 'event',
        targetId: eventId,
        action: 'remove_restriction',
        reason: `Removed restriction from ${restrictedHashes.length} media file(s)`,
      });
    },
    onSuccess: () => {
      toast({ title: 'Restriction removed' });
      onActionComplete?.();
    },
    onError: (error: Error) => {
      toast({ title: 'Failed to remove restriction', description: error.message, variant: 'destructive' });
    },
  });

  const deleteMediaMutation = useMutation({
    mutationFn: async () => {
      for (const hash of mediaHashes) {
        await api.deleteMedia(hash, 'Permanently deleted by moderator');
      }
      logAudit({
        targetType: 'event',
        targetId: eventId,
        action: 'delete_media',
        reason: `Deleted ${mediaHashes.length} media file(s)`,
      });
    },
    onSuccess: () => {
      toast({ title: `Deleted ${mediaHashes.length} media file(s)` });
      onActionComplete?.();
    },
    onError: (error: Error) => {
      toast({ title: 'Failed to delete media', description: error.message, variant: 'destructive' });
    },
  });

  const deleteEventAndMediaMutation = useMutation({
    mutationFn: async () => {
      const completed: string[] = [];
      try {
        await api.deleteEvent(eventId, 'Permanently deleted by moderator', pubkey);
        completed.push('event_deleted');
        logAudit({ targetType: 'event', targetId: eventId, action: 'delete_event', reason: 'Permanently deleted (combined)' });

        for (const hash of mediaHashes) {
          await api.deleteMedia(hash, 'Permanently deleted by moderator');
          completed.push(`media_${hash.slice(0, 8)}`);
        }
        logAudit({ targetType: 'event', targetId: eventId, action: 'delete_event_and_media', reason: `Permanently deleted event + ${mediaHashes.length} media file(s)` });
      } catch (error) {
        // Reached only when a real action (deleteEvent or a deleteMedia) failed —
        // not the audit log, which is now fire-and-forget. So "media deletion failed"
        // in onError is accurate.
        if (completed.length > 0) {
          logAudit({ targetType: 'event', targetId: eventId, action: 'delete_event_and_media_partial', reason: `Partial delete (completed: ${completed.join(', ')}). Error: ${error instanceof Error ? error.message : 'unknown'}` });
        }
        throw Object.assign(error instanceof Error ? error : new Error('Unknown error'), { completed });
      }
    },
    onSuccess: () => {
      toast({ title: 'Event and media permanently deleted' });
      onActionComplete?.();
    },
    onError: (error: Error & { completed?: string[] }) => {
      const completed = error.completed ?? [];
      if (completed.length > 0) {
        toast({
          title: 'Partially completed',
          description: `Event was deleted but media deletion failed: ${error.message}. Check audit log for details.`,
          variant: 'destructive',
        });
        onActionComplete?.();
      } else {
        toast({ title: 'Failed to delete', description: error.message, variant: 'destructive' });
      }
    },
  });

  const anyPending = banEventMutation.isPending || restoreEventMutation.isPending ||
    deleteEventMutation.isPending || blockMediaMutation.isPending || ageRestrictMutation.isPending ||
    unblockMediaMutation.isPending || removeRestrictionMutation.isPending ||
    deleteMediaMutation.isPending || deleteEventAndMediaMutation.isPending;

  return (
    <div className="flex flex-wrap gap-2">
      {/* Ban / Restore Event (reversible) */}
      {isEventBanned ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="outline" onClick={() => restoreEventMutation.mutate()} disabled={anyPending}>
              <Undo2 className="h-4 w-4 mr-1" />
              {restoreEventMutation.isPending ? 'Restoring...' : 'Restore Event'}
            </Button>
          </TooltipTrigger>
          <TooltipContent><p>Restore this event to the relay. Reverses the ban.</p></TooltipContent>
        </Tooltip>
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="outline" onClick={() => banEventMutation.mutate()} disabled={anyPending}>
              <ShieldX className="h-4 w-4 mr-1" />
              {banEventMutation.isPending ? 'Banning...' : 'Ban Event'}
            </Button>
          </TooltipTrigger>
          <TooltipContent><p>Ban this event from the relay. Can be reversed.</p></TooltipContent>
        </Tooltip>
      )}

      {/* Delete Event (irreversible) */}
      {!isEventBanned && (
        <DeleteConfirmDialog
          trigger={
            <Button variant="destructive" disabled={anyPending}>
              <Trash2 className="h-4 w-4 mr-1" />
              Delete Event
            </Button>
          }
          title="Delete Event"
          summary="This will permanently ban the event from the relay. This cannot be undone."
          onConfirm={() => deleteEventMutation.mutateAsync()}
          isPending={deleteEventMutation.isPending}
        />
      )}

      {/* Media actions - only when media present */}
      {hasMedia && (
        <>
          {/* Reversible media actions */}
          {hasBlockedMedia && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="outline" className="border-green-500 text-green-600 hover:bg-green-50"
                  onClick={() => unblockMediaMutation.mutate()} disabled={anyPending}>
                  <Unlock className="h-4 w-4 mr-1" />
                  {unblockMediaMutation.isPending ? 'Unblocking...' : 'Unblock Media'}
                </Button>
              </TooltipTrigger>
              <TooltipContent><p>Unblock media. Content will be served again.</p></TooltipContent>
            </Tooltip>
          )}

          {hasRestrictedMedia && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="outline" className="border-green-500 text-green-600 hover:bg-green-50"
                  onClick={() => removeRestrictionMutation.mutate()} disabled={anyPending}>
                  <Unlock className="h-4 w-4 mr-1" />
                  {removeRestrictionMutation.isPending ? 'Removing...' : 'Remove Restriction'}
                </Button>
              </TooltipTrigger>
              <TooltipContent><p>Remove age restriction. Media will be publicly accessible.</p></TooltipContent>
            </Tooltip>
          )}

          {!hasBlockedMedia && !hasRestrictedMedia && (
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="outline" onClick={() => blockMediaMutation.mutate()} disabled={anyPending}>
                    <Video className="h-4 w-4 mr-1" />
                    {blockMediaMutation.isPending ? 'Blocking...' : `Block Media (${mediaHashes.length})`}
                  </Button>
                </TooltipTrigger>
                <TooltipContent><p>Block media by hash. Can be reversed.</p></TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="outline" className="border-orange-500 text-orange-600 hover:bg-orange-50"
                    onClick={() => ageRestrictMutation.mutate()} disabled={anyPending}>
                    <ShieldAlert className="h-4 w-4 mr-1" />
                    {ageRestrictMutation.isPending ? 'Restricting...' : `Age Restrict (${mediaHashes.length})`}
                  </Button>
                </TooltipTrigger>
                <TooltipContent><p>Age-restrict media. Owner can still view, gated for others. Can be reversed.</p></TooltipContent>
              </Tooltip>
            </>
          )}

          {/* Delete Media (irreversible) */}
          <DeleteConfirmDialog
            trigger={
              <Button variant="destructive" disabled={anyPending}>
                <Trash2 className="h-4 w-4 mr-1" />
                {`Delete Media (${mediaHashes.length})`}
              </Button>
            }
            title="Delete Media"
            summary={`This will permanently delete ${mediaHashes.length} media file(s). This cannot be undone.`}
            onConfirm={() => deleteMediaMutation.mutateAsync()}
            isPending={deleteMediaMutation.isPending}
          />

          {/* Delete Event & Media (irreversible, combined) */}
          {!isEventBanned && (
            <DeleteConfirmDialog
              trigger={
                <Button variant="destructive" disabled={anyPending}>
                  <Trash2 className="h-4 w-4 mr-1" />
                  Delete Event & Media
                </Button>
              }
              title="Delete Event & Media"
              summary={`This will permanently ban the event from the relay and delete ${mediaHashes.length} media file(s). This cannot be undone.`}
              onConfirm={() => deleteEventAndMediaMutation.mutateAsync()}
              isPending={deleteEventAndMediaMutation.isPending}
            />
          )}
        </>
      )}
    </div>
  );
}
