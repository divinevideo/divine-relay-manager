// ABOUTME: Displays user profile with stats, labels, and recent posts
// ABOUTME: Used in report detail view to show reported user context

import { useState } from "react";
import { nip19 } from "nostr-tools";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { User, FileText, Flag, Tag, CheckCircle, ChevronDown, ChevronUp, Copy, Check, ArrowUpRight, Trash2, Globe, ExternalLink, Video, MessageSquare } from "lucide-react";
import { InlineMediaPreview } from "@/components/MediaPreview";
import type { NostrEvent, NostrMetadata } from "@nostrify/nostrify";
import type { UserStats } from "@/hooks/useUserStats";
import { getProfileUrl } from "@/lib/constants";

// Label category colors
const LABEL_COLORS: Record<string, string> = {
  spam: 'bg-yellow-500',
  hate: 'bg-red-500',
  harassment: 'bg-orange-500',
  csam: 'bg-purple-900',
  violence: 'bg-red-700',
  scam: 'bg-amber-600',
  impersonation: 'bg-blue-500',
  default: 'bg-gray-500',
};

function getLabelColor(label: string): string {
  const lower = label.toLowerCase();
  for (const [key, color] of Object.entries(LABEL_COLORS)) {
    if (lower.includes(key)) return color;
  }
  return LABEL_COLORS.default;
}


interface UserProfileCardProps {
  profile?: NostrMetadata;
  pubkey?: string | null;
  stats?: UserStats;
  isLoading?: boolean;
  onDeleteEvent?: (eventId: string) => void;
  isFunnelcakeUser?: boolean;
}

export function UserProfileCard({ profile, pubkey, stats, isLoading, onDeleteEvent, isFunnelcakeUser = false }: UserProfileCardProps) {
  const [copied, setCopied] = useState(false);

  // Convert hex pubkey to npub
  let npub = "";
  if (pubkey) {
    try {
      npub = nip19.npubEncode(pubkey);
    } catch {
      npub = pubkey;
    }
  }

  const handleCopy = async () => {
    if (!npub) return;
    try {
      await navigator.clipboard.writeText(npub);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  };

  if (isLoading) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-3">
            <Skeleton className="h-12 w-12 rounded-full" />
            <div className="space-y-2">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-24" />
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-8 w-full" />
        </CardContent>
      </Card>
    );
  }

  if (!pubkey) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-muted-foreground">
          <User className="h-8 w-8 mx-auto mb-2 opacity-50" />
          <p className="text-sm">No user information available</p>
        </CardContent>
      </Card>
    );
  }

  const hasProfile = !!(profile?.display_name || profile?.name);
  const displayName = profile?.display_name || profile?.name || npub;
  const nip05 = profile?.nip05;
  const profileUrl = getProfileUrl(npub, isFunnelcakeUser);

  // Extract unique labels from label events
  const labelCounts = new Map<string, number>();
  stats?.existingLabels?.forEach(event => {
    const lTag = event.tags.find(t => t[0] === 'l');
    if (lTag) {
      const label = lTag[1];
      labelCounts.set(label, (labelCounts.get(label) || 0) + 1);
    }
  });

  return (
    <Card className="overflow-hidden">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-3 min-w-0 overflow-hidden">
          <a href={profileUrl} target="_blank" rel="noopener noreferrer" className="hover:opacity-80 shrink-0">
            <Avatar className="h-12 w-12">
              <AvatarImage src={profile?.picture} />
              <AvatarFallback>{displayName.slice(0, 2).toUpperCase()}</AvatarFallback>
            </Avatar>
          </a>
          <div className="flex-1 min-w-0 overflow-hidden">
            <div className="flex items-center gap-2 min-w-0 overflow-hidden">
              <a href={profileUrl} target="_blank" rel="noopener noreferrer" className="hover:opacity-80 min-w-0 overflow-hidden">
                <CardTitle className="text-base flex items-center gap-1 min-w-0">
                  <span className="truncate min-w-0">{displayName}</span>
                  <ArrowUpRight className="h-3 w-3 text-muted-foreground shrink-0" />
                </CardTitle>
              </a>
              {isFunnelcakeUser ? (
                <a href={profileUrl} target="_blank" rel="noopener noreferrer">
                  <Badge variant="outline" className="text-xs text-green-600 border-green-300 bg-green-50 shrink-0">Divine</Badge>
                </a>
              ) : (
                <a href={profileUrl} target="_blank" rel="noopener noreferrer">
                  <Badge variant="outline" className="text-xs text-purple-600 border-purple-300 bg-purple-50 gap-1 shrink-0">
                    <Globe className="h-3 w-3" />Nostr
                  </Badge>
                </a>
              )}
            </div>
            {nip05 && (
              <div className="flex items-center gap-1 text-sm text-muted-foreground min-w-0">
                <CheckCircle className="h-3 w-3 text-green-500 shrink-0" />
                <span className="truncate min-w-0">{nip05}</span>
              </div>
            )}
            <div className="flex items-center gap-1 min-w-0">
              <code className="text-xs text-muted-foreground font-mono block truncate min-w-0 flex-1">
                {npub}
              </code>
              <Button
                variant="ghost"
                size="icon"
                className="h-5 w-5 shrink-0"
                onClick={handleCopy}
                title="Copy npub"
              >
                {copied ? (
                  <Check className="h-3 w-3 text-green-500" />
                ) : (
                  <Copy className="h-3 w-3" />
                )}
              </Button>
            </div>
            {!hasProfile && (
              <p className="text-xs text-muted-foreground italic">No profile published to this relay</p>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {profile?.about && (
          <p className="text-sm text-muted-foreground line-clamp-3 break-all">
            {profile.about}
          </p>
        )}

        {/* Stats */}
        <div className="flex gap-4 text-sm">
          <div className="flex items-center gap-1">
            <FileText className="h-4 w-4 text-muted-foreground" />
            <span>{stats?.postCount || 0} posts</span>
          </div>
          <div className="flex items-center gap-1">
            <Flag className="h-4 w-4 text-muted-foreground" />
            <span>{stats?.reportCount || 0} reports</span>
          </div>
          <div className="flex items-center gap-1">
            <Tag className="h-4 w-4 text-muted-foreground" />
            <span>{stats?.labelCount || 0} labels</span>
          </div>
        </div>

        {/* Existing Labels */}
        {labelCounts.size > 0 && (
          <div className="space-y-2">
            <h5 className="text-xs font-medium text-muted-foreground uppercase">Existing Labels</h5>
            <div className="flex flex-wrap gap-1">
              {Array.from(labelCounts.entries()).map(([label, count]) => (
                <Badge
                  key={label}
                  variant="secondary"
                  className={`${getLabelColor(label)} text-white text-xs`}
                >
                  {label} ({count})
                </Badge>
              ))}
            </div>
          </div>
        )}

        {/* Recent Posts */}
        {stats?.recentPosts && stats.recentPosts.length > 0 && (
          <RecentPostsSection posts={stats.recentPosts} onDeleteEvent={onDeleteEvent} />
        )}
      </CardContent>
    </Card>
  );
}

// Separate component for recent posts with expand/collapse
function RecentPostsSection({ posts, onDeleteEvent }: { posts: NostrEvent[]; onDeleteEvent?: (eventId: string) => void }) {
  const [expanded, setExpanded] = useState(true);
  const [showAll, setShowAll] = useState(false);

  const visiblePosts = showAll ? posts : posts.slice(0, 5);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h5 className="text-xs font-medium text-muted-foreground uppercase flex items-center gap-2">
          <FileText className="h-3 w-3" />
          Recent Content on Relay ({posts.length})
        </h5>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
        </Button>
      </div>

      {expanded && (
        <div className="space-y-3">
          {visiblePosts.map(post => {
            return (
              <div key={post.id} className="p-3 bg-muted rounded-lg space-y-2 overflow-hidden">
                {/* Post content */}
                {post.content && (
                  <p className="text-sm whitespace-pre-wrap break-all line-clamp-4">
                    {post.content}
                  </p>
                )}

                {/* Media preview - uses InlineMediaPreview for admin proxy fallback */}
                <InlineMediaPreview content={post.content} tags={post.tags} />

                {/* Timestamp, kind, link, and delete */}
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>{new Date(post.created_at * 1000).toLocaleString()}</span>
                  <div className="flex items-center gap-1.5">
                    {(() => {
                      try {
                        const eventUrl = (post.kind === 34235 || post.kind === 34236)
                          ? `https://divine.video/${nip19.naddrEncode({ identifier: post.tags.find(t => t[0] === 'd')?.[1] || '', pubkey: post.pubkey, kind: post.kind })}`
                          : `https://njump.me/${nip19.neventEncode({ id: post.id })}`;
                        return (
                          <a href={eventUrl} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:text-blue-800">
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        );
                      } catch { return null; }
                    })()}
                    {(post.kind === 34235 || post.kind === 34236) ? (
                      <Badge variant="default" className="text-xs gap-1 bg-green-600" title="Short-form video — visible in Divine apps"><Video className="h-3 w-3" />Video</Badge>
                    ) : post.kind === 1111 ? (
                      <Badge variant="outline" className="text-xs gap-1 text-green-600 border-green-300 bg-green-50" title="Comment (kind 1111) — visible in Divine apps when attached to a video"><MessageSquare className="h-3 w-3" />Comment</Badge>
                    ) : (
                      <Badge variant="outline" className="text-xs gap-1 text-amber-600 border-amber-300 bg-amber-50" title="Text note (kind 1) — not visible in Divine apps. Only visible via external Nostr clients."><Globe className="h-3 w-3" />Note</Badge>
                    )}
                    {onDeleteEvent && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
                        onClick={() => onDeleteEvent(post.id)}
                        title="Delete this event"
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}

          {posts.length > 5 && (
            <Button
              variant="ghost"
              size="sm"
              className="w-full"
              onClick={() => setShowAll(!showAll)}
            >
              {showAll ? 'Show less' : `Show ${posts.length - 5} more posts`}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
