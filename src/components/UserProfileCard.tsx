// ABOUTME: Displays user profile with stats, labels, and recent posts
// ABOUTME: Used in report detail view to show reported user context

import { useMemo, useState } from "react";
import { nip19 } from "nostr-tools";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useApiUrl } from "@/hooks/useAdminApi";
import { User, FileText, Flag, Tag, CheckCircle, ChevronDown, ChevronUp, Copy, Check, ArrowUpRight, Trash2, Globe, ExternalLink, Activity } from "lucide-react";
import { InlineMediaPreview } from "@/components/MediaPreview";
import type { NostrEvent, NostrMetadata } from "@nostrify/nostrify";
import type { UserStats } from "@/hooks/useUserStats";
import { getProfileUrl, getPublicEventUrl } from "@/lib/constants";
import { parseRepostForDisplay } from "@/lib/nip18";
import { KindBadge } from "@/components/KindBadge";
import { getCommentTarget, formatCommentActivity } from "@/lib/commentActivity";
import { useEventTitles } from "@/hooks/useEventTitles";
import { CommentParentLink } from "@/components/CommentParentLink";

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
  /** Navigate to an in-app view of all events authored by this user (#156) */
  onViewActivity?: () => void;
  isFunnelcakeUser?: boolean;
}

export function UserProfileCard({ profile, pubkey, stats, isLoading, onDeleteEvent, onViewActivity, isFunnelcakeUser = false }: UserProfileCardProps) {
  const [copied, setCopied] = useState(false);
  const apiUrl = useApiUrl();

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
        <div className="flex flex-wrap items-center gap-4 text-sm">
          <div className="flex items-center gap-1">
            <FileText className="h-4 w-4 text-muted-foreground" />
            <span>{stats?.postCount || 0} events</span>
          </div>
          <div className="flex items-center gap-1">
            <Flag className="h-4 w-4 text-muted-foreground" />
            <span>{stats?.reportCount || 0} reports</span>
          </div>
          <div className="flex items-center gap-1">
            <Tag className="h-4 w-4 text-muted-foreground" />
            <span>{stats?.labelCount || 0} labels</span>
          </div>
          {onViewActivity && (
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto h-7 gap-1 text-xs"
              onClick={onViewActivity}
              title="View all events by this user in the Events tab"
            >
              <Activity className="h-3 w-3" />
              View Activity
            </Button>
          )}
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
          <RecentPostsSection posts={stats.recentPosts} onDeleteEvent={onDeleteEvent} apiUrl={apiUrl} />
        )}
      </CardContent>
    </Card>
  );
}

// Separate component for recent posts with expand/collapse
function RecentPostsSection({
  posts,
  onDeleteEvent,
  apiUrl,
}: {
  posts: NostrEvent[];
  onDeleteEvent?: (eventId: string) => void;
  apiUrl: string;
}) {
  const [expanded, setExpanded] = useState(true);
  const [showAll, setShowAll] = useState(false);

  const visiblePosts = useMemo(() => (showAll ? posts : posts.slice(0, 5)), [showAll, posts]);

  // #164 A: the spray roll-up is offline tag math over all posts, but
  // parent-title resolution is relay work — scope it to the rows actually
  // rendered (EventsList pattern); it widens when "Show all" reveals more
  const commentTargets = useMemo(
    () => (expanded ? visiblePosts.map(getCommentTarget).filter((t): t is string => !!t) : []),
    [expanded, visiblePosts],
  );
  const { titles } = useEventTitles(commentTargets);
  const activityLine = formatCommentActivity(posts);

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
          aria-label="Toggle recent content"
        >
          {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
        </Button>
      </div>
      {activityLine && (
        <p className="text-xs text-amber-700 dark:text-amber-400">{activityLine}</p>
      )}

      {expanded && (
        <div className="space-y-3">
          {visiblePosts.map(post => {
            // Kind 6/16 content is the stringified JSON of the reposted event
            // (NIP-18) — surface the inner content, labeled, instead of raw JSON.
            // Shared NIP-18 display derivation — inner content for reposts
            // (never raw JSON), file-data kinds suppressed (direct or
            // smuggled through a repost), out-of-spec content preserved.
            const { isRepost, inner, displayContent, targetDescription } = parseRepostForDisplay(post);
            return (
              <div key={post.id} className="p-3 bg-muted rounded-lg space-y-2 overflow-hidden">
                {/* Post content */}
                {displayContent && (
                  <p className="text-sm whitespace-pre-wrap break-all line-clamp-4">
                    {isRepost && (
                      <span
                        className="text-muted-foreground italic"
                        title={inner?.pubkey ? `Reposted from pubkey ${inner.pubkey}` : undefined}
                      >
                        reposted:{' '}
                      </span>
                    )}
                    {displayContent}
                  </p>
                )}
                {/* Reposts with nothing displayable — identify the target
                    (e-tag event id or a-tag coordinate per NIP-18) */}
                {isRepost && !displayContent && targetDescription && (
                  <p className="text-xs text-muted-foreground italic break-all line-clamp-2">
                    reposted {targetDescription}
                  </p>
                )}

                {/* Media preview - uses InlineMediaPreview for admin proxy fallback.
                    Reposts pass the inner event's content+tags so its media resolves. */}
                <InlineMediaPreview
                  content={displayContent}
                  tags={isRepost ? (inner?.tags ?? []) : post.tags}
                />

                {/* Timestamp, kind, link, and delete */}
                <div className="flex items-center justify-between text-xs text-muted-foreground gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="shrink-0">{new Date(post.created_at * 1000).toLocaleString()}</span>
                    {post.kind === 1111 && (
                      <CommentParentLink resolved={titles.get(getCommentTarget(post) ?? '')} />
                    )}
                  </div>
                  <div className="flex items-center gap-1.5">
                    {(() => {
                      try {
                        const encodedRef = (post.kind === 34235 || post.kind === 34236)
                          ? nip19.naddrEncode({ identifier: post.tags.find(t => t[0] === 'd')?.[1] || '', pubkey: post.pubkey, kind: post.kind })
                          : nip19.neventEncode({ id: post.id });
                        const eventUrl = getPublicEventUrl(encodedRef, apiUrl);
                        return (
                          <a href={eventUrl} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:text-blue-800">
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        );
                      } catch { return null; }
                    })()}
                    <KindBadge kind={post.kind} />
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
              {showAll ? 'Show less' : `Show ${posts.length - 5} more events`}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
