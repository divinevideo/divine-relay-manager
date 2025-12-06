// ABOUTME: Displays thread ancestry for a reported post (up to 3 levels)
// ABOUTME: Shows grandparent -> parent -> reported post with visual hierarchy

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuthor } from "@/hooks/useAuthor";
import { MessageSquare, ExternalLink } from "lucide-react";
import type { NostrEvent } from "@nostrify/nostrify";

interface ThreadContextProps {
  ancestors: NostrEvent[];
  reportedEvent: NostrEvent | null;
  onViewFullThread?: () => void;
  isLoading?: boolean;
}

function PostCard({
  event,
  isReported = false,
  depth = 0
}: {
  event: NostrEvent;
  isReported?: boolean;
  depth?: number;
}) {
  const author = useAuthor(event.pubkey);
  const displayName = author.data?.metadata?.name || event.pubkey.slice(0, 8) + '...';
  const avatar = author.data?.metadata?.picture;
  const date = new Date(event.created_at * 1000);

  return (
    <div
      className={`relative ${depth > 0 ? 'ml-6 border-l-2 border-muted pl-4' : ''}`}
    >
      <Card className={isReported ? 'border-destructive bg-destructive/5' : ''}>
        <CardContent className="p-3">
          <div className="flex items-start gap-3">
            <Avatar className="h-8 w-8">
              <AvatarImage src={avatar} />
              <AvatarFallback>{displayName.slice(0, 2).toUpperCase()}</AvatarFallback>
            </Avatar>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-medium text-sm">{displayName}</span>
                <span className="text-xs text-muted-foreground">
                  {date.toLocaleDateString()} {date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
                {isReported && (
                  <Badge variant="destructive" className="text-xs">Reported</Badge>
                )}
              </div>
              <p className="text-sm mt-1 whitespace-pre-wrap break-words">
                {event.content.slice(0, 500)}
                {event.content.length > 500 && '...'}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export function ThreadContext({
  ancestors,
  reportedEvent,
  onViewFullThread,
  isLoading
}: ThreadContextProps) {
  if (isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full ml-6" />
        <Skeleton className="h-24 w-full ml-12" />
      </div>
    );
  }

  if (!reportedEvent) {
    return (
      <div className="text-center py-8 text-muted-foreground">
        <MessageSquare className="h-8 w-8 mx-auto mb-2 opacity-50" />
        <p className="text-sm">No event content available</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between mb-3">
        <h4 className="text-sm font-medium text-muted-foreground">Thread Context</h4>
        {onViewFullThread && (
          <Button variant="ghost" size="sm" onClick={onViewFullThread}>
            <ExternalLink className="h-3 w-3 mr-1" />
            View Full Thread
          </Button>
        )}
      </div>

      {ancestors.map((event, index) => (
        <PostCard key={event.id} event={event} depth={index} />
      ))}

      <PostCard
        event={reportedEvent}
        isReported
        depth={ancestors.length}
      />
    </div>
  );
}
