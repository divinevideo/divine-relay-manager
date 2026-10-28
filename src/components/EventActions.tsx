import type { ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { getToasts, useToast } from '@/hooks/useToast';
import type { toast as showToast } from '@/hooks/useToast';
import { useAdminApi } from '@/hooks/useAdminApi';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { DeleteConfirmDialog } from './DeleteConfirmDialog';
import { ShieldX, Undo2, Video, ShieldAlert, Unlock, Trash2 } from 'lucide-react';

export interface MediaHashStatus {
  hash: string;
  isBlocked: boolean;
  isRestricted: boolean;
  /** The stored action, such as DELETE or QUARANTINE, which some buttons must not act on. */
  action?: string | null;
  /** The status check did not answer for this file, so its state is unknown. */
  unreadable?: boolean;
}

const DELETED_REASON = 'This video was deleted from the media server. Blocking or age restricting it would restore it.';
// An unknown video may be hidden by age review, which a block would outlast, or
// deleted, which a block would bring back, or blocked, which Age Restrict would weaken.
const UNREADABLE_REASON = "The video's status could not be read, so it may be hidden, deleted or blocked. Reload to try again.";

// What a media action shows when it finishes.
interface DoneToast {
  title: string;
  description?: string;
  variant?: 'destructive';
  duration?: number;
}

// A red media warning is the only sign a file was left in a state the moderator
// didn't choose (a thumbnail left open, an action stopped partway), so it stays
// up longer than the default five seconds.
const WARNING_DURATION_MS = 10000;

// A media action's toast, and once shown, the handle that changes it in place.
// Filled in after the audit writes have started, so they can reach it. An audit
// failure that lands before the toast shows is kept here and shown on it.
interface ShownToast {
  toast?: DoneToast;
  handle?: ReturnType<typeof showToast>;
  auditFailed?: boolean;
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
    const videos = hashes.filter((h) => !isThumbnail(h));
    for (const hash of videos) await act(hash);
    let changed = videos.length;
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
  // Any status but DELETE moves a deleted file out of Deleted on the media server
  // (divine-blossom handle_admin_moderate and handle_admin_moderate_action both),
  // so no status is ever sent to a deleted file: a deleted video gets no Block or
  // Age Restrict, and those skip a deleted thumbnail.
  const isDeleted = (hash: string) => statusOf(hash)?.action === 'DELETE';
  const videoDeleted = mediaHashes.some(isDeleted);
  const filesToBlock = allFiles.filter((hash) => !(thumbnails.includes(hash) && isDeleted(hash)));
  // Age Restrict also never touches a thumbnail that is blocked, or whose status
  // could not be read and so might be: that would weaken it. When the video's own
  // status could not be read, Block and Age Restrict are both withheld (see
  // UNREADABLE_REASON). (The buttons only offer Age Restrict when the video is
  // not known to be blocked.)
  const videoUnreadable = mediaHashes.some((hash) => statusOf(hash)?.unreadable);
  const filesToRestrict = filesToBlock.filter((hash) => {
    const status = statusOf(hash);
    return !(thumbnails.includes(hash) && (status?.isBlocked || status?.unreadable));
  });
  // Undo lifts the video files only. A thumbnail's stored action cannot say
  // whether it was gated with the video or on its own: Block overwrites an 18+
  // gate, and another moderator may have banned it for its own content. So a
  // thumbnail keeps its gate until a person lifts it with its own button, offered
  // only for the gates this screen sets, so a quarantine from the automated checks
  // is never lifted in one click. None is offered while a video file is hidden,
  // or its status could not be read and so it might be: age review hides the
  // video alone, and a thumbnail opened then would show a suspected minor's
  // image while the case is open.
  const gatedVideos = (gated: (status: MediaHashStatus) => boolean) =>
    mediaHashes.filter((hash) => { const status = statusOf(hash); return status ? gated(status) : false; });
  const gatedThumbnailCount = (gated: (status: MediaHashStatus) => boolean) =>
    thumbnails.filter((hash) => { const status = statusOf(hash); return status ? gated(status) : false; }).length;
  const videoHidden = mediaHashes.some((hash) => statusOf(hash)?.action === 'QUARANTINE');
  const liftableThumbnails = (action: string) =>
    (videoHidden || videoUnreadable ? [] : thumbnails.filter((hash) => statusOf(hash)?.action === action));
  const thumbnailsToUnblock = liftableThumbnails('PERMANENT_BAN');
  const thumbnailsToUnrestrict = liftableThumbnails('AGE_RESTRICTED');
  const joinNotes = (...notes: (string | undefined)[]) => notes.filter(Boolean).join('; ') || undefined;
  const withNote = (reason: string, ...notes: (string | undefined)[]) => joinNotes(reason, ...notes) ?? reason;
  const thumbnailWord = (count: number) => (count === 1 ? 'thumbnail' : `${count} thumbnails`);
  const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
  const leftGatedNote = (count: number, state: string) =>
    (count === 0 ? undefined : `${thumbnailWord(count)} left ${state}`);
  // A thumbnail whose status could not be read is never age restricted and gets no
  // undo button of its own, and the moderator is told so rather than left to
  // assume it was changed.
  const unreadThumbnails = thumbnails.filter((hash) => statusOf(hash)?.unreadable).length;
  const unreadNote = unreadThumbnails === 0
    ? undefined
    : `${thumbnailWord(unreadThumbnails)} skipped: ${unreadThumbnails === 1 ? 'its' : 'their'} status could not be read`;
  // Built before the audit write settles, so a failed write can reach a warning.
  const doneToast = (
    title: string,
    warningTitle: (what: string) => string,
    result?: { thumbnailToastNote?: string; thumbnailWarning?: string; thumbnailsLeftOpen?: number },
  ): DoneToast => {
    const note = result?.thumbnailToastNote;
    if (result?.thumbnailWarning) {
      return {
        title: warningTitle(thumbnailWord(result.thumbnailsLeftOpen ?? 1)),
        description: sentence(joinNotes(result.thumbnailWarning, note) ?? ''),
        variant: 'destructive',
        duration: WARNING_DURATION_MS,
      };
    }
    return note ? { title, description: sentence(note) } : { title };
  };
  // Videos restricted or blocked before thumbnails were included can have an open
  // thumbnail, and a failed thumbnail needs a retry. Once the video is gated only
  // the undo button shows, so these re-apply the action to the video and reach the
  // thumbnail, and show only when there is a thumbnail they may act on. (The status
  // check can say a thumbnail is gated when the media server never got the change,
  // so it cannot hide them.) Block again is never offered when a video file is an
  // age-review hide, which the review lifts when the case clears and a ban would
  // outlive, or is deleted or unreadable. A blocked video is never offered Age
  // Restrict again.
  const offerRestrictAgain = hasRestrictedMedia && !hasBlockedMedia && !videoUnreadable && !videoDeleted
    && filesToRestrict.some((hash) => thumbnails.includes(hash));
  const offerBlockAgain = hasBlockedMedia
    && !mediaHashes.some((hash) => {
      const status = statusOf(hash);
      return !status || status.unreadable || status.action === 'QUARANTINE' || status.action === 'DELETE';
    })
    && filesToBlock.some((hash) => thumbnails.includes(hash));

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
  // One toast shows at a time and the write usually settles after the action's
  // own toast, so a failure toast of its own would replace a warning, the only
  // sign that a thumbnail was left open. While the warning is open, a failure is
  // added to it instead; once it is closed or replaced, the failure gets the
  // usual toast, and an out-of-date warning never comes back. A failure before
  // the action's toast shows goes on that toast. The toasts are read from the
  // store when the write settles, so this holds after the panel unmounts too.
  const logAudit = (
    moderator: Promise<string | undefined>,
    params: Parameters<typeof api.logDecision>[0],
    shown?: ShownToast,
  ) =>
    void moderator.then((moderatorPubkey) =>
      api.logDecision({ ...params, moderatorPubkey })
        .then(() => {
          queryClient.invalidateQueries({ queryKey: ['decisions'] });
          queryClient.invalidateQueries({ queryKey: ['resolution-state'] });
        })
        .catch((e) => {
          console.warn('[EventActions] audit log failed', e);
          if (shown && !shown.handle) {
            shown.auditFailed = true;
            return;
          }
          const warning = shown?.toast?.variant === 'destructive' ? shown.toast : undefined;
          const handle = shown?.handle;
          if (warning && handle && getToasts().some((t) => t.id === handle.id && t.open)) {
            handle.update({ ...withAuditNote(warning), id: handle.id });
          } else {
            toast({ title: 'Action applied; audit log not recorded' });
          }
        }));

  const withAuditNote = (done: DoneToast): DoneToast => ({
    ...done,
    description: done.description ? `${done.description}; audit log not recorded` : 'Audit log not recorded',
  });

  const showDone = (shown: ShownToast) => {
    if (shown.toast) {
      shown.handle = toast(shown.auditFailed ? withAuditNote(shown.toast) : shown.toast);
    } else if (shown.auditFailed) {
      toast({ title: 'Action applied; audit log not recorded' });
    }
    onActionComplete?.();
  };

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
      const result = await actOnFiles(filesToBlock, (hash) => api.moderateMedia(hash, 'PERMANENT_BAN', 'Blocked by moderator'));
      const shown: ShownToast = { toast: doneToast(`Blocked ${result.changed} media file(s)`, (what) => `Video blocked; ${what} NOT blocked`, result) };
      logAudit(moderator, {
        targetType: 'event',
        targetId: eventId,
        action: 'block_media',
        reason: withNote(`Blocked ${result.changed} media file(s)`, result.thumbnailNote),
      }, shown);
      return shown;
    },
    onSuccess: showDone,
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
      const shown: ShownToast = { toast: doneToast(`Age restricted ${result.changed} media file(s)`, (what) => `Video age restricted; ${what} NOT age restricted`, result) };
      logAudit(moderator, {
        targetType: 'event',
        targetId: eventId,
        action: 'age_restrict_media',
        reason: withNote(`Age restricted ${result.changed} media file(s)`, result.thumbnailNote, unreadNote),
      }, shown);
      return shown;
    },
    onSuccess: showDone,
    onError: (error: Error) => {
      toast({ title: 'Failed to age restrict', description: error.message, variant: 'destructive' });
    },
  });

  // Lifts files one after another. When one fails after others were lifted, the
  // audit log records those, and the error says so and carries the toast holder,
  // so the failure toast can take a failed audit write the way a warning does.
  const liftEach = async (
    hashes: string[],
    apiReason: string,
    moderator: Promise<string | undefined>,
    audit: { action: string; reason: (count: number) => string },
  ) => {
    let lifted = 0;
    try {
      for (const hash of hashes) {
        await api.moderateMedia(hash, 'SAFE', apiReason);
        lifted++;
      }
    } catch (error) {
      if (lifted === 0) throw error;
      const message = `${lifted} of ${hashes.length} lifted, then: ${error instanceof Error ? error.message : 'unknown error'}`;
      const partial: ShownToast = {};
      logAudit(moderator, { targetType: 'event', targetId: eventId, action: audit.action, reason: `${audit.reason(lifted)}; ${message}` }, partial);
      throw Object.assign(new Error(message), { partial });
    }
  };

  // An undo's failure. After a partial lift something did change, so the screen
  // checks the media status again, as the combined delete does on a partial.
  const undoFailed = (title: string) => (error: Error & { partial?: ShownToast }) => {
    const failure: DoneToast = { title, description: error.message, variant: 'destructive' };
    if (error.partial) {
      error.partial.toast = { ...failure, duration: WARNING_DURATION_MS };
      showDone(error.partial);
    } else {
      toast(failure);
    }
  };

  // Undo of the video files. Thumbnails keep their gate (see gatedVideos), and the
  // toast says how many did.
  const undoVideos = async (
    gated: (status: MediaHashStatus) => boolean,
    state: string,
    title: string,
    apiReason: string,
    audit: { action: string; reason: (count: number) => string },
  ): Promise<ShownToast> => {
    const files = gatedVideos(gated);
    if (files.length === 0) return { toast: { title } };
    const moderator = getModeratorPubkey(); // capture before the authoritative request
    await liftEach(files, apiReason, moderator, audit);
    const left = leftGatedNote(gatedThumbnailCount(gated), state);
    const note = joinNotes(left, unreadNote);
    logAudit(moderator, {
      targetType: 'event',
      targetId: eventId,
      action: audit.action,
      reason: withNote(audit.reason(files.length), left, unreadNote),
    });
    return { toast: note ? { title, description: sentence(note) } : { title } };
  };

  // A person lifting a thumbnail's own gate. The thumbnail is the whole action
  // here, so a failure fails it.
  const undoThumbnails = async (
    hashes: string[],
    apiReason: string,
    title: (what: string) => string,
    audit: { action: string; reason: (count: number) => string },
  ): Promise<ShownToast> => {
    const moderator = getModeratorPubkey(); // capture before the authoritative request
    await liftEach(hashes, apiReason, moderator, audit);
    logAudit(moderator, { targetType: 'event', targetId: eventId, action: audit.action, reason: audit.reason(hashes.length) });
    return { toast: { title: sentence(title(thumbnailWord(hashes.length))) } };
  };

  const unblockMediaMutation = useMutation({
    mutationFn: () => undoVideos((s) => s.isBlocked, 'blocked', 'Media unblocked', 'Unblocked by moderator',
      { action: 'unblock_media', reason: (count) => `Unblocked ${count} media file(s)` }),
    onSuccess: showDone,
    onError: undoFailed('Failed to unblock media'),
  });

  const removeRestrictionMutation = useMutation({
    mutationFn: () => undoVideos((s) => s.isRestricted, 'restricted', 'Restriction removed', 'Restriction removed by moderator',
      { action: 'remove_restriction', reason: (count) => `Removed restriction from ${count} media file(s)` }),
    onSuccess: showDone,
    onError: undoFailed('Failed to remove restriction'),
  });

  const unblockThumbnailMutation = useMutation({
    mutationFn: () => undoThumbnails(thumbnailsToUnblock, 'Unblocked by moderator', (what) => `${what} unblocked`,
      { action: 'unblock_media', reason: (count) => `Unblocked ${count} thumbnail(s)` }),
    onSuccess: showDone,
    onError: undoFailed('Failed to unblock thumbnail'),
  });

  const unrestrictThumbnailMutation = useMutation({
    mutationFn: () => undoThumbnails(thumbnailsToUnrestrict, 'Restriction removed by moderator', (what) => `Restriction removed from ${what}`,
      { action: 'remove_restriction', reason: (count) => `Removed restriction from ${count} thumbnail(s)` }),
    onSuccess: showDone,
    onError: undoFailed('Failed to remove thumbnail restriction'),
  });

  const deleteMediaMutation = useMutation({
    mutationFn: async () => {
      const moderator = getModeratorPubkey(); // capture before the authoritative request
      const result = await actOnFiles(allFiles, (hash) => api.deleteMedia(hash, 'Permanently deleted by moderator'));
      const shown: ShownToast = { toast: doneToast(`Deleted ${result.changed} media file(s)`, (what) => `Video deleted; ${what} NOT deleted`, result) };
      logAudit(moderator, {
        targetType: 'event',
        targetId: eventId,
        action: 'delete_media',
        reason: withNote(`Deleted ${result.changed} media file(s)`, result.thumbnailNote),
      }, shown);
      return shown;
    },
    onSuccess: showDone,
    onError: (error: Error) => {
      toast({ title: 'Failed to delete media', description: error.message, variant: 'destructive' });
    },
  });

  const deleteEventAndMediaMutation = useMutation({
    mutationFn: async () => {
      const moderator = getModeratorPubkey(); // capture before the authoritative request
      const completed: string[] = [];
      // Shared by both audit writes: the first can settle after the toast too.
      const shown: ShownToast = {};
      try {
        await api.deleteEvent(eventId, 'Permanently deleted by moderator', pubkey);
        completed.push('event_deleted');
        logAudit(moderator, { targetType: 'event', targetId: eventId, action: 'delete_event', reason: 'Permanently deleted (combined)' }, shown);

        const result = await actOnFiles(allFiles, async (hash) => {
          await api.deleteMedia(hash, 'Permanently deleted by moderator');
          completed.push(`media_${hash}`);
        });
        shown.toast = doneToast('Event and media permanently deleted', (what) => `Event and video deleted; ${what} NOT deleted`, result);
        logAudit(moderator, { targetType: 'event', targetId: eventId, action: 'delete_event_and_media', reason: withNote(`Permanently deleted event + ${result.changed} media file(s)`, result.thumbnailNote) }, shown);
        return shown;
      } catch (error) {
        // Reached only when a real action (deleteEvent or a deleteMedia) failed —
        // not the audit log, which is now fire-and-forget. So "media deletion failed"
        // in onError is accurate.
        if (completed.length > 0) {
          logAudit(moderator, { targetType: 'event', targetId: eventId, action: 'delete_event_and_media_partial', reason: `Partial delete (completed: ${completed.join(', ')}). Error: ${error instanceof Error ? error.message : 'unknown'}` }, shown);
        }
        throw Object.assign(error instanceof Error ? error : new Error('Unknown error'), { completed, partial: shown });
      }
    },
    onSuccess: showDone,
    onError: (error: Error & { completed?: string[]; partial?: ShownToast }) => {
      const completed = error.completed ?? [];
      if (completed.length > 0) {
        // Through the shared holder, so an audit failure joins this warning.
        const shown = error.partial ?? {};
        shown.toast = {
          title: 'Partially completed',
          description: `Event was deleted but media deletion failed: ${error.message}`,
          variant: 'destructive',
          duration: WARNING_DURATION_MS,
        };
        showDone(shown);
      } else {
        toast({ title: 'Failed to delete', description: error.message, variant: 'destructive' });
      }
    },
  });

  const anyPending = banEventMutation.isPending || restoreEventMutation.isPending ||
    deleteEventMutation.isPending || blockMediaMutation.isPending || ageRestrictMutation.isPending ||
    unblockMediaMutation.isPending || removeRestrictionMutation.isPending ||
    unblockThumbnailMutation.isPending || unrestrictThumbnailMutation.isPending ||
    deleteMediaMutation.isPending || deleteEventAndMediaMutation.isPending;
  // Until the status check answers, a blocked file reads as open, and Age
  // Restrict would weaken it. So the media buttons wait for it.
  const mediaBusy = anyPending || mediaStatusLoading;

  // A button the moderator can see but not use, with the reason on hover or focus.
  const withheld = (icon: ReactNode, className: string | undefined, label: string, reason: string) => (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* A disabled button gets no pointer events, so the tooltip hangs on a wrapper. */}
        <span tabIndex={0} className="rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <Button variant="outline" className={className} disabled>
            {icon}
            {label}
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent><p>{reason}</p></TooltipContent>
    </Tooltip>
  );

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
                  {blockMediaMutation.isPending ? 'Blocking...' : `Block again (${filesToBlock.length})`}
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

          {thumbnailsToUnblock.length > 0 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="outline" className="border-green-500 text-green-600 hover:bg-green-50"
                  onClick={() => unblockThumbnailMutation.mutate()} disabled={mediaBusy}>
                  <Unlock className="h-4 w-4 mr-1" />
                  {unblockThumbnailMutation.isPending ? 'Unblocking...' : `Unblock thumbnail (${thumbnailsToUnblock.length})`}
                </Button>
              </TooltipTrigger>
              <TooltipContent><p>Unblock the thumbnail only, and serve it to everyone. First check it was not blocked for its own content.</p></TooltipContent>
            </Tooltip>
          )}

          {thumbnailsToUnrestrict.length > 0 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="outline" className="border-green-500 text-green-600 hover:bg-green-50"
                  onClick={() => unrestrictThumbnailMutation.mutate()} disabled={mediaBusy}>
                  <Unlock className="h-4 w-4 mr-1" />
                  {unrestrictThumbnailMutation.isPending ? 'Removing...' : `Remove thumbnail restriction (${thumbnailsToUnrestrict.length})`}
                </Button>
              </TooltipTrigger>
              <TooltipContent><p>Remove the thumbnail's age restriction only. First check it was not restricted for its own content.</p></TooltipContent>
            </Tooltip>
          )}

          {!hasBlockedMedia && !hasRestrictedMedia && (videoDeleted ? (
            <>
              {withheld(<Video className="h-4 w-4 mr-1" />, undefined, 'Block Media (deleted)', DELETED_REASON)}
              {withheld(<ShieldAlert className="h-4 w-4 mr-1" />, 'border-orange-500 text-orange-600', 'Age Restrict (deleted)', DELETED_REASON)}
            </>
          ) : videoUnreadable ? (
            <>
              {withheld(<Video className="h-4 w-4 mr-1" />, undefined, 'Block Media (status unknown)', UNREADABLE_REASON)}
              {withheld(<ShieldAlert className="h-4 w-4 mr-1" />, 'border-orange-500 text-orange-600', 'Age Restrict (status unknown)', UNREADABLE_REASON)}
            </>
          ) : (
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="outline" onClick={() => blockMediaMutation.mutate()} disabled={mediaBusy}>
                    <Video className="h-4 w-4 mr-1" />
                    {blockMediaMutation.isPending ? 'Blocking...' : `Block Media (${filesToBlock.length})`}
                  </Button>
                </TooltipTrigger>
                <TooltipContent><p>Block media by hash. Can be reversed.</p></TooltipContent>
              </Tooltip>
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
            </>
          ))}

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
