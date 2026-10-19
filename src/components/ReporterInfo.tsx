// ABOUTME: Displays who submitted a report or label: avatar, name and date
// ABOUTME: (ReportedBy, used by Labels.tsx)

import { nip19 } from "nostr-tools";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { NoRelayProfileIcon } from "@/components/NoRelayProfileIcon";
import { useAuthor } from "@/hooks/useAuthor";
import { getProfileUrl } from "@/lib/constants";

// Who filed a label or report, for Labels.tsx
interface ReportedByProps {
  pubkey: string;
  timestamp: number;
}

export function ReportedBy({ pubkey, timestamp }: ReportedByProps) {
  const author = useAuthor(pubkey);
  const metadata = author.data?.metadata;

  // Convert to npub
  let npub = "";
  try {
    npub = nip19.npubEncode(pubkey);
  } catch {
    npub = pubkey;
  }

  const isFunnelcakeUser = author.data?.isFunnelcakeUser ?? false;
  const displayName = metadata?.display_name || metadata?.name || `${npub.slice(0, 12)}...`;
  const date = new Date(timestamp * 1000);
  const profileUrl = getProfileUrl(npub, isFunnelcakeUser);

  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <a href={profileUrl} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 hover:opacity-80">
        <Avatar className="h-5 w-5">
          <AvatarImage src={metadata?.picture} />
          <AvatarFallback className="text-xs">{displayName.slice(0, 2).toUpperCase()}</AvatarFallback>
        </Avatar>
        <span className={metadata?.name ? "font-medium" : "font-mono"}>{displayName}</span>
        {!isFunnelcakeUser && <NoRelayProfileIcon />}
      </a>
      <span>•</span>
      <span>{date.toLocaleDateString()}</span>
    </div>
  );
}
