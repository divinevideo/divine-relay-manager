// ABOUTME: Rich display card for banned users with profile, npub, links
// ABOUTME: Shows user context including profile pic, name, npub, njump link, posts

import { useQuery } from "@tanstack/react-query";
import { useNostr } from "@nostrify/react";
import { nip19 } from "nostr-tools";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ExternalLink, FileText, ChevronDown, Copy, Check, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { getProfileUrl, RECENT_CONTENT_KINDS } from "@/lib/constants";
import { parseRepostForDisplay } from "@/lib/nip18";
import { KindBadge } from "@/components/KindBadge";
import { useAuthor } from "@/hooks/useAuthor";
import { useAppContext } from "@/hooks/useAppContext";
import { getCommentTarget, formatCommentActivity } from "@/lib/commentActivity";
import { useEventTitles } from "@/hooks/useEventTitles";
import { CommentParentLink } from "@/components/CommentParentLink";

interface BannedUserCardProps {
  pubkey: string;
  reason?: string;
  onUnban?: () => void;
  actionButton?: React.ReactNode;
}

export function BannedUserCard({ pubkey: rawPubkey, reason, onUnban, actionButton }: BannedUserCardProps) {
  const { nostr } = useNostr();
  const { config } = useAppContext();
  const [isOpen, setIsOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  // Normalize: if an npub was stored, decode to hex; otherwise use as-is
  let pubkey = rawPubkey;
  if (rawPubkey.startsWith('npub1')) {
    try {
      const decoded = nip19.decode(rawPubkey);
      if (decoded.type === 'npub') pubkey = decoded.data;
    } catch { /* keep rawPubkey */ }
  }

  // Convert to npub for display
  let npub: string;
  try {
    npub = nip19.npubEncode(pubkey);
  } catch {
    npub = pubkey; // fallback if hex is somehow invalid
  }
  const shortNpub = npub.slice(0, 12) + '...' + npub.slice(-8);

  // Profile via the shared useAuthor hook (Funnelcake REST fast path,
  // validated metadata, its own staleTime) instead of a hand-rolled query
  const { data: author, isLoading: profileLoading } = useAuthor(pubkey);
  const profile = author?.metadata;

  // Fetch recent authored content — kind 1 alone missed comment-spam accounts
  // whose only activity is comments/reposts (#159); RECENT_CONTENT_KINDS is
  // shared with useUserStats so this card and the report page stay aligned.
  const { data: postStats } = useQuery({
    // Env key (apiUrl): singleton QueryClient + per-env NPool — without it a
    // card can serve the other environment's events for the staleTime window
    queryKey: ['user-posts-stats', config.apiUrl, pubkey],
    queryFn: async ({ signal }) => {
      const events = await nostr.query(
        [{ kinds: [...RECENT_CONTENT_KINDS], authors: [pubkey], limit: 50 }],
        { signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]) }
      );
      return {
        count: events.length,
        // Relay result order isn't guaranteed — sort (a copy) newest-first
        recentPosts: [...events].sort((a, b) => b.created_at - a.created_at).slice(0, 3),
        // The full set drives the spray roll-up (summarize all comments, not the shown 3)
        allEvents: events,
      };
    },
    // UserManagement renders one card per banned/suspended user and Radix
    // Tabs remount on tab switch — without staleTime every switch refires
    // N x 2 relay queries (aligned with useUserStats' 2min)
    staleTime: 2 * 60_000,
  });

  // #164 A: the spray roll-up is offline tag math over the full fetched set,
  // but parent-title resolution is relay work — scope it to the ≤3 rows that
  // actually render, and only once the card is open (EventsList pattern)
  const allEvents = postStats?.allEvents ?? [];
  const commentTargets = useMemo(
    () => (isOpen ? (postStats?.recentPosts ?? []).map(getCommentTarget).filter((t): t is string => !!t) : []),
    [isOpen, postStats],
  );
  const { titles } = useEventTitles(commentTargets);
  const activityLine = formatCommentActivity(allEvents);

  const displayName = profile?.name || profile?.display_name || shortNpub;
  const njumpUrl = `https://njump.me/${npub}`;
  const profileUrl = getProfileUrl(npub, false);

  const copyNpub = () => {
    navigator.clipboard.writeText(npub);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="border rounded-lg overflow-hidden">
      <Collapsible open={isOpen} onOpenChange={setIsOpen}>
        <div className="p-4">
          <div className="flex items-start gap-3">
            {/* Avatar */}
            {profileLoading ? (
              <Skeleton className="h-12 w-12 rounded-full" />
            ) : (
              <a href={profileUrl} target="_blank" rel="noopener noreferrer" className="hover:opacity-80 shrink-0">
                <Avatar className="h-12 w-12">
                  <AvatarImage src={profile?.picture} />
                  <AvatarFallback>
                    {displayName.slice(0, 2).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
              </a>
            )}

            {/* User Info */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                {profileLoading ? (
                  <Skeleton className="h-5 w-32" />
                ) : (
                  <a href={profileUrl} target="_blank" rel="noopener noreferrer" className="hover:opacity-80">
                    <h3 className="font-semibold truncate">{displayName}</h3>
                  </a>
                )}
                {profile?.nip05 && (
                  <Badge variant="secondary" className="text-xs">
                    {profile.nip05}
                  </Badge>
                )}
              </div>

              {/* npub with copy */}
              <div className="flex items-center gap-1 mt-1">
                <code className="text-xs text-muted-foreground font-mono">
                  {shortNpub}
                </code>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-5 w-5 p-0"
                  onClick={copyNpub}
                  aria-label="Copy npub"
                >
                  {copied ? (
                    <Check className="h-3 w-3 text-green-500" />
                  ) : (
                    <Copy className="h-3 w-3" />
                  )}
                </Button>
              </div>

              {/* Stats row */}
              <div className="flex items-center gap-3 mt-2 text-sm">
                <span className="flex items-center gap-1 text-muted-foreground">
                  <FileText className="h-3 w-3" />
                  {postStats?.count || 0} events on relay
                </span>
                {activityLine && (
                  <span className="text-amber-700 dark:text-amber-400">{activityLine}</span>
                )}
                <a
                  href={njumpUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 text-blue-600 hover:underline"
                >
                  <ExternalLink className="h-3 w-3" />
                  View on njump
                </a>
              </div>

              {/* Ban reason */}
              {reason && (
                <div className="mt-2 p-2 bg-red-50 dark:bg-red-950/30 rounded text-sm">
                  <span className="font-medium text-red-700 dark:text-red-400">
                    Reason:
                  </span>{' '}
                  <span className="text-red-600 dark:text-red-300">{reason}</span>
                </div>
              )}
            </div>

            {/* Actions */}
            <div className="flex items-center gap-2">
              <CollapsibleTrigger asChild>
                <Button variant="ghost" size="sm" aria-label={`Toggle details for ${displayName}`}>
                  <ChevronDown
                    className={`h-4 w-4 transition-transform ${
                      isOpen ? 'rotate-180' : ''
                    }`}
                  />
                </Button>
              </CollapsibleTrigger>
              {actionButton ?? (onUnban && (
                <Button variant="outline" size="sm" onClick={onUnban}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              ))}
            </div>
          </div>
        </div>

        <CollapsibleContent>
          <div className="px-4 pb-4 border-t pt-3 bg-muted/30">
            {/* Bio */}
            {profile?.about && (
              <div className="mb-3">
                <h4 className="text-xs font-medium text-muted-foreground uppercase mb-1">
                  Bio
                </h4>
                <p className="text-sm">{profile.about}</p>
              </div>
            )}

            {/* Recent authored content */}
            <div>
              <h4 className="text-xs font-medium text-muted-foreground uppercase mb-2">
                Recent Content on This Relay
              </h4>
              {postStats?.recentPosts && postStats.recentPosts.length > 0 ? (
                <div className="space-y-2">
                  {postStats.recentPosts.map((post) => {
                    // Shared NIP-18 display derivation — inner content for
                    // reposts (never raw JSON), file-data kinds suppressed,
                    // out-of-spec repost content preserved as evidence.
                    const { isRepost, inner, displayContent, targetDescription } = parseRepostForDisplay(post);
                    return (
                      <div
                        key={post.id}
                        className="text-sm p-2 bg-background rounded border space-y-1"
                      >
                        {displayContent && (
                          <p className="line-clamp-2 break-all">
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
                        <div className="flex items-center justify-between text-xs text-muted-foreground gap-2">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="shrink-0">{new Date(post.created_at * 1000).toLocaleString()}</span>
                            {post.kind === 1111 && (
                              <CommentParentLink resolved={titles.get(getCommentTarget(post) ?? '')} />
                            )}
                          </div>
                          <KindBadge kind={post.kind} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No recent content found on this relay
                </p>
              )}
            </div>

            {/* Full identifiers */}
            <div className="mt-3 pt-3 border-t">
              <h4 className="text-xs font-medium text-muted-foreground uppercase mb-1">
                Full Identifiers
              </h4>
              <div className="space-y-1">
                <p className="text-xs font-mono break-all">
                  <span className="text-muted-foreground">npub:</span> {npub}
                </p>
                <p className="text-xs font-mono break-all">
                  <span className="text-muted-foreground">hex:</span> {pubkey}
                </p>
              </div>
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
