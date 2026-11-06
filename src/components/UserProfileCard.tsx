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
import { User, FileText, Flag, Tag, ChevronDown, ChevronUp, Copy, Check, ArrowUpRight, Trash2, Globe, ExternalLink, Activity, Eye, EyeOff } from "lucide-react";
import { InlineMediaPreview } from "@/components/MediaPreview";
import { useMediaVisibility } from "@/hooks/useMediaVisibility";
import type { NostrEvent, NostrMetadata } from "@nostrify/nostrify";
import type { UserStats } from "@/hooks/useUserStats";
import { RECENT_AUTHORED_LIMIT, RELAY_PROFILE_BADGE, getProfileUrl, getPublicEventUrl } from "@/lib/constants";
import { ClaimedNip05 } from "@/components/ClaimedNip05";
import { parseRepostForDisplay } from "@/lib/nip18";
import { KindBadge } from "@/components/KindBadge";
import { getCommentTarget, formatCommentActivity } from "@/lib/commentActivity";
import { useEventTitles } from "@/hooks/useEventTitles";
import { CommentParentLink } from "@/components/CommentParentLink";
import { authoredContentStat, historyCount, historyStat } from "@/lib/historyCount";
import { useJustRestored } from "@/lib/userStatsCache";

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
  /** Undefined until the profile lookup answers; no relay-profile badge until then. */
  isFunnelcakeUser?: boolean;
  /**
   * Withhold the avatar and recent-post media until a moderator asks (sensitive
   * reports). null while the reports that decide it are not known yet: hidden,
   * and a later true still counts as turning sensitive, so a reveal made
   * meanwhile is forgotten.
   */
  hideMediaByDefault?: boolean | null;
  /**
   * The account is in the relay's suspended list (useModerationStatus's
   * isUserSuspended), so the relay hides its content and an empty read is not
   * an empty account. null or omitted when the list has not confirmed it.
   */
  isSuspended?: boolean | null;
  /** The suspension is from a copy of the list that could not be refreshed. */
  isSuspendedStale?: boolean;
  /**
   * A read of the suspended list is in flight (useModerationStatus's
   * isUserSuspensionChecking), so a null isSuspended may yet settle: picks
   * "checking" over "couldn't check".
   */
  isSuspensionChecking?: boolean;
}

export function UserProfileCard({ profile, pubkey, stats, isLoading, onDeleteEvent, onViewActivity, isFunnelcakeUser, hideMediaByDefault = false, isSuspended = null, isSuspendedStale = false, isSuspensionChecking = false }: UserProfileCardProps) {
  const [copied, setCopied] = useState(false);
  const mediaShownByDefault = hideMediaByDefault === null ? null : !hideMediaByDefault;
  // The hook forgets a reveal when the account changes or the default turns
  // sensitive: coming back asks again. ReportDetail also mounts this card fresh
  // for each report, so a reveal never outlives its report. Worked out during
  // render, so the avatar is never mounted meanwhile.
  const [showAvatar, toggleAvatar] = useMediaVisibility(mediaShownByDefault, pubkey ?? "");
  const apiUrl = useApiUrl();
  // This tab restored the account moments ago (unsuspend, unban, allow); the relay can lag (userStatsCache).
  const justRestored = useJustRestored(pubkey);

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
  const profileUrl = getProfileUrl(npub, isFunnelcakeUser ?? false);

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
            {/* Radix remembers that an image loaded and hides the initials even after
                AvatarImage unmounts, so a fresh root per state brings them back. */}
            <Avatar key={showAvatar ? "image" : "hidden"} className="h-12 w-12">
              {showAvatar && <AvatarImage src={profile?.picture} />}
              <AvatarFallback>{displayName.slice(0, 2).toUpperCase()}</AvatarFallback>
            </Avatar>
          </a>
          {/* Also while hidden by the moderator's own choice, so it can come back. */}
          {(mediaShownByDefault !== true || !showAvatar) && (
            <Button
              variant="ghost"
              size="sm"
              aria-label={showAvatar ? "Hide profile picture" : "Show profile picture"}
              title={showAvatar ? "Hide profile picture" : "Show profile picture"}
              onClick={toggleAvatar}
              className="h-6 px-1.5 shrink-0"
            >
              {showAvatar ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
            </Button>
          )}
          <div className="flex-1 min-w-0 overflow-hidden">
            <div className="flex items-center gap-2 min-w-0 overflow-hidden">
              <a href={profileUrl} target="_blank" rel="noopener noreferrer" className="hover:opacity-80 min-w-0 overflow-hidden">
                <CardTitle className="text-base flex items-center gap-1 min-w-0">
                  <span className="truncate min-w-0">{displayName}</span>
                  <ArrowUpRight className="h-3 w-3 text-muted-foreground shrink-0" />
                </CardTitle>
              </a>
              {/* The link, not the badge, is the row's flex item, so it holds the
                  badge to one line while a long name truncates beside it. */}
              {isFunnelcakeUser === true ? (
                <a href={profileUrl} target="_blank" rel="noopener noreferrer" className="shrink-0" title={RELAY_PROFILE_BADGE.present.title}>
                  <Badge variant="outline" className="text-xs text-muted-foreground">{RELAY_PROFILE_BADGE.present.label}</Badge>
                </a>
              ) : isFunnelcakeUser === false && (
                <a href={profileUrl} target="_blank" rel="noopener noreferrer" className="shrink-0" title={RELAY_PROFILE_BADGE.absent.title}>
                  <Badge variant="outline" className="text-xs text-muted-foreground gap-1">
                    <Globe className="h-3 w-3" />{RELAY_PROFILE_BADGE.absent.label}
                  </Badge>
                </a>
              )}
            </div>
            <ClaimedNip05 nip05={nip05} className="text-sm" />
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
            {/* Says only what the lookup returned, and nothing until it answers
                (isFunnelcakeUser is undefined until then). Whether the relay
                stores a profile is the badge's job. */}
            {!hasProfile && (profile || isFunnelcakeUser === false) && (
              <p className="text-xs text-muted-foreground italic">{profile ? 'No name in profile' : 'No profile found'}</p>
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
            <span>{authoredContentStat({
              count: stats?.postCount,
              incomplete: stats?.authoredContentIncomplete ?? false,
              suspended: isSuspended,
              suspendedStale: isSuspendedStale,
              suspensionChecking: isSuspensionChecking,
              justRestored,
              noun: 'events',
              limit: RECENT_AUTHORED_LIMIT,
            })}</span>
          </div>
          <div className="flex items-center gap-1">
            <Flag className="h-4 w-4 text-muted-foreground" />
            {/* No stats yet is a read still out, not zero reports. */}
            <span>{stats ? historyStat(stats.reportCount, stats.reportsTruncated, stats.reportsIncomplete, 'reports') : 'checking reports'}</span>
          </div>
          <div className="flex items-center gap-1">
            <Tag className="h-4 w-4 text-muted-foreground" />
            <span>{stats ? historyStat(stats.labelCount, stats.labelsTruncated, stats.labelsIncomplete, 'labels') : 'checking labels'}</span>
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
                  {label} ({historyCount(count, stats?.labelsTruncated ?? false)})
                </Badge>
              ))}
            </div>
          </div>
        )}

        {/* Recent Posts */}
        {stats?.recentPosts && stats.recentPosts.length > 0 && (
          <RecentPostsSection posts={stats.recentPosts} onDeleteEvent={onDeleteEvent} apiUrl={apiUrl} mediaShownByDefault={mediaShownByDefault} />
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
  mediaShownByDefault,
}: {
  posts: NostrEvent[];
  onDeleteEvent?: (eventId: string) => void;
  apiUrl: string;
  mediaShownByDefault: boolean | null;
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
                  showByDefault={mediaShownByDefault}
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
