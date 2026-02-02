// ABOUTME: Comprehensive event detail view showing all event information
// ABOUTME: Includes raw JSON, linked events, author profile, user stats, related reports, and moderation actions

import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNostr } from "@/hooks/useNostr";
import { useAuthor } from "@/hooks/useAuthor";
import { useUserStats } from "@/hooks/useUserStats";
import { useModerationStatus } from "@/hooks/useModerationStatus";
import { useToast } from "@/hooks/useToast";
import { getKindInfo, getKindCategory } from "@/lib/kindNames";
import { useAdminApi } from "@/hooks/useAdminApi";
import { UserIdentifier } from "@/components/UserIdentifier";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
import { HiveAIReport } from "@/components/HiveAIReport";
import { AIDetectionReport } from "@/components/AIDetectionReport";
import { ReporterList } from "@/components/ReporterCard";
import { MediaPreview } from "@/components/MediaPreview";
import { CATEGORY_LABELS } from "@/lib/constants";
import {
  User,
  Hash,
  Link,
  Tag,
  FileJson,
  Copy,
  ExternalLink,
  AtSign,
  MessageSquare,
  Flag,
  FileText,
  ShieldX,
  UserX,
  UserCheck,
  ShieldAlert,
  Undo2,
  AlertTriangle,
  Loader2,
  CheckCircle,
  XCircle,
} from "lucide-react";
import type { NostrEvent } from "@nostrify/nostrify";
import { nip19 } from "nostr-tools";

// High-priority categories - media should be hidden by default for moderator safety
const HIGH_PRIORITY_CATEGORIES = ['sexual_minors', 'csam', 'NS-csam', 'nonconsensual_sexual_content', 'terrorism_extremism', 'credible_threats'];

// Extract category from a report event
function getReportCategory(event: NostrEvent): string {
  const reportTag = event.tags.find(t => t[0] === 'report');
  if (reportTag && reportTag[1]) return reportTag[1];
  const lTag = event.tags.find(t => t[0] === 'l');
  if (lTag && lTag[1]) return lTag[1];
  return 'other';
}

interface EventDetailProps {
  event: NostrEvent;
  onClose?: () => void;
  onSelectEvent?: (eventId: string) => void;
  onSelectPubkey?: (pubkey: string) => void;
  onViewReports?: (pubkey: string) => void;
}

// Extract URLs from content
function extractUrls(content: string): string[] {
  const urlRegex = /(https?:\/\/[^\s<>"{}|\\^`[\]]+)/g;
  return content.match(urlRegex) || [];
}

// Check if URL is media
function isMediaUrl(url: string): 'image' | 'video' | null {
  const lower = url.toLowerCase();
  if (/\.(jpg|jpeg|png|gif|webp|svg|avif)/.test(lower)) return 'image';
  if (/\.(mp4|webm|mov|m3u8|avi)/.test(lower)) return 'video';
  if (lower.includes('divine.video') || lower.includes('youtube') || lower.includes('vimeo')) return 'video';
  return null;
}

// Format pubkey for display
function formatPubkey(pubkey: string): string {
  try {
    return nip19.npubEncode(pubkey).slice(0, 16) + '...';
  } catch {
    return pubkey.slice(0, 16) + '...';
  }
}

// Format event ID for display
function formatEventId(id: string): string {
  try {
    return nip19.noteEncode(id).slice(0, 16) + '...';
  } catch {
    return id.slice(0, 16) + '...';
  }
}

function ProfileMetadataCard({ content }: { content: string }) {
  let metadata: Record<string, unknown>;
  try {
    metadata = JSON.parse(content);
  } catch {
    // If it's not valid JSON, fall back to raw display
    return (
      <Card>
        <CardHeader className="py-2 px-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <User className="h-4 w-4" />
            Profile Metadata
          </CardTitle>
        </CardHeader>
        <CardContent className="py-2 px-3">
          <div className="whitespace-pre-wrap break-words text-sm max-h-96 overflow-y-auto">
            {content}
          </div>
        </CardContent>
      </Card>
    );
  }

  const name = metadata.name as string | undefined;
  const displayName = metadata.display_name as string | undefined;
  const about = metadata.about as string | undefined;
  const picture = metadata.picture as string | undefined;
  const banner = metadata.banner as string | undefined;
  const nip05 = metadata.nip05 as string | undefined;
  const website = metadata.website as string | undefined;
  const lud16 = metadata.lud16 as string | undefined;
  const bot = metadata.bot as boolean | undefined;

  return (
    <Card>
      <CardHeader className="py-2 px-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <User className="h-4 w-4" />
          Profile Metadata
        </CardTitle>
      </CardHeader>
      <CardContent className="py-2 px-3 space-y-3">
        {/* Banner */}
        {banner && (
          <div className="relative -mx-3 -mt-3 h-24 overflow-hidden rounded-t">
            <img src={banner} alt="" className="w-full h-full object-cover" />
          </div>
        )}

        {/* Avatar + Name */}
        <div className="flex items-center gap-3">
          {picture && (
            <img
              src={picture}
              alt={displayName || name || ''}
              className="h-12 w-12 rounded-full object-cover"
            />
          )}
          <div className="min-w-0">
            {displayName && (
              <p className="font-semibold truncate">{displayName}</p>
            )}
            {name && name !== displayName && (
              <p className="text-sm text-muted-foreground">@{name}</p>
            )}
            {nip05 && (
              <p className="text-xs text-muted-foreground">{nip05}</p>
            )}
          </div>
          {bot && (
            <Badge variant="secondary" className="text-xs shrink-0">Bot</Badge>
          )}
        </div>

        {/* Bio */}
        {about && (
          <p className="text-sm whitespace-pre-wrap break-words">{about}</p>
        )}

        {/* Links */}
        {(website || lud16) && (
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {website && (
              <a href={website} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 hover:text-foreground">
                <Link className="h-3 w-3" />
                {website.replace(/^https?:\/\//, '')}
              </a>
            )}
            {lud16 && (
              <span className="flex items-center gap-1">
                <AtSign className="h-3 w-3" />
                {lud16}
              </span>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function AuthorCard({ pubkey }: { pubkey: string }) {
  const author = useAuthor(pubkey);
  const metadata = author.data?.metadata;
  const displayName = metadata?.name || formatPubkey(pubkey);

  if (author.isLoading) {
    return (
      <div className="flex items-center gap-3 p-3 bg-muted/50 rounded-lg">
        <Skeleton className="h-12 w-12 rounded-full" />
        <div className="space-y-1">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-3 w-24" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3 p-3 bg-muted/50 rounded-lg">
      {metadata?.picture ? (
        <img
          src={metadata.picture}
          alt={displayName}
          className="h-12 w-12 rounded-full object-cover"
        />
      ) : (
        <div className="h-12 w-12 rounded-full bg-gray-300 dark:bg-gray-600 flex items-center justify-center">
          <User className="h-6 w-6 text-gray-500" />
        </div>
      )}
      <div className="flex-1 min-w-0">
        <p className="font-medium truncate">{displayName}</p>
        <p className="text-xs text-muted-foreground font-mono truncate">
          {formatPubkey(pubkey)}
        </p>
        {metadata?.nip05 && (
          <p className="text-xs text-blue-600 truncate">
            <AtSign className="h-3 w-3 inline mr-0.5" />
            {metadata.nip05}
          </p>
        )}
      </div>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => navigator.clipboard.writeText(pubkey)}
      >
        <Copy className="h-4 w-4" />
      </Button>
    </div>
  );
}

function LinkedEvent({ eventId, onSelect }: { eventId: string; onSelect?: (id: string) => void }) {
  const { nostr } = useNostr();

  const { data: event, isLoading } = useQuery({
    queryKey: ['event', eventId],
    queryFn: async ({ signal }) => {
      const events = await nostr.query(
        [{ ids: [eventId] }],
        { signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) }
      );
      return events[0] || null;
    },
    staleTime: 60 * 1000,
  });

  if (isLoading) {
    return <Skeleton className="h-16 w-full" />;
  }

  if (!event) {
    return (
      <div className="p-2 border rounded text-xs text-muted-foreground font-mono">
        Event not found: {eventId.slice(0, 16)}...
      </div>
    );
  }

  const kindInfo = getKindInfo(event.kind);

  return (
    <div
      className="p-2 border rounded hover:bg-muted/50 cursor-pointer transition-colors"
      onClick={() => onSelect?.(eventId)}
    >
      <div className="flex items-center justify-between mb-1">
        <Badge variant="outline" className="text-xs">{kindInfo.name}</Badge>
        <span className="text-xs text-muted-foreground">
          {new Date(event.created_at * 1000).toLocaleDateString()}
        </span>
      </div>
      <p className="text-xs text-muted-foreground truncate">
        {event.content?.slice(0, 100) || '(no content)'}
      </p>
    </div>
  );
}

function TagsTable({ tags }: { tags: string[][] }) {
  const [expanded, setExpanded] = useState(false);
  const _displayTags = expanded ? tags : tags.slice(0, 10);

  // Group tags by type
  const tagGroups: Record<string, string[][]> = {};
  for (const tag of tags) {
    const type = tag[0] || 'unknown';
    if (!tagGroups[type]) tagGroups[type] = [];
    tagGroups[type].push(tag);
  }

  return (
    <div className="space-y-2">
      {Object.entries(tagGroups).map(([type, groupTags]) => (
        <div key={type} className="border rounded p-2">
          <div className="flex items-center gap-2 mb-1">
            <Badge variant="secondary" className="text-xs">{type}</Badge>
            <span className="text-xs text-muted-foreground">({groupTags.length})</span>
          </div>
          <div className="space-y-1">
            {groupTags.slice(0, expanded ? undefined : 3).map((tag, idx) => (
              <div key={idx} className="text-xs font-mono bg-muted/50 p-1 rounded overflow-x-auto">
                {tag.map((val, i) => (
                  <span key={i} className={i === 0 ? 'text-blue-600' : ''}>
                    {i > 0 && ', '}
                    {val.length > 50 ? val.slice(0, 50) + '...' : val}
                  </span>
                ))}
              </div>
            ))}
            {groupTags.length > 3 && !expanded && (
              <p className="text-xs text-muted-foreground">+{groupTags.length - 3} more</p>
            )}
          </div>
        </div>
      ))}
      {tags.length > 10 && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setExpanded(!expanded)}
          className="w-full"
        >
          {expanded ? 'Show less' : `Show all ${tags.length} tags`}
        </Button>
      )}
    </div>
  );
}

export function EventDetail({ event, onSelectEvent, onSelectPubkey, onViewReports }: EventDetailProps) {
  const { nostr } = useNostr();
  const { toast } = useToast();
  const { banPubkey, deleteEvent, unbanPubkey, verifyPubkeyBanned, verifyPubkeyUnbanned, verifyEventDeleted, callRelayRpc, logDecision } = useAdminApi();
  const queryClient = useQueryClient();

  const [_showRawJson, _setShowRawJson] = useState(false);
  const [confirmBan, setConfirmBan] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [isVerifying, setIsVerifying] = useState(false);
  const [verificationResult, setVerificationResult] = useState<{
    type: 'ban' | 'delete';
    success: boolean;
    message: string;
  } | null>(null);

  const kindInfo = getKindInfo(event.kind);
  const category = getKindCategory(event.kind);

  // Get user stats for the author
  const userStats = useUserStats(event.pubkey);

  // Get moderation status for the author and event
  const moderationStatus = useModerationStatus(event.pubkey, event.id);

  // Get reports against this event or user
  const { data: relatedReports } = useQuery({
    queryKey: ['related-reports', event.id, event.pubkey],
    queryFn: async ({ signal }) => {
      const queries: Promise<import('@nostrify/nostrify').NostrEvent[]>[] = [];

      // Reports on this specific event
      if (event.id) {
        queries.push(
          nostr.query(
            [{ kinds: [1984], '#e': [event.id], limit: 50 }],
            { signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]) }
          )
        );
      }

      // Reports on this user
      queries.push(
        nostr.query(
          [{ kinds: [1984], '#p': [event.pubkey], limit: 50 }],
          { signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]) }
        )
      );

      const results = await Promise.all(queries);
      const allReports = results.flat();

      // Dedupe by event ID
      const seen = new Set<string>();
      return allReports.filter(r => {
        if (!r.id || seen.has(r.id)) return false;
        seen.add(r.id);
        return true;
      }).sort((a, b) => b.created_at - a.created_at);
    },
  });

  const banMutation = useMutation({
    mutationFn: async ({ pubkey, reason }: { pubkey: string; reason: string }) => {
      await banPubkey(pubkey, reason);
      return pubkey;
    },
    onSuccess: async (pubkey) => {
      queryClient.invalidateQueries({ queryKey: ['banned-users'] });
      queryClient.invalidateQueries({ queryKey: ['banned-pubkeys'] });
      moderationStatus.refetch();
      toast({ title: "User banned", description: "Verifying..." });
      setConfirmBan(false);

      // Verify the ban worked
      setIsVerifying(true);
      setVerificationResult(null);
      try {
        const verified = await verifyPubkeyBanned(pubkey);
        setVerificationResult({
          type: 'ban',
          success: verified,
          message: verified
            ? 'User ban verified - pubkey is in banned list'
            : 'Warning: User may not be banned - not found in banned list',
        });
        toast({
          title: verified ? "Ban Verified" : "Verification Warning",
          description: verified
            ? "User is confirmed banned on relay"
            : "Could not confirm ban - check relay manually",
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
      return eventId;
    },
    onSuccess: async (eventId) => {
      queryClient.invalidateQueries({ queryKey: ['relay-events'] });
      queryClient.invalidateQueries({ queryKey: ['banned-events'] });
      moderationStatus.refetch();
      toast({ title: "Event deleted", description: "Verifying..." });
      setConfirmDelete(false);

      // Verify the deletion worked
      setIsVerifying(true);
      setVerificationResult(null);
      try {
        const verified = await verifyEventDeleted(eventId);
        setVerificationResult({
          type: 'delete',
          success: verified,
          message: verified
            ? 'Event deletion verified - no longer accessible on relay'
            : 'Warning: Event may still be accessible on relay',
        });
        toast({
          title: verified ? "Deletion Verified" : "Verification Warning",
          description: verified
            ? "Event is confirmed deleted from relay"
            : "Event may still be accessible - check relay manually",
          variant: verified ? "default" : "destructive",
        });
      } catch {
        setVerificationResult({
          type: 'delete',
          success: false,
          message: 'Could not verify deletion status',
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

  const unbanMutation = useMutation({
    mutationFn: async ({ pubkey }: { pubkey: string }) => {
      await unbanPubkey(pubkey);
      await logDecision({
        targetType: 'pubkey',
        targetId: pubkey,
        action: 'unban_user',
        reason: 'Unbanned from event viewer',
      });
      return pubkey;
    },
    onSuccess: async (pubkey) => {
      queryClient.invalidateQueries({ queryKey: ['banned-users'] });
      queryClient.invalidateQueries({ queryKey: ['banned-pubkeys'] });
      moderationStatus.refetch();
      toast({ title: "User unbanned", description: "Verifying..." });

      setIsVerifying(true);
      setVerificationResult(null);
      try {
        const verified = await verifyPubkeyUnbanned(pubkey);
        setVerificationResult({
          type: 'ban',
          success: verified,
          message: verified
            ? 'Unban verified - user is no longer in banned list'
            : 'Warning: User may still be banned',
        });
      } catch {
        setVerificationResult({
          type: 'ban',
          success: false,
          message: 'Could not verify unban status',
        });
      } finally {
        setIsVerifying(false);
      }
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to unban user",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const restoreMutation = useMutation({
    mutationFn: async ({ eventId }: { eventId: string }) => {
      await callRelayRpc('allowevent', [eventId]);
      await logDecision({
        targetType: 'event',
        targetId: eventId,
        action: 'restore_event',
        reason: 'Restored from event viewer',
      });
      return eventId;
    },
    onSuccess: async () => {
      queryClient.invalidateQueries({ queryKey: ['relay-events'] });
      queryClient.invalidateQueries({ queryKey: ['banned-events'] });
      moderationStatus.refetch();
      toast({ title: "Event restored" });
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to restore event",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  // Manual re-verification function
  const handleReVerify = async (type: 'ban' | 'delete') => {
    setIsVerifying(true);
    setVerificationResult(null);
    try {
      if (type === 'ban') {
        const verified = await verifyPubkeyBanned(event.pubkey);
        setVerificationResult({
          type: 'ban',
          success: verified,
          message: verified
            ? 'User ban verified - pubkey is in banned list'
            : 'User is NOT in banned list',
        });
      } else {
        const verified = await verifyEventDeleted(event.id);
        setVerificationResult({
          type: 'delete',
          success: verified,
          message: verified
            ? 'Event is deleted from relay'
            : 'Event is still accessible on relay',
        });
      }
    } catch {
      setVerificationResult({
        type,
        success: false,
        message: 'Verification failed - could not check status',
      });
    } finally {
      setIsVerifying(false);
    }
  };

  // Extract linked events and pubkeys
  const linkedEvents = event.tags.filter(t => t[0] === 'e').map(t => t[1]);
  const linkedPubkeys = event.tags.filter(t => t[0] === 'p').map(t => t[1]);
  const linkedAddresses = event.tags.filter(t => t[0] === 'a');

  // Extract URLs from content (non-media URLs for external links section)
  const urls = extractUrls(event.content || '');
  const otherUrls = urls.filter(u => !isMediaUrl(u));

  // Check if any related report has a high-priority category (CSAM, etc.)
  // Used to collapse media preview by default to protect moderators
  const hasHighPriorityReports = useMemo(() => {
    if (!relatedReports?.length) return false;
    return relatedReports.some(r => {
      const cat = getReportCategory(r);
      return HIGH_PRIORITY_CATEGORIES.includes(cat);
    });
  }, [relatedReports]);

  return (
    <>
      {/* Ban Confirmation Dialog */}
      <AlertDialog open={confirmBan} onOpenChange={setConfirmBan}>
        <AlertDialogContent className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>Ban User?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                <p>This will ban this user from the relay. This can be reversed.</p>

                {/* User Identifier */}
                <div className="bg-muted px-3 py-2 rounded">
                  <UserIdentifier
                    pubkey={event.pubkey}
                    showAvatar
                    avatarSize="md"
                    variant="block"
                    linkToProfile
                  />
                </div>

                {/* User Stats */}
                {userStats.data && (
                  <div className="flex gap-4 text-xs text-muted-foreground p-2 bg-muted/50 rounded">
                    <span className="flex items-center gap-1">
                      <FileText className="h-3 w-3" />
                      {userStats.data.postCount} posts
                    </span>
                    <span className="flex items-center gap-1">
                      <Flag className="h-3 w-3" />
                      {userStats.data.reportCount} reports
                    </span>
                    <span className="flex items-center gap-1">
                      <Tag className="h-3 w-3" />
                      {userStats.data.labelCount} labels
                    </span>
                  </div>
                )}

                {/* Related Reports Summary */}
                {relatedReports && relatedReports.length > 0 && (
                  <div className="p-2 bg-destructive/10 border border-destructive/20 rounded text-xs">
                    <span className="font-medium text-destructive">
                      <AlertTriangle className="h-3 w-3 inline mr-1" />
                      This user has {relatedReports.length} report{relatedReports.length !== 1 ? 's' : ''} against them
                    </span>
                  </div>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={banMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                banMutation.mutate({
                  pubkey: event.pubkey,
                  reason: `Banned from event viewer`,
                });
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
            <AlertDialogTitle>Ban Event?</AlertDialogTitle>
            <AlertDialogDescription>
              This will remove this event from the relay. The content will no longer be served. This can be reversed.
              <br />
              <code className="text-xs bg-muted px-1 py-0.5 rounded mt-2 inline-block">
                {event.id?.slice(0, 24)}...
              </code>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (event.id) {
                  deleteMutation.mutate({
                    eventId: event.id,
                    reason: `Deleted from event viewer`,
                  });
                }
              }}
              disabled={deleteMutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteMutation.isPending ? 'Banning...' : 'Ban Event'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

    <div className="h-full flex flex-col overflow-hidden">
    <ScrollArea className="flex-1 min-h-0">
      <div className="p-4 space-y-4">
        {/* Moderation Status Banner */}
        {(moderationStatus.isBanned || moderationStatus.isDeleted) && (
          <Alert variant="destructive" className="border-destructive/50 bg-destructive/10">
            <ShieldAlert className="h-4 w-4" />
            <AlertDescription className="flex items-center justify-between">
              <span className="font-medium">
                {moderationStatus.isBanned && moderationStatus.isDeleted
                  ? 'This user is banned and this event has been deleted from the relay.'
                  : moderationStatus.isBanned
                    ? 'This user is banned from the relay.'
                    : 'This event has been deleted from the relay.'}
              </span>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleReVerify(moderationStatus.isBanned ? 'ban' : 'delete')}
                  disabled={isVerifying}
                  className="h-7 text-xs"
                >
                  {isVerifying ? (
                    <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                  ) : (
                    <CheckCircle className="h-3 w-3 mr-1" />
                  )}
                  Re-verify
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        )}

        {/* Verification Result */}
        {verificationResult && (
          <Alert variant={verificationResult.success ? "default" : "destructive"} className={verificationResult.success ? "border-green-500/50 bg-green-500/10" : ""}>
            {verificationResult.success ? (
              <CheckCircle className="h-4 w-4 text-green-600" />
            ) : (
              <XCircle className="h-4 w-4" />
            )}
            <AlertDescription className="flex items-center justify-between">
              <span>{verificationResult.message}</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setVerificationResult(null)}
                className="h-6 px-2"
              >
                Dismiss
              </Button>
            </AlertDescription>
          </Alert>
        )}

        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant="outline">{kindInfo.name}</Badge>
            <Badge variant="secondary">{category}</Badge>
            {kindInfo.nip && (
              <Badge variant="outline" className="text-xs">
                {kindInfo.nip}
              </Badge>
            )}
            {relatedReports && relatedReports.length > 0 && (
              <Badge variant="destructive" className="gap-1">
                <Flag className="h-3 w-3" />
                {relatedReports.length} report{relatedReports.length !== 1 ? 's' : ''}
              </Badge>
            )}
          </div>
          <span className="text-xs text-muted-foreground">
            {new Date(event.created_at * 1000).toLocaleString()}
          </span>
        </div>

        {/* Kind Description */}
        <p className="text-sm text-muted-foreground">{kindInfo.description}</p>

        {/* Author */}
        <Card>
          <CardHeader className="py-2 px-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <User className="h-4 w-4" />
              Author
            </CardTitle>
          </CardHeader>
          <CardContent className="py-2 px-3 space-y-3">
            <AuthorCard pubkey={event.pubkey} />
            {/* User Stats */}
            {userStats.data && (
              <div className="flex gap-4 text-xs text-muted-foreground pt-2 border-t">
                <span className="flex items-center gap-1">
                  <FileText className="h-3 w-3" />
                  {userStats.data.postCount} posts
                </span>
                <span className="flex items-center gap-1">
                  <Flag className="h-3 w-3" />
                  {userStats.data.reportCount} reports
                </span>
                <span className="flex items-center gap-1">
                  <Tag className="h-3 w-3" />
                  {userStats.data.labelCount} labels
                </span>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Content */}
        {event.content && (
          event.kind === 0 ? (
            <ProfileMetadataCard content={event.content} />
          ) : (
            <Card>
              <CardHeader className="py-2 px-3">
                <CardTitle className="text-sm flex items-center gap-2">
                  <MessageSquare className="h-4 w-4" />
                  Content
                </CardTitle>
              </CardHeader>
              <CardContent className="py-2 px-3">
                <div className="whitespace-pre-wrap break-words text-sm max-h-96 overflow-y-auto">
                  {event.content}
                </div>
              </CardContent>
            </Card>
          )
        )}

        {/* Media Preview - collapsed by default if event has high-priority reports */}
        <MediaPreview
          event={event}
          showByDefault={!hasHighPriorityReports}
          maxItems={4}
        />

        {/* Hive AI Content Moderation */}
        <HiveAIReport eventTags={event.tags} />

        {/* AI Detection (Reality Defender multi-provider) */}
        <AIDetectionReport eventTags={event.tags} eventId={event.id} />

        {/* Related Reports */}
        {relatedReports && relatedReports.length > 0 && (
          <>
            <Separator />
            <Card>
              <CardHeader className="py-2 px-3">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Flag className="h-4 w-4" />
                  {relatedReports.length} Related Report{relatedReports.length !== 1 ? 's' : ''}
                </CardTitle>
              </CardHeader>
              <CardContent className="py-2 px-3">
                <ReporterList
                  reports={relatedReports}
                  onViewProfile={onSelectPubkey}
                  onViewPosts={onSelectPubkey}
                  maxVisible={3}
                />
              </CardContent>
            </Card>
          </>
        )}

        <Tabs defaultValue="links" className="w-full">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="links" className="text-xs">
              <Link className="h-3 w-3 mr-1" />
              Links ({linkedEvents.length + linkedPubkeys.length})
            </TabsTrigger>
            <TabsTrigger value="tags" className="text-xs">
              <Tag className="h-3 w-3 mr-1" />
              Tags ({event.tags.length})
            </TabsTrigger>
            <TabsTrigger value="raw" className="text-xs">
              <FileJson className="h-3 w-3 mr-1" />
              JSON
            </TabsTrigger>
          </TabsList>

          {/* Linked Events/Pubkeys */}
          <TabsContent value="links" className="space-y-3 mt-3">
            {linkedEvents.length > 0 && (
              <div>
                <h4 className="text-sm font-medium mb-2 flex items-center gap-1">
                  <Hash className="h-4 w-4" />
                  Referenced Events ({linkedEvents.length})
                </h4>
                <div className="space-y-2">
                  {linkedEvents.slice(0, 5).map((id) => (
                    <LinkedEvent key={id} eventId={id} onSelect={onSelectEvent} />
                  ))}
                  {linkedEvents.length > 5 && (
                    <p className="text-xs text-muted-foreground">+{linkedEvents.length - 5} more</p>
                  )}
                </div>
              </div>
            )}

            {linkedPubkeys.length > 0 && (
              <div>
                <h4 className="text-sm font-medium mb-2 flex items-center gap-1">
                  <User className="h-4 w-4" />
                  Referenced Users ({linkedPubkeys.length})
                </h4>
                <div className="space-y-2">
                  {linkedPubkeys.slice(0, 5).map((pk) => (
                    <AuthorCard key={pk} pubkey={pk} />
                  ))}
                  {linkedPubkeys.length > 5 && (
                    <p className="text-xs text-muted-foreground">+{linkedPubkeys.length - 5} more</p>
                  )}
                </div>
              </div>
            )}

            {linkedAddresses.length > 0 && (
              <div>
                <h4 className="text-sm font-medium mb-2 flex items-center gap-1">
                  <Link className="h-4 w-4" />
                  Addressable References ({linkedAddresses.length})
                </h4>
                <div className="space-y-1">
                  {linkedAddresses.map((tag, idx) => (
                    <div key={idx} className="text-xs font-mono bg-muted p-2 rounded">
                      {tag[1]}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {otherUrls.length > 0 && (
              <div>
                <h4 className="text-sm font-medium mb-2 flex items-center gap-1">
                  <ExternalLink className="h-4 w-4" />
                  External Links ({otherUrls.length})
                </h4>
                <div className="space-y-1">
                  {otherUrls.map((url, idx) => (
                    <a
                      key={idx}
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-blue-600 hover:underline block truncate"
                    >
                      {url}
                    </a>
                  ))}
                </div>
              </div>
            )}

            {linkedEvents.length === 0 && linkedPubkeys.length === 0 && linkedAddresses.length === 0 && otherUrls.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-4">
                No linked events or references
              </p>
            )}
          </TabsContent>

          {/* Tags */}
          <TabsContent value="tags" className="mt-3">
            {event.tags.length > 0 ? (
              <TagsTable tags={event.tags} />
            ) : (
              <p className="text-sm text-muted-foreground text-center py-4">
                No tags
              </p>
            )}
          </TabsContent>

          {/* Raw JSON */}
          <TabsContent value="raw" className="mt-3">
            <div className="relative">
              <Button
                variant="ghost"
                size="sm"
                className="absolute top-2 right-2 z-10"
                onClick={() => navigator.clipboard.writeText(JSON.stringify(event, null, 2))}
              >
                <Copy className="h-4 w-4" />
              </Button>
              <pre className="text-xs bg-muted p-3 rounded overflow-x-auto max-h-96">
                {JSON.stringify(event, null, 2)}
              </pre>
            </div>
          </TabsContent>
        </Tabs>

        {/* Event IDs */}
        <Card>
          <CardHeader className="py-2 px-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <Hash className="h-4 w-4" />
              Event IDs
            </CardTitle>
          </CardHeader>
          <CardContent className="py-2 px-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">Event ID (hex):</span>
              <div className="flex items-center gap-1">
                <code className="text-xs font-mono">{event.id?.slice(0, 24)}...</code>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => navigator.clipboard.writeText(event.id || '')}
                >
                  <Copy className="h-3 w-3" />
                </Button>
              </div>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">Note ID (bech32):</span>
              <div className="flex items-center gap-1">
                <code className="text-xs font-mono">{formatEventId(event.id || '')}</code>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    try {
                      navigator.clipboard.writeText(nip19.noteEncode(event.id || ''));
                    } catch {
                      // Ignore copy errors
                    }
                  }}
                >
                  <Copy className="h-3 w-3" />
                </Button>
              </div>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">Signature:</span>
              <div className="flex items-center gap-1">
                <code className="text-xs font-mono">{event.sig?.slice(0, 16)}...</code>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => navigator.clipboard.writeText(event.sig || '')}
                >
                  <Copy className="h-3 w-3" />
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

      </div>
    </ScrollArea>

      {/* Action Buttons - fixed at bottom */}
      <div className="border-t bg-background p-4 space-y-3 shrink-0">
          {/* Navigation actions */}
          <div className="flex flex-wrap gap-2">
            {onSelectPubkey && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => onSelectPubkey(event.pubkey)}
              >
                <User className="h-4 w-4 mr-1" />
                View All by User
              </Button>
            )}
            {onViewReports && relatedReports && relatedReports.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => onViewReports(event.pubkey)}
              >
                <Flag className="h-4 w-4 mr-1" />
                View in Reports
              </Button>
            )}
          </div>

          {/* Enforcement actions */}
          <div className="flex flex-wrap gap-2">
            {moderationStatus.isDeleted ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  if (event.id) restoreMutation.mutate({ eventId: event.id });
                }}
                disabled={restoreMutation.isPending}
                title="Restore this event to the relay. This reverses the ban."
              >
                <Undo2 className="h-4 w-4 mr-1" />
                {restoreMutation.isPending ? 'Restoring...' : 'Restore Event'}
              </Button>
            ) : (
              <Button
                variant="destructive"
                size="sm"
                onClick={() => setConfirmDelete(true)}
                disabled={deleteMutation.isPending}
                title="Ban this event from the relay. This can be reversed."
              >
                <ShieldX className="h-4 w-4 mr-1" />
                Ban Event
              </Button>
            )}
            {moderationStatus.isBanned ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => unbanMutation.mutate({ pubkey: event.pubkey })}
                disabled={unbanMutation.isPending}
                title="Unban this user from the relay. This reverses the ban."
              >
                <UserCheck className="h-4 w-4 mr-1" />
                {unbanMutation.isPending ? 'Unbanning...' : 'Unban User'}
              </Button>
            ) : (
              <Button
                variant="destructive"
                size="sm"
                onClick={() => setConfirmBan(true)}
                disabled={banMutation.isPending}
                title="Ban this user from the relay. This can be reversed."
              >
                <UserX className="h-4 w-4 mr-1" />
                Ban User
              </Button>
            )}
          </div>
      </div>
    </div>
    </>
  );
}
