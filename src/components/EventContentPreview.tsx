// ABOUTME: Displays preview of a Nostr event's content by fetching it from the relay
// ABOUTME: Shows text content, images, and metadata for moderation review

import { useQuery } from "@tanstack/react-query";
import { useNostr } from "@nostrify/react";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { AlertTriangle, Image, FileText, User, ExternalLink } from "lucide-react";
import type { NostrEvent } from "@nostrify/nostrify";

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
    <EventContent event={event} className={className} />
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
            {textContent.length > 500 ? `${textContent.slice(0, 500)}...` : textContent}
          </div>
        )}

        {/* Image previews */}
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

        {/* No content indicator */}
        {!textContent && imageUrls.length === 0 && (
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
    1984: 'Report',
    1985: 'Label',
    30023: 'Article',
    30024: 'Draft',
  };
  return kindLabels[kind] || null;
}
