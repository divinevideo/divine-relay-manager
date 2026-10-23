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
  /** The stored action, so undo can tell a thumbnail gated with the video from one gated on its own. */
  action?: string | null;
  /** The status check did not answer for this file, so its state is unknown. */
  unreadable?: boolean;
}

interface EventActionsProps {
  eventId: string;
  pubkey: string;
  mediaHashes?: string[];
  /** The video's separately uploaded thumbnails. Acted on after mediaHashes. */
  thumbnailHashes?: string[];
  mediaHashStatuses?: MediaHashStatus[];
  isEventBanned?: boolean;
  hasBlockedMedia?: boolean;
  hasRestrictedMedia?: boolean;
  /** The media status check has not answered yet, or is checking again. */
  mediaStatusLoading?: boolean;
  onActionComplete?: () => void;
}

export function EventActions({
  eventId,
  pubkey,
  mediaHashes = [],
  thumbnailHashes = [],
  mediaHashStatuses = [],
  isEventBanned = false,
  hasBlockedMedia = false,
  hasRestrictedMedia = false,
  mediaStatusLoading = false,
  onActionComplete,
}: EventActionsProps) {
  const { toast } = useToast();
  const api = useAdminApi();
  const { getModeratorPubkey } = useCurrentUser();
  const queryClient = useQueryClient();
  const hasMedia = mediaHashes.length > 0;
  const thumbnails = thumbnailHashes.filter((hash) => !mediaHashes.includes(hash));
  const fileCount = mediaHashes.length + thumbnails.length;

  // Videos first: a failure there fails the action, as before. Thumbnails after,
  // and a thumbnail failure never fails the action, because #66 found that a
  // thumbnail the media server has no record of failed the whole button.
  //
  // "Blob not found" is the media server's own reply when it holds no such file
  // (divine-blossom handle_admin_moderate), passed through the moderation
  // service's 502 and the worker's error text. That stays a note. Any other
  // thumbnail failure leaves a file the media server does hold unchanged, so it
  // comes back as a warning.
  const actOnFiles = async (
    hashes: string[],
    act: (hash: string) => Promise<unknown>,
  ): Promise<{
    changed: number;
    thumbnailNote?: string;
    thumbnailToastNote?: string;
    thumbnailWarning?: string;
    thumbnailsLeftOpen?: number;
  }> => {
    const isThumbnail = (hash: string) => thumbnails.includes(hash);
    for (const hash of hashes.filter((h) => !isThumbnail(h))) await act(hash);
    let changed = hashes.filter((h) => !isThumbnail(h)).length;
    const errors: string[] = [];
    for (const hash of hashes.filter(isThumbnail)) {
      try {
        await act(hash);
        changed++;
      } catch (error) {
        errors.push(error instanceof Error ? error.message : 'unknown error');
      }
    }
    if (errors.length === 0) return { changed };
    const what = errors.length === 1 ? 'thumbnail' : `${errors.length} thumbnails`;
    const errorText = [...new Set(errors)].join('; ');
    const openCount = errors.filter((message) => !message.includes('Blob not found')).length;
    const leftOpen = openCount > 0;
    // The audit log keeps the full error text; the moderator gets it only when
    // something was left open.
    return {
      changed,
      thumbnailNote: `${what} not changed: ${errorText}`,
      ...(leftOpen
        ? { thumbnailWarning: errorText, thumbnailsLeftOpen: openCount }
        : { thumbnailToastNote: `${what} not changed: not found on the media server` }),
    };
  };
  const allFiles = [...mediaHashes, ...thumbnails];
  const statusOf = (hash: string) => mediaHashStatuses.find((s) => s.hash === hash);
  // Age Restrict never touches a thumbnail that is blocked, or whose status could
  // not be read and so might be: that would weaken it. When the video's own status
  // could not be read, Age Restrict is withheld. (The buttons only offer it when
  // the video is not known to be blocked.)
  const videoUnreadable = mediaHashes.some((hash) => statusOf(hash)?.unreadable);
  const filesToRestrict = allFiles.filter(
    (hash) => !(thumbnails.includes(hash) && (statusOf(hash)?.isBlocked || statusOf(hash)?.unreadable)),
  );
  // Undo reaches a thumbnail only when its stored action matches a gated video
  // file's, so a different gate on the thumbnail, such as an automated quarantine
  // under a moderator's block, stays.
  const undoFiles = (gated: (status: MediaHashStatus) => boolean) => {
    const gatedStatuses = mediaHashStatuses.filter(gated);
    const videoActions = new Set(gatedStatuses.filter((s) => !thumbnails.includes(s.hash)).map((s) => s.action));
    const files = gatedStatuses
      .filter((s) => !thumbnails.includes(s.hash) || (s.action != null && videoActions.has(s.action)))
      .map((s) => s.hash);
    return { files, leftAlone: gatedStatuses.length - files.length };
  };
  const leftAloneNote = (count: number, state: string) => {
    if (count === 0) return undefined;
    return count === 1
      ? `thumbnail left ${state}: it was ${state} separately`
      : `${count} thumbnails left ${state}: they were ${state} separately`;
  };
  const withNote = (reason: string, note?: string) => (note ? `${reason}; ${note}` : reason);
  const joinNotes = (...notes: (string | undefined)[]) => notes.filter(Boolean).join('; ') || undefined;
  const thumbnailWord = (count: number) => (count === 1 ? 'thumbnail' : `${count} thumbnails`);
  // A thumbnail whose status could not be read is never age restricted and never
  // undone, and the moderator is told so rather than left to assume it was.
  const unreadThumbnails = thumbnails.filter((hash) => statusOf(hash)?.unreadable).length;
  const unreadNote = unreadThumbnails === 0
    ? undefined
    : `${thumbnailWord(unreadThumbnails)} skipped: ${unreadThumbnails === 1 ? 'its' : 'their'} status could not be read`;
  const doneToast = (
    title: string,
    warningTitle: (what: string) => string,
    result?: { thumbnailToastNote?: string; thumbnailWarning?: string; thumbnailsLeftOpen?: number },
  ) => {
    const note = result?.thumbnailToastNote;
    const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
    if (result?.thumbnailWarning) {
      toast({
        title: warningTitle(thumbnailWord(result.thumbnailsLeftOpen ?? 1)),
        description: sentence(joinNotes(result.thumbnailWarning, note) ?? ''),
        variant: 'destructive',
      });
    } else {
      toast(note ? { title, description: sentence(note) } : { title });
    }
  };
  // Videos restricted or blocked before thumbnails were included can have an open
  // thumbnail, and a failed thumbnail needs a retry. Once the video is gated only
  // the undo button shows, so these re-apply the action to the video and reach the
  // thumbnail. For a video already in that state nothing changes; a quarantined
  // video counts as blocked, so Block again makes it a permanent block, which is
  // stronger. A blocked video is only ever offered Block again, and Age Restrict
  // again only shows when it would reach a thumbnail.
  const offerRestrictAgain = hasRestrictedMedia && !hasBlockedMedia && !videoUnreadable
    && filesToRestrict.some((hash) => thumbnails.includes(hash));
  const offerBlockAgain = thumbnails.length > 0 && hasBlockedMedia;

  // Audit logging is a non-critical side effect. Fire-and-forget so a slow, hung,
  // or failing /api/decisions write can never make a relay/media action that already
  // SUCCEEDED report failure (or leave a confirm dialog stuck open). The relay/media
  // action is the source of truth. On a successful write, re-invalidate the decision
  // log so the report converges without a manual refresh; on failure, surface a
  // non-blocking toast. Mirrors UserActions.logAudit.
  // Detached audit write. `moderator` is captured by the caller BEFORE the
  // authoritative request (so a logout/switch mid-request can't retarget it) and
  // reused across every write in the action. Waits for the in-flight identity,
  // attributes or falls back to null, and never blocks the action.
  const logAudit = (
    moderator: Promise<string | undefined>,
    params: Parameters<typeof api.logDecision>[0],
  ) =>
    void moderator.then((moderatorPubkey) =>
      api.logDecision({ ...params, moderatorPubkey })
        .then(() => {
          queryClient.invalidateQueries({ queryKey: ['decisions'] });
          queryClient.invalidateQueries({ queryKey: ['resolution-state'] });
        })
        .catch((e) => {
          console.warn('[EventActions] audit log failed', e);
          toast({ title: 'Action applied; audit log not recorded' });
        }));

  const banEventMutation = useMutation({
    mutationFn: async () => {
      const moderator = getModeratorPubkey(); // capture before the authoritative request
      const result = await api.hideEvent(eventId, 'Banned by moderator');
      logAudit(moderator, {
        targetType: 'event',
        targetId: eventId,
        action: 'ban_event',
        reason: 'Banned by moderator',
      });
      return result;
    },
    onSuccess: (result) => {
      toast(result.recorded === true
        ? { title: 'Event banned from relay' }
        : { title: 'Event banned; review state not recorded', variant: 'destructive' });
      onActionComplete?.();
    },
    onError: (error: Error) => {
      toast({ title: 'Failed to ban event', description: error.message, variant: 'destructive' });
    },
  });

  const restoreEventMutation = useMutation({
    mutationFn: async () => {
      const moderator = getModeratorPubkey(); // capture before the authoritative request
      const result = await api.restoreEvent(eventId, await moderator, 'Restored by moderator');
      logAudit(moderator, {
        targetType: 'event',
        targetId: eventId,
        action: 'restore_event',
        reason: 'Restored by moderator',
      });
      return result;
    },
    onSuccess: (result) => {
      toast(result.recorded === true && result.reconciled !== false
        ? { title: 'Event restored' }
        : {
            title: result.recorded === true
              ? 'Restore recorded; final relay state uncertain'
              : 'Restore applied but not recorded',
            variant: 'destructive',
          });
      onActionComplete?.();
    },
    onError: (error: Error) => {
      toast({ title: 'Failed to restore event', description: error.message, variant: 'destructive' });
    },
  });

  const deleteEventMutation = useMutation({
    mutationFn: async () => {
      const moderator = getModeratorPubkey(); // capture before the authoritative request
      await api.deleteEvent(eventId, 'Permanently deleted by moderator', pubkey);
      logAudit(moderator, {
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
      const moderator = getModeratorPubkey(); // capture before the authoritative request
      const result = await actOnFiles(allFiles, (hash) => api.moderateMedia(hash, 'PERMANENT_BAN', 'Blocked by moderator'));
      logAudit(moderator, {
        targetType: 'event',
        targetId: eventId,
        action: 'block_media',
        reason: withNote(`Blocked ${result.changed} media file(s)`, result.thumbnailNote),
      });
      return result;
    },
    onSuccess: (result) => {
      doneToast(`Blocked ${result.changed} media file(s)`, (what) => `Video blocked; ${what} NOT blocked`, result);
      onActionComplete?.();
    },
    onError: (error: Error) => {
      toast({ title: 'Failed to block media', description: error.message, variant: 'destructive' });
    },
  });

  const ageRestrictMutation = useMutation({
    mutationFn: async () => {
      const moderator = getModeratorPubkey(); // capture before the authoritative request
      const acted = await actOnFiles(filesToRestrict, (hash) => api.moderateMedia(hash, 'AGE_RESTRICTED', 'Age restricted by moderator'));
      // Skipped because it might be blocked, so it might as well be open.
      const result = unreadNote
        ? {
            ...acted,
            thumbnailWarning: joinNotes(acted.thumbnailWarning, unreadNote),
            thumbnailsLeftOpen: (acted.thumbnailsLeftOpen ?? 0) + unreadThumbnails,
          }
        : acted;
      logAudit(moderator, {
        targetType: 'event',
        targetId: eventId,
        action: 'age_restrict_media',
        reason: withNote(withNote(`Age restricted ${result.changed} media file(s)`, result.thumbnailNote), unreadNote),
      });
      return result;
    },
    onSuccess: (result) => {
      doneToast(`Age restricted ${result.changed} media file(s)`, (what) => `Video age restricted; ${what} NOT age restricted`, result);
      onActionComplete?.();
    },
    onError: (error: Error) => {
      toast({ title: 'Failed to age restrict', description: error.message, variant: 'destructive' });
    },
  });

  const unblockMediaMutation = useMutation({
    mutationFn: async () => {
      const { files, leftAlone } = undoFiles((s) => s.isBlocked);
      if (files.length === 0) return;
      const moderator = getModeratorPubkey(); // capture before the authoritative request
      const result = await actOnFiles(files, (hash) => api.moderateMedia(hash, 'SAFE', 'Unblocked by moderator'));
      const left = leftAloneNote(leftAlone, 'blocked');
      logAudit(moderator, {
        targetType: 'event',
        targetId: eventId,
        action: 'unblock_media',
        reason: withNote(withNote(withNote(`Unblocked ${result.changed} media file(s)`, result.thumbnailNote), left), unreadNote),
      });
      return { ...result, thumbnailToastNote: joinNotes(result.thumbnailToastNote, left, unreadNote) };
    },
    onSuccess: (result) => {
      doneToast('Media unblocked', (what) => `Video unblocked; ${what} still blocked`, result);
      onActionComplete?.();
    },
    onError: (error: Error) => {
      toast({ title: 'Failed to unblock media', description: error.message, variant: 'destructive' });
    },
  });

  const removeRestrictionMutation = useMutation({
    mutationFn: async () => {
      const { files, leftAlone } = undoFiles((s) => s.isRestricted);
      if (files.length === 0) return;
      const moderator = getModeratorPubkey(); // capture before the authoritative request
      const result = await actOnFiles(files, (hash) => api.moderateMedia(hash, 'SAFE', 'Restriction removed by moderator'));
      const left = leftAloneNote(leftAlone, 'restricted');
      logAudit(moderator, {
        targetType: 'event',
        targetId: eventId,
        action: 'remove_restriction',
        reason: withNote(withNote(withNote(`Removed restriction from ${result.changed} media file(s)`, result.thumbnailNote), left), unreadNote),
      });
      return { ...result, thumbnailToastNote: joinNotes(result.thumbnailToastNote, left, unreadNote) };
    },
    onSuccess: (result) => {
      doneToast('Restriction removed', (what) => `Restriction removed from video; ${what} still restricted`, result);
      onActionComplete?.();
    },
    onError: (error: Error) => {
      toast({ title: 'Failed to remove restriction', description: error.message, variant: 'destructive' });
    },
  });

  const deleteMediaMutation = useMutation({
    mutationFn: async () => {
      const moderator = getModeratorPubkey(); // capture before the authoritative request
      const result = await actOnFiles(allFiles, (hash) => api.deleteMedia(hash, 'Permanently deleted by moderator'));
      logAudit(moderator, {
        targetType: 'event',
        targetId: eventId,
        action: 'delete_media',
        reason: withNote(`Deleted ${result.changed} media file(s)`, result.thumbnailNote),
      });
      return result;
    },
    onSuccess: (result) => {
      doneToast(`Deleted ${result.changed} media file(s)`, (what) => `Video deleted; ${what} NOT deleted`, result);
      onActionComplete?.();
    },
    onError: (error: Error) => {
      toast({ title: 'Failed to delete media', description: error.message, variant: 'destructive' });
    },
  });

  const deleteEventAndMediaMutation = useMutation({
    mutationFn: async () => {
      const moderator = getModeratorPubkey(); // capture before the authoritative request
      const completed: string[] = [];
      try {
        await api.deleteEvent(eventId, 'Permanently deleted by moderator', pubkey);
        completed.push('event_deleted');
        logAudit(moderator, { targetType: 'event', targetId: eventId, action: 'delete_event', reason: 'Permanently deleted (combined)' });

        const result = await actOnFiles(allFiles, async (hash) => {
          await api.deleteMedia(hash, 'Permanently deleted by moderator');
          completed.push(`media_${hash}`);
        });
        logAudit(moderator, { targetType: 'event', targetId: eventId, action: 'delete_event_and_media', reason: withNote(`Permanently deleted event + ${result.changed} media file(s)`, result.thumbnailNote) });
        return result;
      } catch (error) {
        // Reached only when a real action (deleteEvent or a deleteMedia) failed —
        // not the audit log, which is now fire-and-forget. So "media deletion failed"
        // in onError is accurate.
        if (completed.length > 0) {
          logAudit(moderator, { targetType: 'event', targetId: eventId, action: 'delete_event_and_media_partial', reason: `Partial delete (completed: ${completed.join(', ')}). Error: ${error instanceof Error ? error.message : 'unknown'}` });
        }
        throw Object.assign(error instanceof Error ? error : new Error('Unknown error'), { completed });
      }
    },
    onSuccess: (result) => {
      doneToast('Event and media permanently deleted', (what) => `Event and video deleted; ${what} NOT deleted`, result);
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
  // Until the status check answers, a blocked file reads as open, and Age
  // Restrict would weaken it. So the media buttons wait for it.
  const mediaBusy = anyPending || mediaStatusLoading;

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
          <span role="status" className={mediaStatusLoading ? 'self-center text-sm text-muted-foreground' : 'sr-only'}>
            {mediaStatusLoading ? 'Checking media status…' : ''}
          </span>

          {/* Reversible media actions */}
          {hasBlockedMedia && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="outline" className="border-green-500 text-green-600 hover:bg-green-50"
                  onClick={() => unblockMediaMutation.mutate()} disabled={mediaBusy}>
                  <Unlock className="h-4 w-4 mr-1" />
                  {unblockMediaMutation.isPending ? 'Unblocking...' : 'Unblock Media'}
                </Button>
              </TooltipTrigger>
              <TooltipContent><p>Unblock media. Content will be served again.</p></TooltipContent>
            </Tooltip>
          )}

          {offerBlockAgain && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="outline" onClick={() => blockMediaMutation.mutate()} disabled={mediaBusy}>
                  <Video className="h-4 w-4 mr-1" />
                  {blockMediaMutation.isPending ? 'Blocking...' : `Block again (${fileCount})`}
                </Button>
              </TooltipTrigger>
              <TooltipContent><p>Block the video and its thumbnail again. Use when the thumbnail was missed or failed.</p></TooltipContent>
            </Tooltip>
          )}

          {hasRestrictedMedia && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="outline" className="border-green-500 text-green-600 hover:bg-green-50"
                  onClick={() => removeRestrictionMutation.mutate()} disabled={mediaBusy}>
                  <Unlock className="h-4 w-4 mr-1" />
                  {removeRestrictionMutation.isPending ? 'Removing...' : 'Remove Restriction'}
                </Button>
              </TooltipTrigger>
              <TooltipContent><p>Remove age restriction. Media will be publicly accessible.</p></TooltipContent>
            </Tooltip>
          )}

          {offerRestrictAgain && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="outline" className="border-orange-500 text-orange-600 hover:bg-orange-50"
                  onClick={() => ageRestrictMutation.mutate()} disabled={mediaBusy}>
                  <ShieldAlert className="h-4 w-4 mr-1" />
                  {ageRestrictMutation.isPending ? 'Restricting...' : `Age Restrict again (${filesToRestrict.length})`}
                </Button>
              </TooltipTrigger>
              <TooltipContent><p>Age-restrict the video and its thumbnail again. Use when the thumbnail was missed or failed.</p></TooltipContent>
            </Tooltip>
          )}

          {!hasBlockedMedia && !hasRestrictedMedia && (
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="outline" onClick={() => blockMediaMutation.mutate()} disabled={mediaBusy}>
                    <Video className="h-4 w-4 mr-1" />
                    {blockMediaMutation.isPending ? 'Blocking...' : `Block Media (${fileCount})`}
                  </Button>
                </TooltipTrigger>
                <TooltipContent><p>Block media by hash. Can be reversed.</p></TooltipContent>
              </Tooltip>
              {videoUnreadable ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    {/* A disabled button gets no pointer events, so the tooltip hangs on a wrapper. */}
                    <span tabIndex={0} className="rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                      <Button variant="outline" className="border-orange-500 text-orange-600" disabled>
                        <ShieldAlert className="h-4 w-4 mr-1" />
                        Age Restrict (status unknown)
                      </Button>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent><p>The video's status could not be read, so it may already be blocked. Reload to try again.</p></TooltipContent>
                </Tooltip>
              ) : (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="outline" className="border-orange-500 text-orange-600 hover:bg-orange-50"
                      onClick={() => ageRestrictMutation.mutate()} disabled={mediaBusy}>
                      <ShieldAlert className="h-4 w-4 mr-1" />
                      {ageRestrictMutation.isPending ? 'Restricting...' : `Age Restrict (${filesToRestrict.length})`}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent><p>Age-restrict media. Owner can still view, gated for others. Can be reversed.</p></TooltipContent>
                </Tooltip>
              )}
            </>
          )}

          {/* Delete Media (irreversible) */}
          <DeleteConfirmDialog
            trigger={
              <Button variant="destructive" disabled={mediaBusy}>
                <Trash2 className="h-4 w-4 mr-1" />
                {`Delete Media (${fileCount})`}
              </Button>
            }
            title="Delete Media"
            summary={`This will permanently delete ${fileCount} media file(s). This cannot be undone.`}
            onConfirm={async () => { await deleteMediaMutation.mutateAsync(); }}
            isPending={deleteMediaMutation.isPending}
          />

          {/* Delete Event & Media (irreversible, combined) */}
          {!isEventBanned && (
            <DeleteConfirmDialog
              trigger={
                <Button variant="destructive" disabled={mediaBusy}>
                  <Trash2 className="h-4 w-4 mr-1" />
                  Delete Event & Media
                </Button>
              }
              title="Delete Event & Media"
              summary={`This will permanently ban the event from the relay and delete ${fileCount} media file(s). This cannot be undone.`}
              onConfirm={async () => { await deleteEventAndMediaMutation.mutateAsync(); }}
              isPending={deleteEventAndMediaMutation.isPending}
            />
          )}
        </>
      )}
    </div>
  );
}
