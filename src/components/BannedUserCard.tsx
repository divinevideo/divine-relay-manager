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
import { useState } from "react";
import type { NostrMetadata } from "@nostrify/nostrify";
import { getDivineProfileUrl } from "@/lib/constants";

interface BannedUserCardProps {
  pubkey: string;
  reason?: string;
  onUnban?: () => void;
}

export function BannedUserCard({ pubkey: rawPubkey, reason, onUnban }: BannedUserCardProps) {
  const { nostr } = useNostr();
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

  // Fetch user profile
  const { data: profile, isLoading: profileLoading } = useQuery({
    queryKey: ['profile', pubkey],
    queryFn: async ({ signal }) => {
      const events = await nostr.query(
        [{ kinds: [0], authors: [pubkey], limit: 1 }],
        { signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]) }
      );
      if (events.length > 0) {
        try {
          return JSON.parse(events[0].content) as NostrMetadata;
        } catch {
          return null;
        }
      }
      return null;
    },
  });

  // Fetch recent posts count
  const { data: postStats } = useQuery({
    queryKey: ['user-posts-stats', pubkey],
    queryFn: async ({ signal }) => {
      const events = await nostr.query(
        [{ kinds: [1], authors: [pubkey], limit: 50 }],
        { signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]) }
      );
      return {
        count: events.length,
        recentPosts: events.slice(0, 3),
      };
    },
  });

  const displayName = profile?.name || profile?.display_name || shortNpub;
  const njumpUrl = `https://njump.me/${npub}`;
  const profileUrl = getDivineProfileUrl(npub);

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
                  {postStats?.count || 0} posts on relay
                </span>
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
                <Button variant="ghost" size="sm">
                  <ChevronDown
                    className={`h-4 w-4 transition-transform ${
                      isOpen ? 'rotate-180' : ''
                    }`}
                  />
                </Button>
              </CollapsibleTrigger>
              {onUnban && (
                <Button variant="outline" size="sm" onClick={onUnban}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              )}
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

            {/* Recent posts */}
            <div>
              <h4 className="text-xs font-medium text-muted-foreground uppercase mb-2">
                Recent Posts on This Relay
              </h4>
              {postStats?.recentPosts && postStats.recentPosts.length > 0 ? (
                <div className="space-y-2">
                  {postStats.recentPosts.map((post) => (
                    <div
                      key={post.id}
                      className="text-sm p-2 bg-background rounded border"
                    >
                      <p className="line-clamp-2">{post.content}</p>
                      <p className="text-xs text-muted-foreground mt-1">
                        {new Date(post.created_at * 1000).toLocaleString()}
                      </p>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No posts found on this relay
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
