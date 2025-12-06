// ABOUTME: Displays user profile with stats, labels, and recent posts
// ABOUTME: Used in report detail view to show reported user context

import { useState } from "react";
import { nip19 } from "nostr-tools";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { User, FileText, Flag, Tag, CheckCircle, ChevronDown, ChevronUp, Video, ExternalLink, Copy, Check } from "lucide-react";
import type { NostrEvent, NostrMetadata } from "@nostrify/nostrify";
import type { UserStats } from "@/hooks/useUserStats";

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

// Extract media URLs from content and tags
function extractMediaUrls(content: string, tags: string[][]): { url: string; type: 'image' | 'video' }[] {
  const urls: { url: string; type: 'image' | 'video' }[] = [];
  const seen = new Set<string>();

  const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp'];
  const videoExts = ['mp4', 'webm', 'mov', 'm4v'];

  const getType = (url: string): 'image' | 'video' | null => {
    const ext = url.split(/[?#]/)[0].split('.').pop()?.toLowerCase();
    if (ext && imageExts.includes(ext)) return 'image';
    if (ext && videoExts.includes(ext)) return 'video';
    if (/divine\.video/.test(url)) return 'video'; // divine.video hosts videos
    return null;
  };

  // Check imeta tags
  for (const tag of tags) {
    if (tag[0] === 'imeta') {
      const urlPart = tag.find(p => p.startsWith('url '));
      if (urlPart) {
        const url = urlPart.slice(4);
        const type = getType(url);
        if (type && !seen.has(url)) {
          seen.add(url);
          urls.push({ url, type });
        }
      }
    }
    if (tag[0] === 'url' && tag[1]) {
      const url = tag[1];
      const type = getType(url);
      if (type && !seen.has(url)) {
        seen.add(url);
        urls.push({ url, type });
      }
    }
  }

  // Extract from content
  const urlPattern = /(https?:\/\/[^\s<>"{}|\\^`\[\]]+\.(?:jpg|jpeg|png|gif|webp|mp4|webm|mov|m4v)(?:\?[^\s]*)?)/gi;
  let match;
  while ((match = urlPattern.exec(content)) !== null) {
    const url = match[1];
    const type = getType(url);
    if (type && !seen.has(url)) {
      seen.add(url);
      urls.push({ url, type });
    }
  }

  // Also check for divine.video URLs
  const divinePattern = /(https?:\/\/[^\s]*divine\.video[^\s<>"{}|\\^`\[\]]*)/gi;
  while ((match = divinePattern.exec(content)) !== null) {
    const url = match[1];
    if (!seen.has(url)) {
      seen.add(url);
      urls.push({ url, type: 'video' });
    }
  }

  return urls;
}

interface UserProfileCardProps {
  profile?: NostrMetadata;
  pubkey?: string | null;
  stats?: UserStats;
  isLoading?: boolean;
}

export function UserProfileCard({ profile, pubkey, stats, isLoading }: UserProfileCardProps) {
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

  const displayName = profile?.display_name || profile?.name || `${npub.slice(0, 12)}...`;
  const nip05 = profile?.nip05;
  const truncatedNpub = `${npub.slice(0, 12)}...${npub.slice(-6)}`;

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
        <div className="flex items-center gap-3">
          <Avatar className="h-12 w-12">
            <AvatarImage src={profile?.picture} />
            <AvatarFallback>{displayName.slice(0, 2).toUpperCase()}</AvatarFallback>
          </Avatar>
          <div className="flex-1 min-w-0">
            <CardTitle className="text-base truncate">{displayName}</CardTitle>
            {nip05 && (
              <div className="flex items-center gap-1 text-sm text-muted-foreground">
                <CheckCircle className="h-3 w-3 text-green-500" />
                <span className="truncate">{nip05}</span>
              </div>
            )}
            <div className="flex items-center gap-1">
              <code className="text-xs text-muted-foreground font-mono">
                {truncatedNpub}
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
          <RecentPostsSection posts={stats.recentPosts} />
        )}
      </CardContent>
    </Card>
  );
}

// Separate component for recent posts with expand/collapse
function RecentPostsSection({ posts }: { posts: NostrEvent[] }) {
  const [expanded, setExpanded] = useState(true);
  const [showAll, setShowAll] = useState(false);

  const visiblePosts = showAll ? posts : posts.slice(0, 5);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h5 className="text-xs font-medium text-muted-foreground uppercase flex items-center gap-2">
          <FileText className="h-3 w-3" />
          Recent Content ({posts.length})
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
            const media = extractMediaUrls(post.content, post.tags);
            const hasMedia = media.length > 0;

            return (
              <div key={post.id} className="p-3 bg-muted rounded-lg space-y-2 overflow-hidden">
                {/* Post content */}
                {post.content && (
                  <p className="text-sm whitespace-pre-wrap break-all line-clamp-4">
                    {post.content}
                  </p>
                )}

                {/* Media preview */}
                {hasMedia && (
                  <div className="grid grid-cols-2 gap-2">
                    {media.slice(0, 4).map((m, idx) => (
                      <div key={idx} className="relative">
                        {m.type === 'video' ? (
                          <div className="relative">
                            <video
                              src={m.url}
                              className="w-full rounded aspect-video object-cover bg-black"
                              controls
                              preload="metadata"
                            />
                            <Badge className="absolute top-1 left-1 bg-black/70 text-white text-xs">
                              <Video className="h-3 w-3 mr-1" />
                              Video
                            </Badge>
                          </div>
                        ) : (
                          <img
                            src={m.url}
                            alt=""
                            className="w-full rounded aspect-square object-cover cursor-pointer hover:opacity-90"
                            onClick={() => window.open(m.url, '_blank')}
                          />
                        )}
                        <a
                          href={m.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="absolute top-1 right-1 p-1 bg-black/50 rounded hover:bg-black/70"
                        >
                          <ExternalLink className="h-3 w-3 text-white" />
                        </a>
                      </div>
                    ))}
                  </div>
                )}

                {media.length > 4 && (
                  <p className="text-xs text-muted-foreground">+{media.length - 4} more media</p>
                )}

                {/* Timestamp and kind */}
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>{new Date(post.created_at * 1000).toLocaleString()}</span>
                  <Badge variant="outline" className="text-xs">
                    {post.kind === 1 ? 'Note' : post.kind === 1063 ? 'Video' : `Kind ${post.kind}`}
                  </Badge>
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
