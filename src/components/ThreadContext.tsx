// ABOUTME: Displays thread ancestry for a reported post (up to 3 levels)
// ABOUTME: Shows fetch status, graceful failure states, and external relay indicators

import { nip19 } from "nostr-tools";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useAuthor } from "@/hooks/useAuthor";
import {
  ExternalLink, ChevronDown, ChevronUp,
  AlertTriangle, Globe, Search, Ban, RefreshCw, ShieldX,
} from "lucide-react";
import { useState } from "react";
import type { NostrEvent } from "@nostrify/nostrify";
import { getProfileUrl } from "@/lib/constants";
import type { FetchSource } from "@/hooks/useThread";

interface ThreadContextProps {
  ancestors: NostrEvent[];
  reportedEvent: NostrEvent | null;
  onViewFullThread?: () => void;
  isLoading?: boolean;
  /** True when checking the relay's ban list for the event (secondary check) */
  isCheckingBanned?: boolean;
  apiUrl?: string;
  /** Where the event was fetched from */
  fetchSource?: FetchSource | null;
  /** External relay that was tried (shown when event not found) */
  triedExternalRelay?: string;
  /** Report tags for fallback display when event is unavailable */
  reportTags?: string[][];
  /** Target event ID from the report */
  targetEventId?: string;
  /** True when the event is known to be deleted from the relay */
  isEventDeleted?: boolean;
  /** True when the user is known to be banned from the relay */
  isUserBanned?: boolean;
  /** When the moderation status was last verified */
  checkedAt?: Date | null;
  /** Callback to re-check moderation status */
  onRecheck?: () => void;
  /** True when a re-check is in progress */
  isRechecking?: boolean;
}

// NIP-71 video kinds. Divine primarily uses 34235 (addressable video),
// but we check all video kinds to handle edge cases.
const VIDEO_KINDS = [21, 22, 34235, 34236];

function PostCard({
  event,
  isReported = false,
  depth = 0,
  apiUrl,
}: {
  event: NostrEvent;
  isReported?: boolean;
  depth?: number;
  apiUrl?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const author = useAuthor(event.pubkey, apiUrl);
  const npubFallback = (() => {
    try {
      return nip19.npubEncode(event.pubkey).slice(0, 12) + '...';
    } catch {
      return event.pubkey.slice(0, 8) + '...';
    }
  })();
  const isFunnelcakeUser = author.data?.isFunnelcakeUser ?? false;
  const displayName = author.data?.metadata?.display_name || author.data?.metadata?.name || npubFallback;
  const avatar = author.data?.metadata?.picture;
  const date = new Date(event.created_at * 1000);
  const profileUrl = (() => {
    try {
      return getProfileUrl(nip19.npubEncode(event.pubkey), isFunnelcakeUser);
    } catch {
      return undefined;
    }
  })();
  const isLong = event.content.length > 500;

  return (
    <div
      className={`relative ${depth > 0 ? 'ml-6 border-l-2 border-muted pl-4' : ''}`}
    >
      <Card className={`overflow-hidden ${isReported ? 'border-destructive bg-destructive/5' : ''}`}>
        <CardContent className="p-3 overflow-hidden">
          <div className="flex items-start gap-3">
            <a href={profileUrl} target="_blank" rel="noopener noreferrer" className="hover:opacity-80 shrink-0">
              <Avatar className="h-8 w-8">
                <AvatarImage src={avatar} />
                <AvatarFallback>{displayName.slice(0, 2).toUpperCase()}</AvatarFallback>
              </Avatar>
            </a>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <a href={profileUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 hover:opacity-80">
                  <span className="font-medium text-sm">{displayName}</span>
                  {!isFunnelcakeUser && <Globe className="h-3 w-3 text-purple-500 shrink-0" />}
                </a>
                <span className="text-xs text-muted-foreground">
                  {date.toLocaleDateString()} {date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
                {isReported && (
                  <Badge variant="destructive" className="text-xs">Reported</Badge>
                )}
              </div>
              <div className="text-sm mt-1 whitespace-pre-wrap break-words overflow-hidden">
                {isLong && !expanded ? (
                  <>
                    {event.content.slice(0, 500)}
                    {' ... '}
                    <button
                      className="text-blue-500 hover:underline inline-flex items-center gap-1"
                      onClick={() => setExpanded(true)}
                    >
                      <span>Show more</span>
                      <ChevronDown className="h-3 w-3" />
                    </button>
                  </>
                ) : isLong && expanded ? (
                  <>
                    {event.content}
                    {' '}
                    <button
                      className="text-blue-500 hover:underline inline-flex items-center gap-1"
                      onClick={() => setExpanded(false)}
                    >
                      <span>Show less</span>
                      <ChevronUp className="h-3 w-3" />
                    </button>
                  </>
                ) : (
                  event.content
                )}
              </div>
              {!isReported && (
                <a
                  href={`https://divine.video/${nip19.neventEncode({ id: event.id })}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1 mt-1"
                >
                  {VIDEO_KINDS.includes(event.kind) ? 'View video' : 'View'} on Divine
                  <ExternalLink className="h-3 w-3" />
                </a>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

/** Show what we know from the report tags when the event itself is unavailable */
function ReportTagsFallback({ reportTags, targetEventId }: { reportTags?: string[][], targetEventId?: string }) {
  if (!reportTags || reportTags.length === 0) return null;

  const eTag = reportTags.find(t => t[0] === 'e');
  const pTag = reportTags.find(t => t[0] === 'p');
  const relayHint = eTag?.[2] && (eTag[2].startsWith('wss://') || eTag[2].startsWith('ws://')) ? eTag[2] : null;
  const marker = eTag?.[2] && !eTag[2].startsWith('ws') ? eTag[2] : eTag?.[3];
  const reportedPubkey = pTag?.[1];

  return (
    <Card className="border-amber-200 bg-amber-50/50 dark:bg-amber-950/20">
      <CardContent className="p-3 space-y-2">
        <div className="text-sm font-medium text-amber-800 dark:text-amber-300">
          Information from report
        </div>
        <div className="text-xs space-y-1 text-muted-foreground overflow-hidden">
          {targetEventId && (
            <div className="flex items-center gap-2 min-w-0">
              <span className="font-medium w-20 shrink-0">Event ID:</span>
              <code className="bg-muted px-1 rounded truncate min-w-0">{targetEventId}</code>
            </div>
          )}
          {reportedPubkey && (
            <div className="flex items-center gap-2 min-w-0">
              <span className="font-medium w-20 shrink-0">Author:</span>
              <code className="bg-muted px-1 rounded truncate min-w-0">
                {(() => { try { return nip19.npubEncode(reportedPubkey); } catch { return reportedPubkey; } })()}
              </code>
            </div>
          )}
          {relayHint && (
            <div className="flex items-center gap-2 min-w-0">
              <span className="font-medium w-20 shrink-0">Relay hint:</span>
              <code className="bg-muted px-1 rounded truncate min-w-0">{relayHint}</code>
            </div>
          )}
          {marker && (
            <div className="flex items-center gap-2">
              <span className="font-medium w-20 shrink-0">Category:</span>
              <Badge variant="outline" className="text-xs">{marker}</Badge>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export function ThreadContext({
  ancestors,
  reportedEvent,
  onViewFullThread,
  isLoading,
  apiUrl,
  isCheckingBanned,
  fetchSource,
  triedExternalRelay,
  reportTags,
  targetEventId,
  isEventDeleted,
  isUserBanned,
  checkedAt,
  onRecheck,
  isRechecking,
}: ThreadContextProps) {
  if (isLoading) {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Search className="h-4 w-4 animate-pulse" />
          <span>
            Searching for reported content
            {triedExternalRelay ? <span className="text-xs"> (including {triedExternalRelay})</span> : ''}
          </span>
        </div>
        <div className="h-1 w-full rounded-full bg-muted overflow-hidden">
          <div className="h-full w-1/3 rounded-full bg-primary/40 animate-barber-pole" />
        </div>
      </div>
    );
  }

  if (!reportedEvent) {
    if (isCheckingBanned) {
      return (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Search className="h-4 w-4 animate-pulse" />
            <span>Not found in normal queries. Checking moderation status...</span>
          </div>
          <div className="h-1 w-full rounded-full bg-muted overflow-hidden">
            <div className="h-full w-1/3 rounded-full bg-primary/40 animate-barber-pole" />
          </div>
        </div>
      );
    }

    if (isEventDeleted || isUserBanned || checkedAt) {
      return (
        <div className="space-y-3">
          {/* Moderation status results */}
          <div className="rounded-md border bg-muted/30 p-3 space-y-2">
            {isEventDeleted && (
              <div className="flex items-center gap-2 p-2 rounded bg-green-100 dark:bg-green-950/50">
                <ShieldX className="h-4 w-4 text-green-600 shrink-0" />
                <span className="text-sm font-medium text-green-700 dark:text-green-400">
                  Event has been deleted from the relay
                </span>
              </div>
            )}
            {isUserBanned && (
              <div className="flex items-center gap-2 p-2 rounded bg-green-100 dark:bg-green-950/50">
                <Ban className="h-4 w-4 text-green-600 shrink-0" />
                <span className="text-sm font-medium text-green-700 dark:text-green-400">
                  User is banned on the relay
                </span>
              </div>
            )}
            {checkedAt && !isEventDeleted && !isUserBanned && (
              <div className="flex items-center gap-2 p-2 rounded bg-yellow-100 dark:bg-yellow-950/50">
                <AlertTriangle className="h-4 w-4 text-yellow-600 shrink-0" />
                <span className="text-sm font-medium text-yellow-700 dark:text-yellow-400">
                  Event not found on relay. User is not banned.
                </span>
              </div>
            )}
            <div className="flex items-center justify-between">
              {checkedAt && (
                <span className="text-xs text-muted-foreground">
                  Checked: {checkedAt.toLocaleTimeString()}
                </span>
              )}
              {onRecheck && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onRecheck}
                  disabled={isRechecking}
                  className="h-6 text-xs px-2"
                >
                  <RefreshCw className={`h-3 w-3 mr-1 ${isRechecking ? 'animate-spin' : ''}`} />
                  {isRechecking ? 'Checking...' : 'Re-check'}
                </Button>
              )}
            </div>
          </div>
          <ReportTagsFallback reportTags={reportTags} targetEventId={targetEventId} />
        </div>
      );
    }

    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-amber-50 border border-amber-200 dark:bg-amber-950/30 dark:border-amber-800">
          <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0" />
          <div className="text-sm">
            <span className="font-medium text-amber-800 dark:text-amber-300">
              Content not found.
            </span>
            <span className="text-amber-700/80 dark:text-amber-400/80">
              {' '}Searched our relay{triedExternalRelay ? ` and ${triedExternalRelay}` : ''}.
              The event may have been deleted or may only exist on relays we can't reach.
            </span>
          </div>
        </div>
        <ReportTagsFallback reportTags={reportTags} targetEventId={targetEventId} />
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <h4 className="text-sm font-medium text-muted-foreground">Thread Context</h4>
          {fetchSource === 'external-relay' && (
            <Badge variant="outline" className="text-xs gap-1 text-blue-600 border-blue-300">
              <Globe className="h-3 w-3" />
              External relay
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-1">
          {onViewFullThread && (
            <Button variant="ghost" size="sm" onClick={onViewFullThread}>
              <ExternalLink className="h-3 w-3 mr-1" />
              View Full Thread
            </Button>
          )}
        </div>
      </div>

      {ancestors.map((event, index) => (
        <PostCard key={event.id} event={event} depth={index} apiUrl={apiUrl} />
      ))}

      <PostCard
        event={reportedEvent}
        isReported
        depth={ancestors.length}
        apiUrl={apiUrl}
      />
    </div>
  );
}
