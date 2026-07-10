// ABOUTME: "on <parent>" link on a comment row, into the internal Events tab (#164 A)

import { Link } from 'react-router-dom';
import { MessageSquare } from 'lucide-react';
import type { ResolvedTarget } from '@/hooks/useEventTitles';

export function CommentParentLink({ resolved }: { resolved: ResolvedTarget | undefined }) {
  if (!resolved) return null;
  return (
    <Link
      to={`/events?event=${resolved.encoded}`}
      className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground min-w-0"
    >
      <MessageSquare className="h-3 w-3 shrink-0" />
      <span className="truncate">on {resolved.title}</span>
    </Link>
  );
}
