// ABOUTME: Displays preview of a user's profile by pubkey for moderation review
// ABOUTME: Shows profile picture, name, bio, and recent activity

import { useAuthor } from "@/hooks/useAuthor";
import { useQuery } from "@tanstack/react-query";
import { useNostr } from "@nostrify/react";
import { Card, CardContent } from "@/components/ui/card";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { User, Bot, Calendar, MessageSquare, AlertTriangle } from "lucide-react";
import { nip19 } from "nostr-tools";

interface UserProfilePreviewProps {
  pubkey: string;
  className?: string;
}

export function UserProfilePreview({ pubkey, className }: UserProfilePreviewProps) {
  const { nostr } = useNostr();
  const { data: author, isLoading: loadingProfile } = useAuthor(pubkey);

  // Fetch recent activity (kind 1 notes)
  const { data: recentNotes, isLoading: loadingNotes } = useQuery({
    queryKey: ['user-recent-notes', pubkey],
    queryFn: async ({ signal }) => {
      const events = await nostr.query(
        [{ kinds: [1], authors: [pubkey], limit: 5 }],
        { signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) }
      );
      return events.sort((a, b) => b.created_at - a.created_at);
    },
    staleTime: 5 * 60 * 1000,
  });

  const metadata = author?.metadata;
  const npub = nip19.npubEncode(pubkey);
  const isBot = metadata?.bot;

  if (loadingProfile) {
    return (
      <Card className={`bg-muted/50 ${className}`}>
        <CardContent className="p-4">
          <div className="flex items-start gap-3">
            <Skeleton className="h-12 w-12 rounded-full" />
            <div className="space-y-2 flex-1">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-48" />
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  const displayName = metadata?.display_name || metadata?.name || `${npub.slice(0, 12)}...`;

  return (
    <Card className={`bg-muted/50 ${className}`}>
      <CardContent className="p-4 space-y-4">
        {/* Profile header */}
        <div className="flex items-start gap-3">
          <Avatar className="h-12 w-12">
            {metadata?.picture && (
              <AvatarImage src={metadata.picture} alt={displayName} />
            )}
            <AvatarFallback>
              {isBot ? <Bot className="h-5 w-5" /> : <User className="h-5 w-5" />}
            </AvatarFallback>
          </Avatar>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h4 className="font-semibold truncate">{displayName}</h4>
              {isBot && (
                <Badge variant="secondary" className="text-xs">
                  <Bot className="h-3 w-3 mr-1" />
                  Bot
                </Badge>
              )}
            </div>
            {metadata?.nip05 && (
              <p className="text-sm text-muted-foreground truncate">{metadata.nip05}</p>
            )}
            <p className="text-xs text-muted-foreground font-mono mt-1 truncate">
              {npub.slice(0, 20)}...
            </p>
          </div>
        </div>

        {/* Bio */}
        {metadata?.about && (
          <p className="text-sm whitespace-pre-wrap break-words">
            {metadata.about.length > 300 ? `${metadata.about.slice(0, 300)}...` : metadata.about}
          </p>
        )}

        {/* Recent activity */}
        {recentNotes && recentNotes.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <MessageSquare className="h-3 w-3" />
              <span>Recent posts:</span>
            </div>
            <div className="space-y-2">
              {recentNotes.slice(0, 3).map((note) => (
                <div key={note.id} className="bg-background/50 p-2 rounded text-sm">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
                    <Calendar className="h-3 w-3" />
                    {new Date(note.created_at * 1000).toLocaleString()}
                  </div>
                  <p className="break-words">
                    {note.content.length > 150 ? `${note.content.slice(0, 150)}...` : note.content}
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* No recent activity */}
        {recentNotes && recentNotes.length === 0 && (
          <div className="text-sm text-muted-foreground italic flex items-center gap-2">
            <AlertTriangle className="h-4 w-4" />
            No recent posts found
          </div>
        )}
      </CardContent>
    </Card>
  );
}
