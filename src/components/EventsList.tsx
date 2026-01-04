import { useState, useEffect, useRef, useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNostr } from "@/hooks/useNostr";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useAuthor } from "@/hooks/useAuthor";
import { useToast } from "@/hooks/useToast";
import { nip19 } from "nostr-tools";
import { getKindInfo, getKindCategory } from "@/lib/kindNames";
import { callRelayRpc, verifyEventDeleted } from "@/lib/adminApi";
import { useAppContext } from "@/hooks/useAppContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { EventDetail } from "@/components/EventDetail";
import { Checkbox } from "@/components/ui/checkbox";
import {
  FileText,
  MoreVertical,
  Shield,
  ShieldX,
  ShieldCheck,
  User,
  Clock,
  Hash,
  RefreshCw,
  Ban,
  CheckCircle,
  Copy,
  AlertTriangle,
  Eye,
  Search,
  Flag,
  Image,
  UserPlus,
  Loader2,
  XCircle,
} from "lucide-react";
import type { NostrEvent } from "@nostrify/nostrify";

interface EventsListProps {
  relayUrl: string;
}

interface EventWithModeration extends NostrEvent {
  moderationStatus?: 'pending' | 'approved' | 'banned';
  moderationReason?: string;
}


function EventCard({
  event,
  isSelected,
  onSelect,
  onModerate,
}: {
  event: EventWithModeration;
  isSelected: boolean;
  onSelect: () => void;
  onModerate: (eventId: string, action: 'allow' | 'ban', reason?: string) => void;
}) {
  const author = useAuthor(event.pubkey);
  const [moderationDialogOpen, setModerationDialogOpen] = useState(false);
  const [moderationAction, setModerationAction] = useState<'allow' | 'ban'>('ban');
  const [moderationReason, setModerationReason] = useState('');

  const metadata = author.data?.metadata;
  const displayName = metadata?.name || nip19.npubEncode(event.pubkey).slice(0, 12) + '...';
  const profileImage = metadata?.picture;

  const kindInfo = getKindInfo(event.kind);
  const category = getKindCategory(event.kind);

  const handleModerate = () => {
    onModerate(event.id!, moderationAction, moderationReason.trim() || undefined);
    setModerationDialogOpen(false);
    setModerationReason('');
  };

  const formatTimestamp = (timestamp: number) => {
    return new Date(timestamp * 1000).toLocaleString();
  };

  const truncateContent = (content: string, maxLength: number = 100) => {
    if (content.length <= maxLength) return content;
    return content.slice(0, maxLength) + '...';
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
  };

  return (
    <>
      <div
        className={`p-3 border rounded-lg cursor-pointer transition-colors mb-2 ${
          isSelected
            ? 'border-primary bg-primary/5 ring-1 ring-primary'
            : 'hover:bg-muted/50'
        }`}
        onClick={onSelect}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            {profileImage ? (
              <img
                src={profileImage}
                alt={displayName}
                className="w-8 h-8 rounded-full object-cover shrink-0"
              />
            ) : (
              <div className="w-8 h-8 rounded-full bg-gray-200 dark:bg-gray-700 flex items-center justify-center shrink-0">
                <User className="h-4 w-4 text-gray-500" />
              </div>
            )}
            <div className="min-w-0">
              <p className="font-medium text-sm truncate">{displayName}</p>
              <p className="text-xs text-muted-foreground font-mono">
                {(() => {
                  try {
                    const npub = nip19.npubEncode(event.pubkey);
                    return `${npub.slice(0, 12)}...`;
                  } catch {
                    return `${event.pubkey.slice(0, 12)}...`;
                  }
                })()}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <Badge variant="outline" className="text-xs">
              {kindInfo.name}
            </Badge>
            {event.moderationStatus && (
              <Badge
                variant={
                  event.moderationStatus === 'approved' ? 'default' :
                  event.moderationStatus === 'banned' ? 'destructive' : 'secondary'
                }
                className="text-xs"
              >
                {event.moderationStatus}
              </Badge>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" onClick={(e) => e.stopPropagation()}>
                  <MoreVertical className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onSelect(); }}>
                  <Eye className="h-4 w-4 mr-2" />
                  View Details
                </DropdownMenuItem>
                <DropdownMenuItem onClick={(e) => { e.stopPropagation(); setModerationDialogOpen(true); }}>
                  <Shield className="h-4 w-4 mr-2" />
                  Moderate Event
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={(e) => { e.stopPropagation(); copyToClipboard(event.id!); }}>
                  <Copy className="h-4 w-4 mr-2" />
                  Copy Event ID
                </DropdownMenuItem>
                <DropdownMenuItem onClick={(e) => { e.stopPropagation(); copyToClipboard(event.pubkey); }}>
                  <User className="h-4 w-4 mr-2" />
                  Copy Pubkey
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {event.content && (
          <p className="text-sm mt-2 text-muted-foreground truncate">
            {truncateContent(event.content)}
          </p>
        )}

        <div className="flex items-center justify-between mt-2 text-xs text-muted-foreground">
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {formatTimestamp(event.created_at)}
            </span>
            <span className="flex items-center gap-1 font-mono">
              <Hash className="h-3 w-3" />
              {event.id?.slice(0, 8)}...
            </span>
          </div>
          {event.tags.length > 0 && (
            <span>{event.tags.length} tags</span>
          )}
        </div>

        {event.moderationReason && (
          <div className="mt-2 p-2 bg-destructive/10 rounded text-xs text-destructive">
            <AlertTriangle className="h-3 w-3 inline mr-1" />
            {event.moderationReason}
          </div>
        )}
      </div>

      {/* Moderation Dialog */}
      <Dialog open={moderationDialogOpen} onOpenChange={setModerationDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Moderate Event</DialogTitle>
            <DialogDescription>
              Choose an action for this event. This will affect how it's handled by your relay.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Action</Label>
              <Select value={moderationAction} onValueChange={(value: 'allow' | 'ban') => setModerationAction(value)}>
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="allow">
                    <div className="flex items-center space-x-2">
                      <CheckCircle className="h-4 w-4 text-green-600" />
                      <span>Allow Event</span>
                    </div>
                  </SelectItem>
                  <SelectItem value="ban">
                    <div className="flex items-center space-x-2">
                      <Ban className="h-4 w-4 text-red-600" />
                      <span>Ban Event</span>
                    </div>
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="moderation-reason">Reason (optional)</Label>
              <Textarea
                id="moderation-reason"
                value={moderationReason}
                onChange={(e) => setModerationReason(e.target.value)}
                placeholder="Enter reason for this moderation action"
                className="mt-1"
              />
            </div>
            <div className="bg-muted p-3 rounded-lg">
              <p className="text-sm font-medium">Event Details:</p>
              <p className="text-xs text-muted-foreground mt-1">
                ID: {event.id}<br/>
                Kind: {event.kind}<br/>
                Author: {event.pubkey}<br/>
                Created: {formatTimestamp(event.created_at)}
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setModerationDialogOpen(false)}>
              Cancel
            </Button>
            <Button 
              onClick={handleModerate}
              variant={moderationAction === 'ban' ? 'destructive' : 'default'}
            >
              {moderationAction === 'allow' ? (
                <>
                  <ShieldCheck className="h-4 w-4 mr-2" />
                  Allow Event
                </>
              ) : (
                <>
                  <ShieldX className="h-4 w-4 mr-2" />
                  Ban Event
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function EventsList({ relayUrl }: EventsListProps) {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { toast } = useToast();
  const { config } = useAppContext();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [isVerifying, setIsVerifying] = useState(false);
  const [verificationResult, setVerificationResult] = useState<{
    eventId: string;
    success: boolean;
    message: string;
  } | null>(null);

  const [kindFilter, setKindFilter] = useState<string>('all');
  const [limit, setLimit] = useState(20);
  const [customKind, setCustomKind] = useState('');
  const [selectedEvent, setSelectedEvent] = useState<NostrEvent | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterHasReports, setFilterHasReports] = useState(false);
  const [filterNewUsers, setFilterNewUsers] = useState(false);
  const [filterHasMedia, setFilterHasMedia] = useState(false);
  const [filterByPubkey, setFilterByPubkey] = useState<string | null>(
    searchParams.get('pubkey')
  );

  // Sync URL params with filterByPubkey state
  useEffect(() => {
    const pubkeyParam = searchParams.get('pubkey');
    if (pubkeyParam !== filterByPubkey) {
      setFilterByPubkey(pubkeyParam);
    }
  }, [searchParams]);

  // Update URL when filterByPubkey changes
  const updatePubkeyFilter = (pubkey: string | null) => {
    setFilterByPubkey(pubkey);
    if (pubkey) {
      setSearchParams({ pubkey });
    } else {
      setSearchParams({});
    }
  };

  // Ref for infinite scroll trigger
  const loadMoreRef = useRef<HTMLDivElement>(null);

  // Query for recent events with infinite scroll
  const {
    data: eventsData,
    isLoading: loadingEvents,
    error: eventsError,
    refetch,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: ['relay-events', relayUrl, kindFilter, limit, customKind],
    queryFn: async ({ pageParam }) => {
      const signal = AbortSignal.timeout(10000);

      const filter: { limit: number; kinds?: number[]; until?: number } = { limit };

      // Use `until` for pagination - fetch events older than the last one
      if (pageParam) {
        filter.until = pageParam;
      }

      if (kindFilter !== 'all') {
        if (kindFilter === 'custom' && customKind) {
          const kind = parseInt(customKind);
          if (!isNaN(kind)) {
            filter.kinds = [kind];
          }
        } else if (kindFilter !== 'custom') {
          const kinds = kindFilter.split(',').map(k => parseInt(k)).filter(k => !isNaN(k));
          if (kinds.length > 0) {
            filter.kinds = kinds;
          }
        }
      }

      const events = await nostr.query([filter], { signal });
      return events.sort((a, b) => b.created_at - a.created_at);
    },
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (lastPage) => {
      // Get the oldest event's timestamp for the next page
      if (lastPage.length === 0) return undefined;
      const oldestEvent = lastPage[lastPage.length - 1];
      // Return timestamp - 1 to get events strictly before this one
      return oldestEvent.created_at - 1;
    },
    enabled: !!relayUrl && !!nostr,
    refetchInterval: 30000, // Refresh every 30 seconds
  });

  // Flatten all pages into a single events array
  const events = eventsData?.pages.flat() ?? [];

  // Auto-load more when scrolling to bottom (IntersectionObserver)
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasNextPage && !isFetchingNextPage) {
          fetchNextPage();
        }
      },
      { threshold: 0.1 }
    );

    const currentRef = loadMoreRef.current;
    if (currentRef) {
      observer.observe(currentRef);
    }

    return () => {
      if (currentRef) {
        observer.unobserve(currentRef);
      }
    };
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  // Query for banned events to mark them
  const { data: bannedEvents } = useQuery({
    queryKey: ['banned-events', relayUrl],
    queryFn: () => callRelayRpc('listbannedevents'),
    enabled: !!relayUrl && !!user,
  });

  // Query for events needing moderation
  const { data: eventsNeedingModeration } = useQuery({
    queryKey: ['events-needing-moderation', relayUrl],
    queryFn: () => callRelayRpc('listeventsneedingmoderation'),
    enabled: !!relayUrl && !!user,
  });

  // Query for all reports to check which users/events have been reported
  const { data: allReports } = useQuery({
    queryKey: ['all-reports', relayUrl],
    queryFn: async () => {
      const signal = AbortSignal.timeout(5000);
      const reports = await nostr.query([{ kinds: [1984], limit: 500 }], { signal });
      return reports;
    },
    enabled: filterHasReports,
    staleTime: 60000,
  });

  // Build sets of reported event IDs and pubkeys
  const reportedEventIds = new Set<string>();
  const reportedPubkeys = new Set<string>();
  if (allReports) {
    for (const report of allReports) {
      const eTag = report.tags.find(t => t[0] === 'e');
      if (eTag) reportedEventIds.add(eTag[1]);
      const pTag = report.tags.find(t => t[0] === 'p');
      if (pTag) reportedPubkeys.add(pTag[1]);
    }
  }

  // Helper to check if content has media
  const hasMedia = (content: string): boolean => {
    const mediaPattern = /https?:\/\/[^\s]+\.(jpg|jpeg|png|gif|webp|mp4|webm|mov)/i;
    return mediaPattern.test(content);
  };

  // Helper to check if user is "new" (created within last 7 days based on event timestamp)
  const isNewUser = (pubkey: string, events: NostrEvent[]): boolean => {
    const userEvents = events.filter(e => e.pubkey === pubkey);
    if (userEvents.length === 0) return true;
    const oldest = Math.min(...userEvents.map(e => e.created_at));
    const sevenDaysAgo = Date.now() / 1000 - (7 * 24 * 60 * 60);
    return oldest > sevenDaysAgo;
  };

  // Mutation for event moderation
  const moderateEventMutation = useMutation({
    mutationFn: async ({ eventId, action, reason }: { eventId: string; action: 'allow' | 'ban'; reason?: string }) => {
      const method = action === 'allow' ? 'allowevent' : 'banevent';
      await callRelayRpc(method, [eventId, reason]);
      return { eventId, action };
    },
    onSuccess: async ({ eventId, action }) => {
      queryClient.invalidateQueries({ queryKey: ['banned-events', relayUrl] });
      queryClient.invalidateQueries({ queryKey: ['events-needing-moderation', relayUrl] });
      toast({
        title: `Event ${action === 'allow' ? 'approved' : 'banned'}`,
        description: action === 'ban' ? "Verifying..." : `Event ${eventId.slice(0, 8)}... has been approved.`
      });

      // Only verify for ban actions
      if (action === 'ban') {
        setIsVerifying(true);
        setVerificationResult(null);
        try {
          const isDeleted = await verifyEventDeleted(eventId, config.relayUrl);
          setVerificationResult({
            eventId,
            success: isDeleted,
            message: isDeleted
              ? 'Event ban verified - event removed from relay'
              : 'Warning: Event may still exist on relay',
          });
          toast({
            title: isDeleted ? "Ban Verified" : "Verification Warning",
            description: isDeleted
              ? "Event confirmed removed from relay"
              : "Could not confirm event removal - check manually",
            variant: isDeleted ? "default" : "destructive",
          });
        } catch {
          setVerificationResult({
            eventId,
            success: false,
            message: 'Could not verify ban status',
          });
        } finally {
          setIsVerifying(false);
        }
      }
    },
    onError: (error: Error, { action }) => {
      toast({
        title: `Failed to ${action} event`,
        description: error.message,
        variant: "destructive"
      });
    },
  });

  const handleModerateEvent = (eventId: string, action: 'allow' | 'ban', reason?: string) => {
    moderateEventMutation.mutate({ eventId, action, reason });
  };

  // Enhance events with moderation status and apply filters
  const enhancedEvents: EventWithModeration[] = (events || [])
    .map(event => {
      const isBanned = bannedEvents?.some((banned: { id: string }) => banned.id === event.id);
      const needsModeration = eventsNeedingModeration?.some((pending: { id: string }) => pending.id === event.id);

      return {
        ...event,
        moderationStatus: isBanned ? 'banned' : needsModeration ? 'pending' : undefined,
        moderationReason: isBanned ? bannedEvents?.find((banned: { id: string; reason?: string }) => banned.id === event.id)?.reason :
                         needsModeration ? eventsNeedingModeration?.find((pending: { id: string; reason?: string }) => pending.id === event.id)?.reason : undefined,
      };
    })
    .filter(event => {
      // Filter by pubkey if set
      if (filterByPubkey && event.pubkey !== filterByPubkey) {
        return false;
      }

      // Search filter - check content and pubkey
      if (searchQuery.trim()) {
        const query = searchQuery.toLowerCase();
        const matchesContent = event.content?.toLowerCase().includes(query);
        const matchesPubkey = event.pubkey.toLowerCase().includes(query);
        if (!matchesContent && !matchesPubkey) {
          return false;
        }
      }

      // Has reports filter
      if (filterHasReports) {
        const isReported = reportedEventIds.has(event.id!) || reportedPubkeys.has(event.pubkey);
        if (!isReported) return false;
      }

      // Has media filter
      if (filterHasMedia) {
        if (!hasMedia(event.content || '')) return false;
      }

      // New users filter
      if (filterNewUsers && events) {
        if (!isNewUser(event.pubkey, events)) return false;
      }

      return true;
    });

  const kindOptions = [
    { value: 'all', label: 'All Events' },
    { value: '1', label: 'Text Notes (1)' },
    { value: '0', label: 'Profiles (0)' },
    { value: '3', label: 'Contacts (3)' },
    { value: '6', label: 'Reposts (6)' },
    { value: '7', label: 'Reactions (7)' },
    { value: 'custom', label: 'Custom Kind' },
  ];

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">Events & Moderation</h2>
          <p className="text-muted-foreground">View and moderate events using NIP-86</p>
        </div>
        <Button onClick={() => refetch()} disabled={loadingEvents}>
          <RefreshCw className={`h-4 w-4 mr-2 ${loadingEvents ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="py-3 space-y-3">
          {/* Search Bar */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search by content or pubkey..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9 h-9"
            />
          </div>

          {/* Filter Row */}
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex-1 min-w-[150px]">
              <Label htmlFor="kind-filter" className="text-xs">Event Kind</Label>
              <Select value={kindFilter} onValueChange={setKindFilter}>
                <SelectTrigger className="mt-1 h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {kindOptions.map(option => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {kindFilter === 'custom' && (
              <div className="w-32">
                <Label htmlFor="custom-kind" className="text-xs">Kind #</Label>
                <Input
                  id="custom-kind"
                  type="number"
                  value={customKind}
                  onChange={(e) => setCustomKind(e.target.value)}
                  placeholder="Kind"
                  className="mt-1 h-9"
                />
              </div>
            )}

            <div className="w-24">
              <Label htmlFor="limit" className="text-xs">Limit</Label>
              <Select value={limit.toString()} onValueChange={(value) => setLimit(parseInt(value))}>
                <SelectTrigger className="mt-1 h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="10">10</SelectItem>
                  <SelectItem value="20">20</SelectItem>
                  <SelectItem value="50">50</SelectItem>
                  <SelectItem value="100">100</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Smart Filters */}
          <div className="flex flex-wrap gap-4">
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <Checkbox
                checked={filterHasReports}
                onCheckedChange={(checked) => setFilterHasReports(checked === true)}
              />
              <Flag className="h-4 w-4 text-muted-foreground" />
              Has reports
            </label>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <Checkbox
                checked={filterNewUsers}
                onCheckedChange={(checked) => setFilterNewUsers(checked === true)}
              />
              <UserPlus className="h-4 w-4 text-muted-foreground" />
              New users (&lt;7d)
            </label>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <Checkbox
                checked={filterHasMedia}
                onCheckedChange={(checked) => setFilterHasMedia(checked === true)}
              />
              <Image className="h-4 w-4 text-muted-foreground" />
              Has media
            </label>
          </div>

          {/* Active Pubkey Filter */}
          {filterByPubkey && (
            <div className="flex items-center gap-2 p-2 bg-muted rounded-lg">
              <span className="text-xs text-muted-foreground">Filtering by user:</span>
              <code className="text-xs font-mono">{filterByPubkey.slice(0, 16)}...</code>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2"
                onClick={() => updatePubkeyFilter(null)}
              >
                Clear
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Verification Status */}
      {(isVerifying || verificationResult) && (
        <Alert
          variant={verificationResult?.success ? "default" : "destructive"}
          className={verificationResult?.success ? "border-green-500/50 bg-green-500/10" : ""}
        >
          {isVerifying ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : verificationResult?.success ? (
            <CheckCircle className="h-4 w-4 text-green-600" />
          ) : (
            <XCircle className="h-4 w-4" />
          )}
          <AlertDescription className="flex items-center justify-between">
            <span>
              {isVerifying
                ? "Verifying moderation action..."
                : verificationResult?.message}
            </span>
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
          </AlertDescription>
        </Alert>
      )}

      {/* Split Pane Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4 h-[calc(100vh-280px)]">
        {/* Left Pane - Events List */}
        <Card className="lg:col-span-2">
          <CardHeader className="py-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-lg flex items-center gap-2">
                <FileText className="h-5 w-5" />
                Events
              </CardTitle>
              <div className="text-sm text-muted-foreground">
                {enhancedEvents.length} events
                {eventsNeedingModeration && eventsNeedingModeration.length > 0 && (
                  <Badge variant="secondary" className="ml-2 text-xs">
                    {eventsNeedingModeration.length} pending
                  </Badge>
                )}
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <ScrollArea className="h-[calc(100vh-380px)]">
              <div className="p-3">
                {loadingEvents ? (
                  <div className="space-y-2">
                    {[...Array(5)].map((_, i) => (
                      <Skeleton key={i} className="h-20 w-full" />
                    ))}
                  </div>
                ) : eventsError ? (
                  <Alert>
                    <AlertTriangle className="h-4 w-4" />
                    <AlertDescription>
                      Failed to load events: {eventsError.message}
                    </AlertDescription>
                  </Alert>
                ) : !enhancedEvents || enhancedEvents.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground">
                    <FileText className="h-8 w-8 mx-auto mb-2 opacity-50" />
                    <p className="text-sm">No events found</p>
                  </div>
                ) : (
                  <>
                    {enhancedEvents.map((event) => (
                      <EventCard
                        key={event.id}
                        event={event}
                        isSelected={selectedEvent?.id === event.id}
                        onSelect={() => setSelectedEvent(event)}
                        onModerate={handleModerateEvent}
                      />
                    ))}
                    {/* Infinite scroll trigger */}
                    <div ref={loadMoreRef} className="py-4 text-center">
                      {isFetchingNextPage ? (
                        <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
                          <RefreshCw className="h-4 w-4 animate-spin" />
                          Loading older events...
                        </div>
                      ) : hasNextPage ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => fetchNextPage()}
                          className="text-muted-foreground"
                        >
                          Load more
                        </Button>
                      ) : events.length > 0 ? (
                        <p className="text-xs text-muted-foreground">
                          End of events
                        </p>
                      ) : null}
                    </div>
                  </>
                )}
              </div>
            </ScrollArea>
          </CardContent>
        </Card>

        {/* Right Pane - Event Detail */}
        <Card className="lg:col-span-3 overflow-hidden">
          {selectedEvent ? (
            <EventDetail
              event={selectedEvent}
              onClose={() => setSelectedEvent(null)}
              onSelectEvent={(eventId) => {
                const found = enhancedEvents.find(e => e.id === eventId);
                if (found) setSelectedEvent(found);
              }}
              onSelectPubkey={(pubkey) => {
                updatePubkeyFilter(pubkey);
                setSelectedEvent(null);
              }}
            />
          ) : (
            <div className="h-full flex items-center justify-center text-muted-foreground">
              <div className="text-center">
                <FileText className="h-12 w-12 mx-auto mb-4 opacity-50" />
                <p>Select an event to view details</p>
              </div>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}