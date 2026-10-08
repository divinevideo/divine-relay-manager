// ABOUTME: Summarizes a reported Divine list (NIP-51 set) for moderators.
// ABOUTME: A list's content is empty or encrypted, so everything comes from tags.

import type { NostrEvent } from '@nostrify/nostrify';
import { List } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { LIST_KIND } from '../../shared/list-report';

function firstTagValue(event: NostrEvent, name: string): string | undefined {
  return event.tags.find((tag) => tag[0] === name)?.[1]?.trim() || undefined;
}

function sizeLabel(event: NostrEvent): string {
  if (event.kind === LIST_KIND.people) {
    const people = event.tags.filter((tag) => tag[0] === 'p').length;
    return `${people} ${people === 1 ? 'person' : 'people'}`;
  }
  // Divine video lists reference videos by event id or by coordinate.
  const videos = event.tags.filter((tag) => tag[0] === 'e' || tag[0] === 'a').length;
  return `${videos} ${videos === 1 ? 'video' : 'videos'}`;
}

/**
 * The reported list's kind, title, description and size. Counts only the
 * public items in tags; a private list keeps its items encrypted in `content`,
 * so the card says the count leaves them out rather than reading as empty.
 */
export function ReportedListCard({ event }: { event: NostrEvent }) {
  const title = firstTagValue(event, 'title') || firstTagValue(event, 'd') || 'Untitled list';
  const description = firstTagValue(event, 'description');
  const kindLabel = event.kind === LIST_KIND.people ? 'People list' : 'Video list';

  return (
    <Card
      role="region"
      aria-label="Reported list"
      className="border-amber-200 bg-amber-50/50 dark:bg-amber-950/20"
    >
      <CardHeader className="py-3">
        <CardTitle className="text-sm flex items-center gap-2 text-amber-700 dark:text-amber-400">
          <List className="h-4 w-4" />
          <span>{kindLabel}</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="py-0 pb-3 space-y-2">
        <p className="text-base font-medium break-words">{title}</p>
        {description ? (
          <p className="text-sm whitespace-pre-wrap break-words">{description}</p>
        ) : (
          <p className="text-sm text-muted-foreground italic">No description</p>
        )}
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>{sizeLabel(event)}</span>
          {event.content.trim() !== '' && <span>(private items not shown)</span>}
          <span>·</span>
          <span>Kind {event.kind}</span>
        </div>
      </CardContent>
    </Card>
  );
}
