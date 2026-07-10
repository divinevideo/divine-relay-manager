// ABOUTME: Shared kind badge for recent-content rows — single source of truth
// ABOUTME: for how event kinds are labeled across moderation surfaces

import { Badge } from '@/components/ui/badge';
import { Globe, MessageSquare, Repeat, Video } from 'lucide-react';
import { getKindName, isVideoKind } from '@/lib/kindNames';
import { isRepostKind } from '@/lib/nip18';

// Extracted verbatim from UserProfileCard's recent-content rows (#157) so
// BannedUserCard and any future surface label kinds identically (#159).
export function KindBadge({ kind }: { kind: number }) {
  if (isVideoKind(kind)) {
    return (
      <Badge variant="default" className="text-xs gap-1 bg-green-600" title="Video (NIP-71) — visible in Divine apps">
        <Video className="h-3 w-3" />Video
      </Badge>
    );
  }
  if (kind === 1111) {
    return (
      <Badge variant="outline" className="text-xs gap-1 text-green-600 border-green-300 bg-green-50" title="Comment (kind 1111) — visible in Divine apps when attached to a video">
        <MessageSquare className="h-3 w-3" />Comment
      </Badge>
    );
  }
  if (isRepostKind(kind)) {
    return (
      <Badge variant="outline" className="text-xs gap-1 text-blue-600 border-blue-300 bg-blue-50" title="Repost — boosts another user's content into feeds">
        <Repeat className="h-3 w-3" />Repost
      </Badge>
    );
  }
  if (kind === 1) {
    return (
      <Badge variant="outline" className="text-xs gap-1 text-amber-600 border-amber-300 bg-amber-50" title="Text note (kind 1) — not visible in Divine apps. Only visible via external Nostr clients.">
        <Globe className="h-3 w-3" />Note
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="text-xs gap-1 text-amber-600 border-amber-300 bg-amber-50" title={`${getKindName(kind)} — not shown as content in Divine apps`}>
      <Globe className="h-3 w-3" />{getKindName(kind)}
    </Badge>
  );
}
