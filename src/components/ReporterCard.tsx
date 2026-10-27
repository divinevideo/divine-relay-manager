// ABOUTME: Clickable reporter card with profile lookup and action buttons
// ABOUTME: Shows reporter identity and links to view their profile/posts

import { useAuthor } from "@/hooks/useAuthor";
import { useAppContext } from "@/hooks/useAppContext";
import { useNostr } from "@nostrify/react";
import { useQuery } from "@tanstack/react-query";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { FileText, Copy, Check, Flag, Globe } from "lucide-react";
import { NoRelayProfileIcon } from "@/components/NoRelayProfileIcon";
import { useState } from "react";
import { nip19 } from "nostr-tools";
import type { NostrEvent } from "@nostrify/nostrify";
import { RELAY_PROFILE_BADGE, getCategoryLabel, getProfileUrl, getReportCategory } from "@/lib/constants";
import { reportsFiledLabel } from "@/lib/historyCount";
import { queryStrict } from "@/lib/relayRead";
import { ClaimedNip05 } from "@/components/ClaimedNip05";

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

  // Undefined until the profile lookup answers; the globe waits for a definite "none".
  const isFunnelcakeUser = author.data?.isFunnelcakeUser;
  const displayName = profile?.display_name || profile?.name || `${npub.slice(0, 12)}...`;
  const npubDisplay = `${npub.slice(0, 12)}...${npub.slice(-6)}`;
  const profileUrl = getProfileUrl(npub, isFunnelcakeUser ?? false);

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
          <a href={profileUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 hover:opacity-80">
            <p className="text-sm font-medium truncate">{displayName}</p>
            {isFunnelcakeUser === false && <NoRelayProfileIcon />}
          </a>
          <p className="text-xs text-muted-foreground font-mono truncate">{npubDisplay}</p>
        </div>
        {category && (
          <Badge variant="outline" className="text-xs shrink-0">{getCategoryLabel(category)}</Badge>
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
            <a href={profileUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 hover:opacity-80">
              <p className="font-medium truncate">{displayName}</p>
              {isFunnelcakeUser === false && <NoRelayProfileIcon />}
            </a>
            {category && (
              <Badge variant="outline" className="text-xs shrink-0">{getCategoryLabel(category)}</Badge>
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

  return (
    <div className="space-y-2">
      {visibleReporters.map(([pubkey, report]) => (
        <ReporterCard
          key={pubkey}
          pubkey={pubkey}
          reportEvent={report}
          category={getReportCategory(report)}
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

// The filing-history read stops here, so a count that reaches it is a floor.
const REPORTER_COUNT_LIMIT = 100;

// Inline reporter info - shows who filed a report with their report count
interface ReporterInlineProps {
  pubkey: string;
  onViewProfile?: (pubkey: string) => void;
}

export function ReporterInline({ pubkey, onViewProfile }: ReporterInlineProps) {
  const { nostr } = useNostr();
  const { config } = useAppContext();
  const author = useAuthor(pubkey);
  const profile = author.data?.metadata;

  // Count how many reports this user has filed. queryStrict, not nostr.query:
  // NPool.query answers a failed or timed-out read with partial results, which
  // would print as a smaller count than the reporter really has.
  const reportCount = useQuery({
    // Env key (apiUrl): singleton QueryClient + per-env NPool. Without it a
    // count read from one environment's relay is shown in another
    queryKey: ['reporter-count', config.apiUrl, pubkey],
    queryFn: async ({ signal }) => {
      const reports = await queryStrict(
        nostr,
        [{ kinds: [1984], authors: [pubkey], limit: REPORTER_COUNT_LIMIT }],
        { signal, timeoutMs: 3000 },
      );
      return reports.length;
    },
    // nostr.query never threw, so this never retried; keep a failed read from
    // leaving the count blank for the default three retries.
    retry: 1,
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

  if (author.isLoading) {
    return (
      <div className="flex items-center gap-2">
        <Skeleton className="h-5 w-5 rounded-full" />
        <Skeleton className="h-4 w-20" />
      </div>
    );
  }

  // Undefined when the lookup produced no answer: then no badge claims either way.
  const isFunnelcakeUser = author.data?.isFunnelcakeUser;
  const profileUrl = getProfileUrl(npub, isFunnelcakeUser ?? false);

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <a
        href={profileUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-1.5 hover:bg-muted rounded-full pr-2 transition-colors"
        title={isFunnelcakeUser ? "View profile on Divine" : "View profile on njump.me"}
      >
        <Avatar className="h-5 w-5">
          <AvatarImage src={profile?.picture} />
          <AvatarFallback className="text-[10px]">{displayName.slice(0, 2).toUpperCase()}</AvatarFallback>
        </Avatar>
        <span className="text-sm font-medium hover:underline">{displayName}</span>
      </a>
      <ClaimedNip05 nip05={profile?.nip05} className="text-xs max-w-full" />
      {!reportCount.isPending && (
        <span className="text-xs text-muted-foreground flex items-center gap-1" title="Reports by this account stored on this relay">
          <Flag className="h-3 w-3" />
          {/* A count read once stays true as of that read, so a later failed
              refresh keeps it; "unavailable" is only for a count never read. */}
          {reportCount.data !== undefined
            ? reportsFiledLabel(reportCount.data, REPORTER_COUNT_LIMIT)
            : 'report count unavailable'}
        </span>
      )}
      {isFunnelcakeUser === true ? (
        <a href={profileUrl} target="_blank" rel="noopener noreferrer" className="hover:opacity-80" title={RELAY_PROFILE_BADGE.present.title}>
          <Badge variant="outline" className="text-xs text-muted-foreground gap-1">
            {RELAY_PROFILE_BADGE.present.label}
          </Badge>
        </a>
      ) : isFunnelcakeUser === false && (
        <a href={profileUrl} target="_blank" rel="noopener noreferrer" className="hover:opacity-80" title={RELAY_PROFILE_BADGE.absent.title}>
          <Badge variant="outline" className="text-xs text-muted-foreground gap-1">
            <Globe className="h-3 w-3" />
            {RELAY_PROFILE_BADGE.absent.label}
          </Badge>
        </a>
      )}
      {onViewProfile && (
        <Button
          type="button"
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
