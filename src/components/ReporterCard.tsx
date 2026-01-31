// ABOUTME: Clickable reporter card with profile lookup and action buttons
// ABOUTME: Shows reporter identity and links to view their profile/posts

import { useAuthor } from "@/hooks/useAuthor";
import { useNostr } from "@nostrify/react";
import { useQuery } from "@tanstack/react-query";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { FileText, Copy, Check, Flag } from "lucide-react";
import { useState } from "react";
import { nip19 } from "nostr-tools";
import type { NostrEvent } from "@nostrify/nostrify";

interface ReporterCardProps {
  pubkey: string;
  reportEvent?: NostrEvent;
  category?: string;
  onViewProfile?: (pubkey: string) => void;
  onViewPosts?: (pubkey: string) => void;
  compact?: boolean;
}


export function ReporterCard({
  pubkey,
  reportEvent,
  category,
  onViewProfile,
  onViewPosts,
  compact = false,
}: ReporterCardProps) {
  const [copied, setCopied] = useState(false);
  const author = useAuthor(pubkey);
  const profile = author.data?.metadata;

  let npub: string;
  try {
    npub = nip19.npubEncode(pubkey);
  } catch {
    npub = pubkey;
  }

  const displayName = profile?.display_name || profile?.name || `${npub.slice(0, 12)}...`;
  const npubDisplay = `${npub.slice(0, 12)}...${npub.slice(-6)}`;
  const profileUrl = `https://divine.video/profile/${npub}`;

  const copyPubkey = async () => {
    try {
      const npub = nip19.npubEncode(pubkey);
      await navigator.clipboard.writeText(npub);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      await navigator.clipboard.writeText(pubkey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  if (author.isLoading) {
    return (
      <div className="flex items-center gap-3 p-2 rounded-lg bg-muted/50">
        <Skeleton className="h-8 w-8 rounded-full" />
        <div className="space-y-1 flex-1">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-3 w-32" />
        </div>
      </div>
    );
  }

  if (compact) {
    return (
      <div className="flex items-center gap-2 p-2 rounded-lg bg-muted/50 hover:bg-muted transition-colors">
        <a href={profileUrl} target="_blank" rel="noopener noreferrer" className="hover:opacity-80 shrink-0">
          <Avatar className="h-6 w-6">
            <AvatarImage src={profile?.picture} />
            <AvatarFallback className="text-xs">{displayName.slice(0, 2).toUpperCase()}</AvatarFallback>
          </Avatar>
        </a>
        <div className="flex-1 min-w-0">
          <a href={profileUrl} target="_blank" rel="noopener noreferrer" className="hover:opacity-80">
            <p className="text-sm font-medium truncate">{displayName}</p>
          </a>
          <p className="text-xs text-muted-foreground font-mono truncate">{npubDisplay}</p>
        </div>
        {category && (
          <Badge variant="outline" className="text-xs shrink-0">{category}</Badge>
        )}
        {reportEvent && (
          <span className="text-xs text-muted-foreground shrink-0">
            {new Date(reportEvent.created_at * 1000).toLocaleDateString()}
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="p-3 rounded-lg border bg-card">
      <div className="flex items-start gap-3">
        <a href={profileUrl} target="_blank" rel="noopener noreferrer" className="hover:opacity-80 shrink-0">
          <Avatar className="h-10 w-10">
            <AvatarImage src={profile?.picture} />
            <AvatarFallback>{displayName.slice(0, 2).toUpperCase()}</AvatarFallback>
          </Avatar>
        </a>

        <div className="flex-1 min-w-0 space-y-1">
          <div className="flex items-center gap-2">
            <a href={profileUrl} target="_blank" rel="noopener noreferrer" className="hover:opacity-80">
              <p className="font-medium truncate">{displayName}</p>
            </a>
            {category && (
              <Badge variant="outline" className="text-xs shrink-0">{category}</Badge>
            )}
          </div>

          <button
            onClick={copyPubkey}
            className="flex items-center gap-1 text-xs text-muted-foreground font-mono hover:text-foreground transition-colors"
          >
            {npubDisplay}
            {copied ? (
              <Check className="h-3 w-3 text-green-500" />
            ) : (
              <Copy className="h-3 w-3" />
            )}
          </button>

          {reportEvent?.content && (
            <p className="text-sm text-muted-foreground mt-2 line-clamp-2">
              "{reportEvent.content}"
            </p>
          )}
        </div>

        {reportEvent && (
          <span className="text-xs text-muted-foreground shrink-0">
            {new Date(reportEvent.created_at * 1000).toLocaleDateString()}
          </span>
        )}
      </div>

      {/* Action buttons */}
      {(onViewProfile || onViewPosts) && (
        <div className="flex gap-2 mt-3 pt-3 border-t">
          {onViewProfile && (
            <Button
              variant="outline"
              size="sm"
              className="flex-1"
              onClick={() => onViewProfile(pubkey)}
            >
              <FileText className="h-3 w-3 mr-1" />
              Reporter's Events
            </Button>
          )}
          {onViewPosts && (
            <Button
              variant="outline"
              size="sm"
              className="flex-1"
              onClick={() => onViewPosts(pubkey)}
            >
              <FileText className="h-3 w-3 mr-1" />
              View Posts
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

// List component for multiple reporters
interface ReporterListProps {
  reports: NostrEvent[];
  onViewProfile?: (pubkey: string) => void;
  onViewPosts?: (pubkey: string) => void;
  maxVisible?: number;
}

export function ReporterList({
  reports,
  onViewProfile,
  onViewPosts,
  maxVisible = 5,
}: ReporterListProps) {
  const [expanded, setExpanded] = useState(false);

  // Dedupe by pubkey, keep latest report per reporter
  const byReporter = new Map<string, NostrEvent>();
  for (const report of reports) {
    const existing = byReporter.get(report.pubkey);
    if (!existing || report.created_at > existing.created_at) {
      byReporter.set(report.pubkey, report);
    }
  }

  const uniqueReporters = Array.from(byReporter.entries());
  const visibleReporters = expanded ? uniqueReporters : uniqueReporters.slice(0, maxVisible);
  const hasMore = uniqueReporters.length > maxVisible;

  // Get category from report
  const getCategory = (event: NostrEvent): string => {
    const reportTag = event.tags.find(t => t[0] === 'report');
    if (reportTag?.[1]) return reportTag[1];
    const lTag = event.tags.find(t => t[0] === 'l');
    if (lTag?.[1]) return lTag[1];
    return 'other';
  };

  return (
    <div className="space-y-2">
      {visibleReporters.map(([pubkey, report]) => (
        <ReporterCard
          key={pubkey}
          pubkey={pubkey}
          reportEvent={report}
          category={getCategory(report)}
          onViewProfile={onViewProfile}
          onViewPosts={onViewPosts}
          compact={uniqueReporters.length > 3}
        />
      ))}

      {hasMore && !expanded && (
        <Button
          variant="ghost"
          size="sm"
          className="w-full"
          onClick={() => setExpanded(true)}
        >
          Show {uniqueReporters.length - maxVisible} more reporters
        </Button>
      )}
    </div>
  );
}

// Trust level based on report count
function getTrustLevel(reportCount: number): { level: string; color: string } {
  if (reportCount >= 50) return { level: 'Trusted', color: 'text-green-600 border-green-300 bg-green-50' };
  if (reportCount >= 20) return { level: 'Active', color: 'text-blue-600 border-blue-300 bg-blue-50' };
  if (reportCount >= 10) return { level: 'Regular', color: 'text-yellow-600 border-yellow-300 bg-yellow-50' };
  if (reportCount >= 3) return { level: 'New', color: 'text-orange-600 border-orange-300 bg-orange-50' };
  return { level: 'First-time', color: 'text-gray-600 border-gray-300 bg-gray-50' };
}

// Inline reporter info - shows who filed a report with their report count
interface ReporterInlineProps {
  pubkey: string;
  onViewProfile?: (pubkey: string) => void;
}

export function ReporterInline({ pubkey, onViewProfile }: ReporterInlineProps) {
  const { nostr } = useNostr();
  const author = useAuthor(pubkey);
  const profile = author.data?.metadata;

  // Count how many reports this user has filed
  const { data: reportCount = 0 } = useQuery({
    queryKey: ['reporter-count', pubkey],
    queryFn: async ({ signal }) => {
      const reports = await nostr.query(
        [{ kinds: [1984], authors: [pubkey], limit: 100 }],
        { signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]) }
      );
      return reports.length;
    },
    staleTime: 5 * 60 * 1000,
  });

  // Convert to npub
  let npub: string;
  try {
    npub = nip19.npubEncode(pubkey);
  } catch {
    npub = pubkey;
  }

  const displayName = profile?.display_name || profile?.name || `${npub.slice(0, 12)}...`;
  const trust = getTrustLevel(reportCount);

  if (author.isLoading) {
    return (
      <div className="flex items-center gap-2">
        <Skeleton className="h-5 w-5 rounded-full" />
        <Skeleton className="h-4 w-20" />
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <button
        onClick={() => onViewProfile?.(pubkey)}
        className="flex items-center gap-1.5 hover:bg-muted rounded-full pr-2 transition-colors"
        title="View reporter profile"
      >
        <Avatar className="h-5 w-5">
          <AvatarImage src={profile?.picture} />
          <AvatarFallback className="text-[10px]">{displayName.slice(0, 2).toUpperCase()}</AvatarFallback>
        </Avatar>
        <span className="text-sm font-medium hover:underline">{displayName}</span>
      </button>
      <span className="text-xs text-muted-foreground flex items-center gap-1">
        <Flag className="h-3 w-3" />
        {reportCount} report{reportCount !== 1 ? 's' : ''} filed
      </span>
      <Badge variant="outline" className={`text-xs ${trust.color}`}>
        {trust.level}
      </Badge>
      {onViewProfile && (
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs"
          onClick={() => onViewProfile(pubkey)}
        >
          <FileText className="h-3 w-3 mr-1" />
          Reporter's Events
        </Button>
      )}
    </div>
  );
}
