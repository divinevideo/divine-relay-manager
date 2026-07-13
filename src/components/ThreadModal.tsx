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
import { useAppContext } from "@/hooks/useAppContext";
import { MessageSquare, Globe } from "lucide-react";
import { getProfileUrl } from "@/lib/constants";
import { buildThreadReplyFilters } from "@/lib/threadFilters";
import { buildThreadTree, type ThreadNode } from "@/lib/threadTree";

interface ThreadModalProps {
  eventId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  highlightEventId?: string;
}

function ThreadPost({
  node,
  highlightId,
  apiUrl,
}: {
  node: ThreadNode;
  highlightId?: string;
  apiUrl?: string;
}) {
  const author = useAuthor(node.event.pubkey, apiUrl);
  const npubFallback = (() => {
    try {
      return nip19.npubEncode(node.event.pubkey).slice(0, 12) + '...';
    } catch {
      return node.event.pubkey.slice(0, 8) + '...';
    }
  })();
  const isFunnelcakeUser = author.data?.isFunnelcakeUser ?? false;
  const displayName = author.data?.metadata?.display_name || author.data?.metadata?.name || npubFallback;
  const avatar = author.data?.metadata?.picture;
  const date = new Date(node.event.created_at * 1000);
  const isHighlighted = node.event.id === highlightId;
  const profileUrl = (() => {
    try {
      return getProfileUrl(nip19.npubEncode(node.event.pubkey), isFunnelcakeUser);
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
              <a href={profileUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 hover:opacity-80">
                <span className="text-sm font-medium">{displayName}</span>
                {!isFunnelcakeUser && <Globe className="h-3 w-3 text-purple-500 shrink-0" />}
              </a>
              <span className="text-xs text-muted-foreground">
                {date.toLocaleString()}
              </span>
              {isHighlighted && (
                <Badge variant="destructive" className="text-xs">Reported</Badge>
              )}
            </div>
            <p className="text-sm mt-1 whitespace-pre-wrap break-all">
              {node.event.content}
            </p>
          </div>
        </div>
      </div>
      {node.replies.map(reply => (
        <ThreadPost key={reply.event.id} node={reply} highlightId={highlightId} apiUrl={apiUrl} />
      ))}
    </div>
  );
}

export function ThreadModal({ eventId, open, onOpenChange, highlightEventId }: ThreadModalProps) {
  const { nostr } = useNostr();
  const { config } = useAppContext();

  // Fetch full thread
  const { data: thread, isLoading } = useQuery({
    // Env key (apiUrl): singleton QueryClient + per-env NPool — without it a
    // reopen serves the other environment's thread until the refetch lands
    queryKey: ['full-thread', config.apiUrl, eventId],
    queryFn: async ({ signal }) => {
      const timeout = AbortSignal.timeout(10000);
      const combinedSignal = AbortSignal.any([signal, timeout]);

      // First get the target event to find root
      const [targetEvent] = await nostr.query(
        [{ ids: [eventId], limit: 1 }],
        { signal: combinedSignal }
      );

      if (!targetEvent) return null;

      // Root: NIP-10 `e root` when present, else the event itself (addressable
      // video reports have no NIP-10 root tag).
      const rootTag = targetEvent.tags.find(t => t[0] === 'e' && t[3] === 'root');
      const rootId = rootTag ? rootTag[1] : eventId;

      const [rootEvent] = await nostr.query(
        [{ ids: [rootId], limit: 1 }],
        { signal: combinedSignal }
      );
      const rootForFilters = rootEvent ?? targetEvent;

      // NIP-10 kind-1 replies + NIP-22 kind-1111 comments (scoped by root E/A) —
      // Divine comments are kind 1111, so kinds:[1] alone showed none (#164 B).
      const replies = await nostr.query(
        buildThreadReplyFilters(rootForFilters, 100),
        { signal: combinedSignal }
      );

      const allEvents = rootEvent ? [rootEvent, ...replies] : [targetEvent, ...replies];
      return buildThreadTree(allEvents, rootId);
    },
    enabled: open && !!eventId,
    // Reopening the modal is common while working a report; 30s keeps that
    // instant without refiring 3 relay round-trips, yet stays fresh enough
    // to pick up new comments on the next report visit
    staleTime: 30_000,
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-hidden">
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
            <ThreadPost node={thread} highlightId={highlightEventId || eventId} apiUrl={config.apiUrl} />
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
