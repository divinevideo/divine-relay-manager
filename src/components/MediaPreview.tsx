// ABOUTME: Displays media (images/videos) from Nostr events with proper handling
// ABOUTME: Extracts URLs from content and imeta tags, renders with appropriate player

import { useState, useMemo, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Image, Video, Eye, EyeOff, AlertTriangle, ExternalLink } from "lucide-react";
import type { NostrEvent } from "@nostrify/nostrify";
import { useApiUrl } from "@/hooks/useAdminApi";
import { getApiHeaders } from "@/lib/adminApi";

interface MediaItem {
  url: string;
  type: 'image' | 'video' | 'unknown';
  sha256?: string;
  mimeType?: string;
}

interface MediaPreviewProps {
  event?: NostrEvent | null;
  content?: string;
  tags?: string[][];
  className?: string;
  showByDefault?: boolean;
  maxItems?: number;
}

// Extract media URLs from content and tags
function extractMediaItems(content: string, tags: string[][]): MediaItem[] {
  const items: Map<string, MediaItem> = new Map();

  // URL patterns for media
  const urlPattern = /(https?:\/\/[^\s<>"{}|\\^`[\]]+\.(?:jpg|jpeg|png|gif|webp|mp4|webm|mov|m4v|avi)(?:\?[^\s<>"{}|\\^`[\]]*)?)/gi;
  const genericUrlPattern = /(https?:\/\/(?:divine\.video|blossom\.[^\s]+|cdn\.[^\s]+|nostr\.build|void\.cat|image\.nostr\.build|media\.snort\.social|files\.v0l\.io|i\.nostr\.build)[^\s<>"{}|\\^`[\]]*)/gi;

  // Image extensions
  const imageExtensions = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'];
  const videoExtensions = ['mp4', 'webm', 'mov', 'm4v', 'avi', 'mkv'];

  // Helper to determine media type
  const getMediaType = (url: string, mimeType?: string): 'image' | 'video' | 'unknown' => {
    if (mimeType) {
      if (mimeType.startsWith('image/')) return 'image';
      if (mimeType.startsWith('video/')) return 'video';
    }
    const ext = url.split(/[?#]/)[0].split('.').pop()?.toLowerCase();
    if (ext && imageExtensions.includes(ext)) return 'image';
    if (ext && videoExtensions.includes(ext)) return 'video';
    // Check URL path for type hints
    if (/\/(image|img|photo|pic)/i.test(url)) return 'image';
    if (/\/(video|vid|mp4)/i.test(url)) return 'video';
    return 'unknown';
  };

  // Extract sha256 from URL
  const extractSha256 = (url: string): string | undefined => {
    const match = url.match(/([a-f0-9]{64})/i);
    return match ? match[1].toLowerCase() : undefined;
  };

  // Check imeta tags first (most reliable)
  for (const tag of tags) {
    if (tag[0] === 'imeta') {
      let url: string | undefined;
      let mimeType: string | undefined;
      let sha256: string | undefined;

      for (let i = 1; i < tag.length; i++) {
        const part = tag[i];
        if (part.startsWith('url ')) {
          url = part.slice(4);
        } else if (part.startsWith('m ')) {
          mimeType = part.slice(2);
        } else if (part.startsWith('x ')) {
          sha256 = part.slice(2);
        }
      }

      if (url && !items.has(url)) {
        items.set(url, {
          url,
          type: getMediaType(url, mimeType),
          sha256: sha256 || extractSha256(url),
          mimeType,
        });
      }
    }

    // Direct url tags
    if (tag[0] === 'url' && tag[1]) {
      const url = tag[1];
      if (!items.has(url)) {
        items.set(url, {
          url,
          type: getMediaType(url),
          sha256: extractSha256(url),
        });
      }
    }
  }

  // Extract from content
  let match;

  // First try specific media extensions
  urlPattern.lastIndex = 0;
  while ((match = urlPattern.exec(content)) !== null) {
    const url = match[1];
    if (!items.has(url)) {
      items.set(url, {
        url,
        type: getMediaType(url),
        sha256: extractSha256(url),
      });
    }
  }

  // Then try generic media host URLs
  genericUrlPattern.lastIndex = 0;
  while ((match = genericUrlPattern.exec(content)) !== null) {
    const url = match[1];
    if (!items.has(url)) {
      items.set(url, {
        url,
        type: getMediaType(url),
        sha256: extractSha256(url),
      });
    }
  }

  return Array.from(items.values());
}

export function MediaPreview({
  event,
  content: propContent,
  tags: propTags,
  className,
  showByDefault = false,
  maxItems = 4,
}: MediaPreviewProps) {
  const [showMedia, setShowMedia] = useState(showByDefault);
  const [failedUrls, setFailedUrls] = useState<Set<string>>(new Set());
  const [proxyUrls, setProxyUrls] = useState<Map<string, string>>(new Map());
  const apiUrl = useApiUrl();

  // Collapse media if showByDefault changes to false (e.g., high-priority reports loaded)
  // This handles the race condition where reports load after initial render
  useEffect(() => {
    if (!showByDefault) {
      setShowMedia(false);
    }
  }, [showByDefault]);

  // Clean up blob URLs on unmount to avoid memory leaks
  useEffect(() => {
    return () => {
      proxyUrls.forEach(url => {
        if (url.startsWith('blob:')) URL.revokeObjectURL(url);
      });
    };
  }, [proxyUrls]);

  const content = propContent ?? event?.content ?? '';
  const tags = useMemo(() => propTags ?? event?.tags ?? [], [propTags, event?.tags]);

  const mediaItems = useMemo(() => extractMediaItems(content, tags), [content, tags]);

  if (mediaItems.length === 0) {
    return null;
  }

  const visibleItems = mediaItems.slice(0, maxItems);
  const hasMore = mediaItems.length > maxItems;
  const imageCount = mediaItems.filter(m => m.type === 'image').length;
  const videoCount = mediaItems.filter(m => m.type === 'video').length;

  const handleError = async (url: string, sha256?: string) => {
    if (sha256 && !proxyUrls.has(url) && !failedUrls.has(url)) {
      // First failure: fetch through authenticated proxy via JS (not <img src>)
      // CF Access blocks unauthenticated browser requests to the API domain,
      // so we fetch with service token headers and create a blob URL.
      try {
        const proxyUrl = `${apiUrl}/api/media-proxy/${sha256}`;
        const resp = await fetch(proxyUrl, { headers: getApiHeaders('') });
        if (!resp.ok) throw new Error(`${resp.status}`);
        const blob = await resp.blob();
        const blobUrl = URL.createObjectURL(blob);
        setProxyUrls(prev => new Map(prev).set(url, blobUrl));
      } catch {
        setFailedUrls(prev => new Set(prev).add(url));
      }
    } else if (!proxyUrls.has(url)) {
      setFailedUrls(prev => new Set(prev).add(url));
    }
  };

  return (
    <Card className={`border-blue-200 dark:border-blue-800 ${className}`}>
      <CardHeader className="py-2 px-3">
        <CardTitle className="text-sm flex items-center justify-between">
          <div className="flex items-center gap-2">
            {videoCount > 0 ? <Video className="h-4 w-4" /> : <Image className="h-4 w-4" />}
            <span>Media Content</span>
            <div className="flex gap-1">
              {imageCount > 0 && (
                <Badge variant="outline" className="text-xs">
                  {imageCount} image{imageCount !== 1 ? 's' : ''}
                </Badge>
              )}
              {videoCount > 0 && (
                <Badge variant="outline" className="text-xs">
                  {videoCount} video{videoCount !== 1 ? 's' : ''}
                </Badge>
              )}
            </div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowMedia(!showMedia)}
            className="h-7 px-2"
          >
            {showMedia ? (
              <>
                <EyeOff className="h-3 w-3 mr-1" />
                Hide
              </>
            ) : (
              <>
                <Eye className="h-3 w-3 mr-1" />
                Show
              </>
            )}
          </Button>
        </CardTitle>
      </CardHeader>

      {showMedia && (
        <CardContent className="py-2 px-3">
          <div className="grid grid-cols-2 gap-2">
            {visibleItems.map((item, index) => {
              const displayUrl = proxyUrls.get(item.url) || item.url;
              return (
              <div key={item.url} className="relative">
                {failedUrls.has(item.url) ? (
                  <div className="aspect-video bg-muted rounded flex items-center justify-center text-muted-foreground">
                    <AlertTriangle className="h-6 w-6" />
                  </div>
                ) : item.type === 'video' ? (
                  <video
                    key={displayUrl}
                    src={displayUrl}
                    controls
                    className="w-full rounded aspect-video object-contain bg-black"
                    onError={() => handleError(item.url, item.sha256)}
                    preload="metadata"
                  />
                ) : (
                  <img
                    key={displayUrl}
                    src={displayUrl}
                    alt={`Media ${index + 1}`}
                    className="w-full rounded aspect-square object-cover cursor-pointer hover:opacity-90 transition-opacity"
                    onError={() => handleError(item.url, item.sha256)}
                    onClick={() => window.open(displayUrl, '_blank')}
                  />
                )}
                {proxyUrls.has(item.url) && !failedUrls.has(item.url) && (
                  <Badge variant="destructive" className="absolute top-1 left-1 text-[10px] px-1 py-0">
                    BLOCKED
                  </Badge>
                )}
                <a
                  href={displayUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="absolute top-1 right-1 p-1 bg-black/50 rounded hover:bg-black/70 transition-colors"
                  onClick={(e) => e.stopPropagation()}
                >
                  <ExternalLink className="h-3 w-3 text-white" />
                </a>
              </div>
              );
            })}
          </div>

          {hasMore && (
            <p className="text-xs text-muted-foreground mt-2 text-center">
              +{mediaItems.length - maxItems} more media files
            </p>
          )}

          {/* Show sha256 hashes for reference */}
          <div className="mt-2 space-y-1">
            {visibleItems.filter(m => m.sha256).slice(0, 2).map(item => (
              <p key={item.sha256} className="text-xs text-muted-foreground font-mono truncate">
                sha256: {item.sha256?.slice(0, 16)}...
              </p>
            ))}
          </div>
        </CardContent>
      )}
    </Card>
  );
}

// Compact inline version for use in PostCard
export function InlineMediaPreview({
  content,
  tags,
  className,
}: {
  content: string;
  tags: string[][];
  className?: string;
}) {
  const [showMedia, setShowMedia] = useState(true);
  const [failedUrls, setFailedUrls] = useState<Set<string>>(new Set());
  const [proxyUrls, setProxyUrls] = useState<Map<string, string>>(new Map());
  const apiUrl = useApiUrl();

  const mediaItems = useMemo(() => extractMediaItems(content, tags), [content, tags]);

  if (mediaItems.length === 0) {
    return null;
  }

  const handleError = async (url: string, sha256?: string) => {
    if (sha256 && !proxyUrls.has(url) && !failedUrls.has(url)) {
      try {
        const proxyUrl = `${apiUrl}/api/media-proxy/${sha256}`;
        const resp = await fetch(proxyUrl, { headers: getApiHeaders('') });
        if (!resp.ok) throw new Error(`${resp.status}`);
        const blob = await resp.blob();
        const blobUrl = URL.createObjectURL(blob);
        setProxyUrls(prev => new Map(prev).set(url, blobUrl));
      } catch {
        setFailedUrls(prev => new Set(prev).add(url));
      }
    } else if (!proxyUrls.has(url)) {
      setFailedUrls(prev => new Set(prev).add(url));
    }
  };

  return (
    <div className={className}>
      <div className="flex items-center gap-2 mb-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setShowMedia(!showMedia)}
          className="h-6 px-2 text-xs"
        >
          {showMedia ? <EyeOff className="h-3 w-3 mr-1" /> : <Eye className="h-3 w-3 mr-1" />}
          {showMedia ? 'Hide' : 'Show'} {mediaItems.length} media
        </Button>
      </div>

      {showMedia && (
        <div className="grid grid-cols-2 gap-2">
          {mediaItems.slice(0, 4).map((item, index) => {
            const displayUrl = proxyUrls.get(item.url) || item.url;
            return (
            <div key={item.url} className="relative">
              {failedUrls.has(item.url) ? (
                <div className="aspect-video bg-muted rounded flex items-center justify-center">
                  <AlertTriangle className="h-4 w-4 text-muted-foreground" />
                </div>
              ) : item.type === 'video' ? (
                <video
                  key={displayUrl}
                  src={displayUrl}
                  controls
                  className="w-full rounded aspect-video object-contain bg-black"
                  onError={() => handleError(item.url, item.sha256)}
                  preload="metadata"
                />
              ) : (
                <img
                  key={displayUrl}
                  src={displayUrl}
                  alt={`Media ${index + 1}`}
                  className="w-full rounded aspect-square object-cover cursor-pointer"
                  onError={() => handleError(item.url, item.sha256)}
                  onClick={() => window.open(displayUrl, '_blank')}
                />
              )}
              {proxyUrls.has(item.url) && !failedUrls.has(item.url) && (
                <Badge variant="destructive" className="absolute top-1 left-1 text-[10px] px-1 py-0">
                  BLOCKED
                </Badge>
              )}
            </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
