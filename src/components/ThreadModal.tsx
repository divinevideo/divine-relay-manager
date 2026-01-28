// ABOUTME: Modal dialog showing the complete thread for a reported event
// ABOUTME: Displays full conversation with nested replies

import { nip19 } from "nostr-tools";
import { useNostr } from "@nostrify/react";
import { useQuery } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuthor } from "@/hooks/useAuthor";
import { MessageSquare } from "lucide-react";
import type { NostrEvent } from "@nostrify/nostrify";

interface ThreadModalProps {
  eventId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  highlightEventId?: string;
}

interface ThreadNode {
  event: NostrEvent;
  replies: ThreadNode[];
  depth: number;
}

function buildThreadTree(events: NostrEvent[], rootId: string): ThreadNode | null {
  const eventMap = new Map<string, NostrEvent>();
  events.forEach(e => eventMap.set(e.id, e));

  const root = eventMap.get(rootId);
  if (!root) return null;

  function buildNode(event: NostrEvent, depth: number): ThreadNode {
    const replies = events
      .filter(e => {
        const replyTag = e.tags.find(t => t[0] === 'e' && (t[3] === 'reply' || !t[3]));
        return replyTag && replyTag[1] === event.id;
      })
      .map(e => buildNode(e, depth + 1))
      .sort((a, b) => a.event.created_at - b.event.created_at);

    return { event, replies, depth };
  }

  return buildNode(root, 0);
}

function ThreadPost({
  node,
  highlightId
}: {
  node: ThreadNode;
  highlightId?: string;
}) {
  const author = useAuthor(node.event.pubkey);
  const npubFallback = (() => {
    try {
      return nip19.npubEncode(node.event.pubkey).slice(0, 12) + '...';
    } catch {
      return node.event.pubkey.slice(0, 8) + '...';
    }
  })();
  const displayName = author.data?.metadata?.display_name || author.data?.metadata?.name || npubFallback;
  const avatar = author.data?.metadata?.picture;
  const date = new Date(node.event.created_at * 1000);
  const isHighlighted = node.event.id === highlightId;
  const profileUrl = (() => {
    try {
      return `https://divine.video/profile/${nip19.npubEncode(node.event.pubkey)}`;
    } catch {
      return undefined;
    }
  })();

  return (
    <div className={`${node.depth > 0 ? 'ml-4 border-l-2 border-muted pl-3' : ''}`}>
      <div
        className={`p-3 rounded-lg mb-2 ${
          isHighlighted
            ? 'bg-destructive/10 border border-destructive'
            : 'bg-muted/50'
        }`}
      >
        <div className="flex items-start gap-2">
          <a href={profileUrl} target="_blank" rel="noopener noreferrer" className="hover:opacity-80 shrink-0">
            <Avatar className="h-6 w-6">
              <AvatarImage src={avatar} />
              <AvatarFallback className="text-xs">
                {displayName.slice(0, 2).toUpperCase()}
              </AvatarFallback>
            </Avatar>
          </a>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <a href={profileUrl} target="_blank" rel="noopener noreferrer" className="hover:opacity-80">
                <span className="text-sm font-medium">{displayName}</span>
              </a>
              <span className="text-xs text-muted-foreground">
                {date.toLocaleString()}
              </span>
              {isHighlighted && (
                <Badge variant="destructive" className="text-xs">Reported</Badge>
              )}
            </div>
            <p className="text-sm mt-1 whitespace-pre-wrap break-words">
              {node.event.content}
            </p>
          </div>
        </div>
      </div>
      {node.replies.map(reply => (
        <ThreadPost key={reply.event.id} node={reply} highlightId={highlightId} />
      ))}
    </div>
  );
}

export function ThreadModal({ eventId, open, onOpenChange, highlightEventId }: ThreadModalProps) {
  const { nostr } = useNostr();

  // Fetch full thread
  const { data: thread, isLoading } = useQuery({
    queryKey: ['full-thread', eventId],
    queryFn: async ({ signal }) => {
      const timeout = AbortSignal.timeout(10000);
      const combinedSignal = AbortSignal.any([signal, timeout]);

      // First get the target event to find root
      const [targetEvent] = await nostr.query(
        [{ ids: [eventId], limit: 1 }],
        { signal: combinedSignal }
      );

      if (!targetEvent) return null;

      // Find root event ID
      const rootTag = targetEvent.tags.find(t => t[0] === 'e' && t[3] === 'root');
      const rootId = rootTag ? rootTag[1] : eventId;

      // Fetch all events in thread
      const [rootEvent] = await nostr.query(
        [{ ids: [rootId], limit: 1 }],
        { signal: combinedSignal }
      );

      const replies = await nostr.query(
        [{ kinds: [1], '#e': [rootId], limit: 100 }],
        { signal: combinedSignal }
      );

      const allEvents = rootEvent ? [rootEvent, ...replies] : replies;
      return buildThreadTree(allEvents, rootId);
    },
    enabled: open && !!eventId,
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MessageSquare className="h-5 w-5" />
            Full Thread
          </DialogTitle>
        </DialogHeader>
        <ScrollArea className="h-[60vh] pr-4">
          {isLoading ? (
            <div className="space-y-3">
              {[...Array(5)].map((_, i) => (
                <Skeleton key={i} className="h-20 w-full" />
              ))}
            </div>
          ) : thread ? (
            <ThreadPost node={thread} highlightId={highlightEventId || eventId} />
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              <p>Could not load thread</p>
            </div>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
