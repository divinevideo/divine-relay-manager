// ABOUTME: Displays preview of a user's profile by pubkey for moderation review
// ABOUTME: Shows profile picture, name, bio, and recent activity

import { useAuthor } from "@/hooks/useAuthor";
import { useQuery } from "@tanstack/react-query";
import { useNostr } from "@nostrify/react";
import { Card, CardContent } from "@/components/ui/card";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { User, Bot, Calendar, MessageSquare, AlertTriangle, Globe, ExternalLink, Video, Info } from "lucide-react";
import { nip19 } from "nostr-tools";
import { getProfileUrl } from "@/lib/constants";

interface UserProfilePreviewProps {
  pubkey: string;
  className?: string;
}

export function UserProfilePreview({ pubkey, className }: UserProfilePreviewProps) {
  const { nostr } = useNostr();
  const { data: author, isLoading: loadingProfile } = useAuthor(pubkey);

  // Fetch recent activity: videos, comments, and text notes
  const { data: recentContent, isLoading: _loadingContent } = useQuery({
    queryKey: ['user-recent-content', pubkey],
    queryFn: async ({ signal }) => {
      const timeout = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
      const events = await nostr.query(
        [{ kinds: [1, 1111, 34235, 34236], authors: [pubkey], limit: 10 }],
        { signal: timeout }
      );
      return events.sort((a, b) => b.created_at - a.created_at).slice(0, 5);
    },
    staleTime: 5 * 60 * 1000,
  });

  const metadata = author?.metadata;
  const isFunnelcakeUser = author?.isFunnelcakeUser ?? false;
  const npub = nip19.npubEncode(pubkey);
  const isBot = metadata?.bot;
  const profileUrl = getProfileUrl(npub, isFunnelcakeUser);

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
          <a href={profileUrl} target="_blank" rel="noopener noreferrer" className="hover:opacity-80 shrink-0">
            <Avatar className="h-12 w-12">
              {metadata?.picture && (
                <AvatarImage src={metadata.picture} alt={displayName} />
              )}
              <AvatarFallback>
                {isBot ? <Bot className="h-5 w-5" /> : <User className="h-5 w-5" />}
              </AvatarFallback>
            </Avatar>
          </a>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <a href={profileUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 hover:opacity-80">
                <h4 className="font-semibold truncate">{displayName}</h4>
              </a>
              {isFunnelcakeUser ? (
                <a href={profileUrl} target="_blank" rel="noopener noreferrer" className="hover:opacity-80">
                  <Badge variant="outline" className="text-xs text-green-600 border-green-300 bg-green-50">Divine</Badge>
                </a>
              ) : (
                <a href={profileUrl} target="_blank" rel="noopener noreferrer" className="hover:opacity-80">
                  <Badge variant="outline" className="text-xs text-purple-600 border-purple-300 bg-purple-50 gap-1">
                    <Globe className="h-3 w-3" />Nostr
                  </Badge>
                </a>
              )}
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
        {recentContent && recentContent.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <MessageSquare className="h-3 w-3" />
              <span>Recent content on relay:</span>
            </div>
            <div className="space-y-2">
              {recentContent.map((event) => {
                const isVideo = event.kind === 34235 || event.kind === 34236;
                const isComment = event.kind === 1111;
                const isNote = event.kind === 1;
                const kindLabel = isVideo ? 'Video' : isComment ? 'Comment' : 'Note';
                const eventUrl = (() => {
                  try {
                    return isVideo
                      ? `https://divine.video/${nip19.naddrEncode({ identifier: event.tags.find(t => t[0] === 'd')?.[1] || '', pubkey: event.pubkey, kind: event.kind })}`
                      : `https://njump.me/${nip19.neventEncode({ id: event.id })}`;
                  } catch { return undefined; }
                })();
                return (
                  <div key={event.id} className="bg-background/50 p-2 rounded text-sm">
                    <div className="flex items-center justify-between mb-1">
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Calendar className="h-3 w-3" />
                        {new Date(event.created_at * 1000).toLocaleString()}
                      </div>
                      <div className="flex items-center gap-1.5">
                        {eventUrl && (
                          <a href={eventUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-600 hover:underline inline-flex items-center gap-0.5">
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        )}
                        {isVideo ? (
                          <Badge variant="default" className="text-xs gap-1 bg-green-600"><Video className="h-3 w-3" />Video</Badge>
                        ) : (
                          <Badge variant="outline" className="text-xs gap-1 text-amber-600 border-amber-300 bg-amber-50">
                            {isComment ? <MessageSquare className="h-3 w-3" /> : <Globe className="h-3 w-3" />}
                            {kindLabel}
                          </Badge>
                        )}
                      </div>
                    </div>
                    <p className="break-words">
                      {event.content.length > 150 ? `${event.content.slice(0, 150)}...` : event.content}
                    </p>
                    {isNote && (
                      <p className="text-xs text-amber-600 mt-1 flex items-center gap-1">
                        <Info className="h-3 w-3 shrink-0" />
                        Text note — not visible in Divine apps
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* No recent activity */}
        {recentContent && recentContent.length === 0 && (
          <div className="text-sm text-muted-foreground italic flex items-center gap-2">
            <AlertTriangle className="h-4 w-4" />
            No recent content found on relay
          </div>
        )}
      </CardContent>
    </Card>
  );
}
