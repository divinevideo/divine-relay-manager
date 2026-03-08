// ABOUTME: Displays preview of a Nostr event's content by fetching it from the relay
// ABOUTME: Shows text content, images, metadata, and Hive AI moderation results

import { useQuery } from "@tanstack/react-query";
import { useNostr } from "@nostrify/react";
import { Link } from "react-router-dom";
import { nip19 } from "nostr-tools";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { AlertTriangle, ExternalLink, Video, Image } from "lucide-react";
import { HiveAIReport } from "@/components/HiveAIReport";
import type { NostrEvent } from "@nostrify/nostrify";

// Extract media info from imeta tags
function extractImetaMedia(tags: string[][]): { url: string; type: 'image' | 'video'; thumbnail?: string }[] {
  const media: { url: string; type: 'image' | 'video'; thumbnail?: string }[] = [];
  for (const tag of tags) {
    if (tag[0] !== 'imeta') continue;
    let url: string | undefined;
    let mimeType: string | undefined;
    let thumbnail: string | undefined;
    for (let i = 1; i < tag.length; i++) {
      const part = tag[i];
      if (part.startsWith('url ')) url = part.slice(4);
      else if (part.startsWith('m ')) mimeType = part.slice(2);
      else if (part.startsWith('image ')) thumbnail = part.slice(6);
    }
    if (url) {
      const type = mimeType?.startsWith('image/') ? 'image' as const : 'video' as const;
      media.push({ url, type, thumbnail });
    }
  }
  return media;
}

interface EventContentPreviewProps {
  eventId: string;
  className?: string;
}

export function EventContentPreview({ eventId, className }: EventContentPreviewProps) {
  const { nostr } = useNostr();

  const { data: event, isLoading, error } = useQuery({
    queryKey: ['event-preview', eventId],
    queryFn: async ({ signal }) => {
      const events = await nostr.query(
        [{ ids: [eventId], limit: 1 }],
        { signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) }
      );
      return events[0] || null;
    },
    staleTime: 5 * 60 * 1000, // Cache for 5 minutes
  });

  if (isLoading) {
    return (
      <div className={className}>
        <Skeleton className="h-20 w-full" />
      </div>
    );
  }

  if (error || !event) {
    return (
      <div className={`text-sm text-muted-foreground italic ${className}`}>
        <AlertTriangle className="h-4 w-4 inline mr-1" />
        Event not found or deleted
      </div>
    );
  }

  return (
    <div className={`space-y-3 ${className}`}>
      <EventContent event={event} />
      <HiveAIReport eventTags={event.tags} />
    </div>
  );
}

interface EventContentProps {
  event: NostrEvent;
  className?: string;
}

export function EventContent({ event, className }: EventContentProps) {
  // Extract image URLs from content
  const imageUrls = extractImageUrls(event.content);
  const textContent = removeImageUrls(event.content);
  const imetaMedia = extractImetaMedia(event.tags);
  const title = event.tags.find(t => t[0] === 'title')?.[1];

  // Get event kind label
  const kindLabel = getKindLabel(event.kind);

  return (
    <Card className={`bg-muted/50 ${className}`}>
      <CardContent className="p-3 space-y-2">
        {/* Event metadata */}
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Badge variant="outline" className="text-xs">
            Kind {event.kind}
          </Badge>
          {kindLabel && (
            <span className="text-xs">{kindLabel}</span>
          )}
          <span>•</span>
          <span>{new Date(event.created_at * 1000).toLocaleString()}</span>
        </div>

        {/* Text content */}
        {textContent && (
          <div className="text-sm whitespace-pre-wrap break-words">
            {textContent.length > 500 ? (
              <>
                {textContent.slice(0, 500)}
                {' ... '}
                <Link
                  to={`/${(() => {
                    try {
                      return nip19.noteEncode(event.id);
                    } catch {
                      return `note1${event.id.slice(0, 8)}...`;
                    }
                  })()}`}
                  className="text-blue-500 hover:underline inline-flex items-center gap-1"
                >
                  <span>View full content</span>
                  <ExternalLink className="h-3 w-3" />
                </Link>
              </>
            ) : (
              textContent
            )}
          </div>
        )}

        {/* Image previews from content URLs */}
        {imageUrls.length > 0 && (
          <div className="flex flex-wrap gap-2 mt-2">
            {imageUrls.slice(0, 4).map((url, idx) => (
              <div key={idx} className="relative group">
                <img
                  src={url}
                  alt={`Attachment ${idx + 1}`}
                  className="h-20 w-20 object-cover rounded border"
                  onError={(e) => {
                    e.currentTarget.style.display = 'none';
                  }}
                />
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 flex items-center justify-center rounded transition-opacity"
                >
                  <ExternalLink className="h-4 w-4 text-white" />
                </a>
              </div>
            ))}
            {imageUrls.length > 4 && (
              <div className="h-20 w-20 rounded border bg-muted flex items-center justify-center text-sm text-muted-foreground">
                +{imageUrls.length - 4} more
              </div>
            )}
          </div>
        )}

        {/* Media from imeta tags (videos/images with no content URL) */}
        {imetaMedia.length > 0 && imageUrls.length === 0 && (
          <div className="space-y-2 mt-2">
            {title && (
              <p className="text-sm font-medium">{title}</p>
            )}
            <div className="flex flex-wrap gap-2">
              {imetaMedia.slice(0, 4).map((m, idx) => (
                <div key={idx} className="relative group">
                  {m.thumbnail ? (
                    <img
                      src={m.thumbnail}
                      alt={title || `Media ${idx + 1}`}
                      className="h-20 w-32 object-cover rounded border"
                      onError={(e) => { e.currentTarget.style.display = 'none'; }}
                    />
                  ) : (
                    <div className="h-20 w-32 rounded border bg-muted flex items-center justify-center">
                      {m.type === 'video' ? <Video className="h-6 w-6 text-muted-foreground" /> : <Image className="h-6 w-6 text-muted-foreground" />}
                    </div>
                  )}
                  <a
                    href={m.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 flex items-center justify-center rounded transition-opacity"
                  >
                    <ExternalLink className="h-4 w-4 text-white" />
                  </a>
                  {m.type === 'video' && m.thumbnail && (
                    <div className="absolute bottom-1 left-1 bg-black/70 rounded px-1">
                      <Video className="h-3 w-3 text-white" />
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* No content indicator */}
        {!textContent && imageUrls.length === 0 && imetaMedia.length === 0 && (
          <div className="text-sm text-muted-foreground italic">
            No text content
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// Helper functions
function extractImageUrls(content: string): string[] {
  const urlRegex = /(https?:\/\/[^\s]+\.(jpg|jpeg|png|gif|webp|bmp)(\?[^\s]*)?)/gi;
  const matches = content.match(urlRegex) || [];
  return [...new Set(matches)]; // Remove duplicates
}

function removeImageUrls(content: string): string {
  const urlRegex = /(https?:\/\/[^\s]+\.(jpg|jpeg|png|gif|webp|bmp)(\?[^\s]*)?)/gi;
  return content.replace(urlRegex, '').trim();
}

function getKindLabel(kind: number): string | null {
  const kindLabels: Record<number, string> = {
    0: 'Profile',
    1: 'Note',
    3: 'Contacts',
    4: 'DM',
    5: 'Delete',
    6: 'Repost',
    7: 'Reaction',
    21: 'Video',
    1984: 'Report',
    1985: 'Label',
    30023: 'Article',
    30024: 'Draft',
    34235: 'Video',
    34236: 'Short Video',
  };
  return kindLabels[kind] || null;
}
