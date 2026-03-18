// ABOUTME: Displays information about who submitted a report
// ABOUTME: Shows reporter profile and their report history count

import { nip19 } from "nostr-tools";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Flag, Star } from "lucide-react";
import { useAuthor } from "@/hooks/useAuthor";
import type { NostrMetadata } from "@nostrify/nostrify";
import { getDivineProfileUrl } from "@/lib/constants";

interface ReporterInfoProps {
  profile?: NostrMetadata;
  pubkey?: string;
  reportCount: number;
  isLoading?: boolean;
}

function getTrustLevel(reportCount: number): { level: string; stars: number; color: string } {
  if (reportCount >= 50) return { level: 'Trusted', stars: 5, color: 'text-green-500' };
  if (reportCount >= 20) return { level: 'Active', stars: 4, color: 'text-blue-500' };
  if (reportCount >= 10) return { level: 'Regular', stars: 3, color: 'text-yellow-500' };
  if (reportCount >= 3) return { level: 'New', stars: 2, color: 'text-orange-500' };
  return { level: 'First-time', stars: 1, color: 'text-gray-500' };
}

// Simple component for backwards compatibility with Labels.tsx
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

  const displayName = metadata?.display_name || metadata?.name || `${npub.slice(0, 12)}...`;
  const date = new Date(timestamp * 1000);
  const profileUrl = getDivineProfileUrl(npub);

  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <a href={profileUrl} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 hover:opacity-80">
        <Avatar className="h-5 w-5">
          <AvatarImage src={metadata?.picture} />
          <AvatarFallback className="text-xs">{displayName.slice(0, 2).toUpperCase()}</AvatarFallback>
        </Avatar>
        <span className={metadata?.name ? "font-medium" : "font-mono"}>{displayName}</span>
      </a>
      <span>•</span>
      <span>{date.toLocaleDateString()}</span>
    </div>
  );
}

export function ReporterInfo({ profile, pubkey, reportCount, isLoading }: ReporterInfoProps) {
  if (isLoading) {
    return (
      <Card>
        <CardContent className="p-3">
          <div className="flex items-center gap-3">
            <Skeleton className="h-8 w-8 rounded-full" />
            <div className="space-y-1">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-3 w-16" />
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!pubkey) {
    return null;
  }

  // Convert to npub
  let npub = "";
  try {
    npub = nip19.npubEncode(pubkey);
  } catch {
    npub = pubkey;
  }

  const displayName = profile?.display_name || profile?.name || `${npub.slice(0, 12)}...`;
  const trust = getTrustLevel(reportCount);
  const profileUrl = getDivineProfileUrl(npub);

  return (
    <Card>
      <CardContent className="p-3">
        <h5 className="text-xs font-medium text-muted-foreground uppercase mb-2">
          Reported By
        </h5>
        <div className="flex items-center gap-3">
          <a href={profileUrl} target="_blank" rel="noopener noreferrer" className="hover:opacity-80 shrink-0">
            <Avatar className="h-8 w-8">
              <AvatarImage src={profile?.picture} />
              <AvatarFallback>{displayName.slice(0, 2).toUpperCase()}</AvatarFallback>
            </Avatar>
          </a>
          <div className="flex-1 min-w-0">
            <a href={profileUrl} target="_blank" rel="noopener noreferrer" className="hover:opacity-80">
              <p className="text-sm font-medium truncate">{displayName}</p>
            </a>
            {profile?.nip05 && (
              <p className="text-xs text-muted-foreground truncate">{profile.nip05}</p>
            )}
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="flex items-center gap-1">
                <Flag className="h-3 w-3" />
                {reportCount} reports
              </span>
              <span className={`flex items-center gap-0.5 ${trust.color}`}>
                {Array.from({ length: trust.stars }).map((_, i) => (
                  <Star key={i} className="h-3 w-3 fill-current" />
                ))}
              </span>
              <Badge variant="outline" className="text-xs">
                {trust.level}
              </Badge>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
