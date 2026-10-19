// ABOUTME: The purple globe shown beside an account our relay returned no profile for.
// ABOUTME: Labelled with the same wording as the "No relay profile found" badge.

import { Globe } from 'lucide-react';
import { RELAY_PROFILE_BADGE } from '@/lib/constants';

export function NoRelayProfileIcon() {
  const label = RELAY_PROFILE_BADGE.absent.title;
  return (
    <Globe className="h-3 w-3 text-purple-500 shrink-0" role="img" aria-label={label}>
      {/* An SVG takes its hover tooltip from a <title> child, not a title attribute. */}
      <title>{label}</title>
    </Globe>
  );
}
