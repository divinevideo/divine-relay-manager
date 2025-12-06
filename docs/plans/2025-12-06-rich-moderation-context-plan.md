# Rich Moderation Context Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enhance the Reports tab with split-pane layout showing full context (thread, user profile, history, AI summary) for moderator decision-making.

**Architecture:** Split-pane UI with report list on left, detail view on right. Context data fetched in parallel via custom hooks. AI summaries generated via Cloudflare Worker endpoint using Claude API.

**Tech Stack:** React 18, TanStack Query, Nostrify, Cloudflare Workers, Claude API, shadcn/ui

---

## Task 1: Create useThread Hook

**Files:**
- Create: `src/hooks/useThread.ts`

**Step 1: Create the hook file**

```typescript
// ABOUTME: Fetches complete thread context for a Nostr event
// ABOUTME: Traverses reply tags to build thread ancestry and fetch full conversation

import { useNostr } from "@nostrify/react";
import { useQuery } from "@tanstack/react-query";
import type { NostrEvent } from "@nostrify/nostrify";

interface ThreadResult {
  ancestors: NostrEvent[];  // ordered from root to parent
  event: NostrEvent | null;
  replies: NostrEvent[];
}

export function useThread(eventId: string | undefined, depth: number = 3) {
  const { nostr } = useNostr();

  return useQuery<ThreadResult>({
    queryKey: ['thread', eventId, depth],
    queryFn: async ({ signal }) => {
      if (!eventId) {
        return { ancestors: [], event: null, replies: [] };
      }

      const timeout = AbortSignal.timeout(5000);
      const combinedSignal = AbortSignal.any([signal, timeout]);

      // Fetch the main event
      const [event] = await nostr.query(
        [{ ids: [eventId], limit: 1 }],
        { signal: combinedSignal }
      );

      if (!event) {
        return { ancestors: [], event: null, replies: [] };
      }

      // Find ancestors by following reply tags
      const ancestors: NostrEvent[] = [];
      let currentEvent = event;

      for (let i = 0; i < depth; i++) {
        const replyTag = currentEvent.tags.find(
          t => t[0] === 'e' && (t[3] === 'reply' || t[3] === 'root' || !t[3])
        );

        if (!replyTag) break;

        const [parentEvent] = await nostr.query(
          [{ ids: [replyTag[1]], limit: 1 }],
          { signal: combinedSignal }
        );

        if (parentEvent) {
          ancestors.unshift(parentEvent);
          currentEvent = parentEvent;
        } else {
          break;
        }
      }

      // Fetch replies to the event
      const replies = await nostr.query(
        [{ kinds: [1], '#e': [eventId], limit: 20 }],
        { signal: combinedSignal }
      );

      return { ancestors, event, replies };
    },
    enabled: !!eventId,
  });
}
```

**Step 2: Commit**

```bash
git add src/hooks/useThread.ts
git commit -m "feat: add useThread hook for fetching thread context"
```

---

## Task 2: Create useUserStats Hook

**Files:**
- Create: `src/hooks/useUserStats.ts`

**Step 1: Create the hook file**

```typescript
// ABOUTME: Fetches aggregated stats for a Nostr user
// ABOUTME: Returns post count, report count, label count, and recent posts

import { useNostr } from "@nostrify/react";
import { useQuery } from "@tanstack/react-query";
import type { NostrEvent } from "@nostrify/nostrify";

export interface UserStats {
  postCount: number;
  reportCount: number;
  labelCount: number;
  recentPosts: NostrEvent[];
  existingLabels: NostrEvent[];
  previousReports: NostrEvent[];
}

export function useUserStats(pubkey: string | undefined) {
  const { nostr } = useNostr();

  return useQuery<UserStats>({
    queryKey: ['user-stats', pubkey],
    queryFn: async ({ signal }) => {
      if (!pubkey) {
        return {
          postCount: 0,
          reportCount: 0,
          labelCount: 0,
          recentPosts: [],
          existingLabels: [],
          previousReports: [],
        };
      }

      const timeout = AbortSignal.timeout(8000);
      const combinedSignal = AbortSignal.any([signal, timeout]);

      // Fetch in parallel
      const [recentPosts, existingLabels, previousReports] = await Promise.all([
        // User's recent posts
        nostr.query(
          [{ kinds: [1], authors: [pubkey], limit: 10 }],
          { signal: combinedSignal }
        ),
        // Labels against this user
        nostr.query(
          [{ kinds: [1985], '#p': [pubkey], limit: 50 }],
          { signal: combinedSignal }
        ),
        // Reports against this user
        nostr.query(
          [{ kinds: [1984], '#p': [pubkey], limit: 50 }],
          { signal: combinedSignal }
        ),
      ]);

      return {
        postCount: recentPosts.length, // Note: This is just recent, not total
        reportCount: previousReports.length,
        labelCount: existingLabels.length,
        recentPosts: recentPosts.sort((a, b) => b.created_at - a.created_at),
        existingLabels,
        previousReports,
      };
    },
    enabled: !!pubkey,
  });
}
```

**Step 2: Commit**

```bash
git add src/hooks/useUserStats.ts
git commit -m "feat: add useUserStats hook for user statistics"
```

---

## Task 3: Create useReportContext Hook

**Files:**
- Create: `src/hooks/useReportContext.ts`

**Step 1: Create the hook file**

```typescript
// ABOUTME: Aggregates all context needed for moderating a report
// ABOUTME: Combines thread, user stats, reporter info into single hook

import { useNostr } from "@nostrify/react";
import { useQuery } from "@tanstack/react-query";
import { useAuthor } from "@/hooks/useAuthor";
import { useThread } from "@/hooks/useThread";
import { useUserStats } from "@/hooks/useUserStats";
import type { NostrEvent, NostrMetadata } from "@nostrify/nostrify";

interface ReportTarget {
  type: 'event' | 'pubkey';
  value: string;
}

function getReportTarget(event: NostrEvent): ReportTarget | null {
  const eTag = event.tags.find(t => t[0] === 'e');
  if (eTag) return { type: 'event', value: eTag[1] };

  const pTag = event.tags.find(t => t[0] === 'p');
  if (pTag) return { type: 'pubkey', value: pTag[1] };

  return null;
}

function getReportedPubkey(event: NostrEvent): string | null {
  // If report targets a pubkey directly
  const pTag = event.tags.find(t => t[0] === 'p');
  if (pTag) return pTag[1];

  return null;
}

export function useReportContext(report: NostrEvent | null) {
  const { nostr } = useNostr();

  const target = report ? getReportTarget(report) : null;
  const reportedEventId = target?.type === 'event' ? target.value : undefined;
  const reportedPubkey = report ? getReportedPubkey(report) : null;
  const reporterPubkey = report?.pubkey;

  // Get thread context if report is about an event
  const thread = useThread(reportedEventId, 3);

  // Get the pubkey of the reported user (from event author or direct p tag)
  const targetPubkey = thread.data?.event?.pubkey || reportedPubkey;

  // Get reported user's profile and stats
  const reportedUser = useAuthor(targetPubkey || undefined);
  const userStats = useUserStats(targetPubkey || undefined);

  // Get reporter's profile
  const reporter = useAuthor(reporterPubkey);

  // Get reporter's report count
  const reporterStats = useQuery({
    queryKey: ['reporter-stats', reporterPubkey],
    queryFn: async ({ signal }) => {
      if (!reporterPubkey) return { reportCount: 0 };

      const reports = await nostr.query(
        [{ kinds: [1984], authors: [reporterPubkey], limit: 100 }],
        { signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]) }
      );

      return { reportCount: reports.length };
    },
    enabled: !!reporterPubkey,
  });

  const isLoading = thread.isLoading || reportedUser.isLoading ||
                    userStats.isLoading || reporter.isLoading;

  const error = thread.error || reportedUser.error ||
                userStats.error || reporter.error;

  return {
    target,
    thread: thread.data,
    reportedUser: {
      profile: reportedUser.data?.metadata,
      pubkey: targetPubkey,
    },
    userStats: userStats.data,
    reporter: {
      profile: reporter.data?.metadata,
      pubkey: reporterPubkey,
      reportCount: reporterStats.data?.reportCount || 0,
    },
    isLoading,
    error,
  };
}
```

**Step 2: Commit**

```bash
git add src/hooks/useReportContext.ts
git commit -m "feat: add useReportContext hook aggregating all report context"
```

---

## Task 4: Create ThreadContext Component

**Files:**
- Create: `src/components/ThreadContext.tsx`

**Step 1: Create the component**

```typescript
// ABOUTME: Displays thread ancestry for a reported post (up to 3 levels)
// ABOUTME: Shows grandparent -> parent -> reported post with visual hierarchy

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuthor } from "@/hooks/useAuthor";
import { MessageSquare, ExternalLink } from "lucide-react";
import type { NostrEvent } from "@nostrify/nostrify";

interface ThreadContextProps {
  ancestors: NostrEvent[];
  reportedEvent: NostrEvent | null;
  onViewFullThread?: () => void;
  isLoading?: boolean;
}

function PostCard({
  event,
  isReported = false,
  depth = 0
}: {
  event: NostrEvent;
  isReported?: boolean;
  depth?: number;
}) {
  const author = useAuthor(event.pubkey);
  const displayName = author.data?.metadata?.name || event.pubkey.slice(0, 8) + '...';
  const avatar = author.data?.metadata?.picture;
  const date = new Date(event.created_at * 1000);

  return (
    <div
      className={`relative ${depth > 0 ? 'ml-6 border-l-2 border-muted pl-4' : ''}`}
    >
      <Card className={isReported ? 'border-destructive bg-destructive/5' : ''}>
        <CardContent className="p-3">
          <div className="flex items-start gap-3">
            <Avatar className="h-8 w-8">
              <AvatarImage src={avatar} />
              <AvatarFallback>{displayName.slice(0, 2).toUpperCase()}</AvatarFallback>
            </Avatar>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-medium text-sm">{displayName}</span>
                <span className="text-xs text-muted-foreground">
                  {date.toLocaleDateString()} {date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
                {isReported && (
                  <Badge variant="destructive" className="text-xs">Reported</Badge>
                )}
              </div>
              <p className="text-sm mt-1 whitespace-pre-wrap break-words">
                {event.content.slice(0, 500)}
                {event.content.length > 500 && '...'}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export function ThreadContext({
  ancestors,
  reportedEvent,
  onViewFullThread,
  isLoading
}: ThreadContextProps) {
  if (isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full ml-6" />
        <Skeleton className="h-24 w-full ml-12" />
      </div>
    );
  }

  if (!reportedEvent) {
    return (
      <div className="text-center py-8 text-muted-foreground">
        <MessageSquare className="h-8 w-8 mx-auto mb-2 opacity-50" />
        <p className="text-sm">No event content available</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between mb-3">
        <h4 className="text-sm font-medium text-muted-foreground">Thread Context</h4>
        {onViewFullThread && (
          <Button variant="ghost" size="sm" onClick={onViewFullThread}>
            <ExternalLink className="h-3 w-3 mr-1" />
            View Full Thread
          </Button>
        )}
      </div>

      {ancestors.map((event, index) => (
        <PostCard key={event.id} event={event} depth={index} />
      ))}

      <PostCard
        event={reportedEvent}
        isReported
        depth={ancestors.length}
      />
    </div>
  );
}
```

**Step 2: Commit**

```bash
git add src/components/ThreadContext.tsx
git commit -m "feat: add ThreadContext component for thread display"
```

---

## Task 5: Create UserProfileCard Component

**Files:**
- Create: `src/components/UserProfileCard.tsx`

**Step 1: Create the component**

```typescript
// ABOUTME: Displays user profile with stats, labels, and recent posts
// ABOUTME: Used in report detail view to show reported user context

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import { User, FileText, Flag, Tag, CheckCircle } from "lucide-react";
import type { NostrEvent, NostrMetadata } from "@nostrify/nostrify";
import type { UserStats } from "@/hooks/useUserStats";

// Label category colors
const LABEL_COLORS: Record<string, string> = {
  spam: 'bg-yellow-500',
  hate: 'bg-red-500',
  harassment: 'bg-orange-500',
  csam: 'bg-purple-900',
  violence: 'bg-red-700',
  scam: 'bg-amber-600',
  impersonation: 'bg-blue-500',
  default: 'bg-gray-500',
};

function getLabelColor(label: string): string {
  const lower = label.toLowerCase();
  for (const [key, color] of Object.entries(LABEL_COLORS)) {
    if (lower.includes(key)) return color;
  }
  return LABEL_COLORS.default;
}

interface UserProfileCardProps {
  profile?: NostrMetadata;
  pubkey?: string | null;
  stats?: UserStats;
  isLoading?: boolean;
}

export function UserProfileCard({ profile, pubkey, stats, isLoading }: UserProfileCardProps) {
  if (isLoading) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-3">
            <Skeleton className="h-12 w-12 rounded-full" />
            <div className="space-y-2">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-24" />
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-8 w-full" />
        </CardContent>
      </Card>
    );
  }

  if (!pubkey) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-muted-foreground">
          <User className="h-8 w-8 mx-auto mb-2 opacity-50" />
          <p className="text-sm">No user information available</p>
        </CardContent>
      </Card>
    );
  }

  const displayName = profile?.name || pubkey.slice(0, 12) + '...';
  const nip05 = profile?.nip05;

  // Extract unique labels from label events
  const labelCounts = new Map<string, number>();
  stats?.existingLabels?.forEach(event => {
    const lTag = event.tags.find(t => t[0] === 'l');
    if (lTag) {
      const label = lTag[1];
      labelCounts.set(label, (labelCounts.get(label) || 0) + 1);
    }
  });

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center gap-3">
          <Avatar className="h-12 w-12">
            <AvatarImage src={profile?.picture} />
            <AvatarFallback>{displayName.slice(0, 2).toUpperCase()}</AvatarFallback>
          </Avatar>
          <div>
            <CardTitle className="text-base">{displayName}</CardTitle>
            {nip05 && (
              <div className="flex items-center gap-1 text-sm text-muted-foreground">
                <CheckCircle className="h-3 w-3 text-green-500" />
                {nip05}
              </div>
            )}
            <p className="text-xs text-muted-foreground font-mono">
              {pubkey.slice(0, 16)}...
            </p>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {profile?.about && (
          <p className="text-sm text-muted-foreground line-clamp-3">
            {profile.about}
          </p>
        )}

        {/* Stats */}
        <div className="flex gap-4 text-sm">
          <div className="flex items-center gap-1">
            <FileText className="h-4 w-4 text-muted-foreground" />
            <span>{stats?.postCount || 0} posts</span>
          </div>
          <div className="flex items-center gap-1">
            <Flag className="h-4 w-4 text-muted-foreground" />
            <span>{stats?.reportCount || 0} reports</span>
          </div>
          <div className="flex items-center gap-1">
            <Tag className="h-4 w-4 text-muted-foreground" />
            <span>{stats?.labelCount || 0} labels</span>
          </div>
        </div>

        {/* Existing Labels */}
        {labelCounts.size > 0 && (
          <div className="space-y-2">
            <h5 className="text-xs font-medium text-muted-foreground uppercase">Existing Labels</h5>
            <div className="flex flex-wrap gap-1">
              {Array.from(labelCounts.entries()).map(([label, count]) => (
                <Badge
                  key={label}
                  variant="secondary"
                  className={`${getLabelColor(label)} text-white text-xs`}
                >
                  {label} ({count})
                </Badge>
              ))}
            </div>
          </div>
        )}

        {/* Recent Posts */}
        {stats?.recentPosts && stats.recentPosts.length > 0 && (
          <div className="space-y-2">
            <h5 className="text-xs font-medium text-muted-foreground uppercase">Recent Posts</h5>
            <ScrollArea className="h-32">
              <div className="space-y-2">
                {stats.recentPosts.slice(0, 5).map(post => (
                  <div key={post.id} className="text-xs p-2 bg-muted rounded">
                    <p className="line-clamp-2">{post.content}</p>
                    <p className="text-muted-foreground mt-1">
                      {new Date(post.created_at * 1000).toLocaleDateString()}
                    </p>
                  </div>
                ))}
              </div>
            </ScrollArea>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
```

**Step 2: Commit**

```bash
git add src/components/UserProfileCard.tsx
git commit -m "feat: add UserProfileCard component with stats and labels"
```

---

## Task 6: Create ReporterInfo Component

**Files:**
- Create: `src/components/ReporterInfo.tsx`

**Step 1: Create the component**

```typescript
// ABOUTME: Displays information about who submitted a report
// ABOUTME: Shows reporter profile and their report history count

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Flag, Star } from "lucide-react";
import type { NostrMetadata } from "@nostrify/nostrify";

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

  const displayName = profile?.name || pubkey.slice(0, 12) + '...';
  const trust = getTrustLevel(reportCount);

  return (
    <Card>
      <CardContent className="p-3">
        <h5 className="text-xs font-medium text-muted-foreground uppercase mb-2">
          Reported By
        </h5>
        <div className="flex items-center gap-3">
          <Avatar className="h-8 w-8">
            <AvatarImage src={profile?.picture} />
            <AvatarFallback>{displayName.slice(0, 2).toUpperCase()}</AvatarFallback>
          </Avatar>
          <div className="flex-1">
            <p className="text-sm font-medium">{displayName}</p>
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
```

**Step 2: Commit**

```bash
git add src/components/ReporterInfo.tsx
git commit -m "feat: add ReporterInfo component with trust level"
```

---

## Task 7: Create AISummary Component and Worker Endpoint

**Files:**
- Create: `src/components/AISummary.tsx`
- Create: `src/hooks/useUserSummary.ts`
- Modify: `worker/src/index.ts`

**Step 1: Create useUserSummary hook**

```typescript
// ABOUTME: Fetches AI-generated behavioral summary for a user
// ABOUTME: Calls worker endpoint that uses Claude API

import { useQuery } from "@tanstack/react-query";
import type { NostrEvent } from "@nostrify/nostrify";

const WORKER_URL = import.meta.env.VITE_WORKER_URL || '';

interface SummaryResponse {
  summary: string;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
}

export function useUserSummary(
  pubkey: string | undefined,
  recentPosts: NostrEvent[] | undefined,
  existingLabels: NostrEvent[] | undefined,
  previousReports: NostrEvent[] | undefined
) {
  return useQuery<SummaryResponse>({
    queryKey: ['user-summary', pubkey],
    queryFn: async () => {
      if (!pubkey || !recentPosts) {
        throw new Error('Missing required data');
      }

      const response = await fetch(`${WORKER_URL}/api/summarize-user`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pubkey,
          recentPosts: recentPosts.slice(0, 10).map(e => ({
            content: e.content,
            created_at: e.created_at,
          })),
          existingLabels: existingLabels?.map(e => ({
            tags: e.tags,
            created_at: e.created_at,
          })) || [],
          reportHistory: previousReports?.map(e => ({
            content: e.content,
            tags: e.tags,
            created_at: e.created_at,
          })) || [],
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      return response.json();
    },
    enabled: !!pubkey && !!recentPosts && recentPosts.length > 0,
    staleTime: 1000 * 60 * 60, // Cache for 1 hour
    retry: false, // Don't retry AI calls
  });
}
```

**Step 2: Create AISummary component**

```typescript
// ABOUTME: Displays AI-generated behavioral summary for reported user
// ABOUTME: Shows risk level badge and summary text

import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Bot, AlertTriangle, AlertCircle, ShieldAlert, Skull } from "lucide-react";

interface AISummaryProps {
  summary?: string;
  riskLevel?: 'low' | 'medium' | 'high' | 'critical';
  isLoading?: boolean;
  error?: Error | null;
}

const RISK_CONFIG = {
  low: {
    icon: AlertCircle,
    color: 'bg-green-500',
    textColor: 'text-green-700',
    label: 'Low Risk'
  },
  medium: {
    icon: AlertTriangle,
    color: 'bg-yellow-500',
    textColor: 'text-yellow-700',
    label: 'Medium Risk'
  },
  high: {
    icon: ShieldAlert,
    color: 'bg-orange-500',
    textColor: 'text-orange-700',
    label: 'High Risk'
  },
  critical: {
    icon: Skull,
    color: 'bg-red-600',
    textColor: 'text-red-700',
    label: 'Critical Risk'
  },
};

export function AISummary({ summary, riskLevel, isLoading, error }: AISummaryProps) {
  if (isLoading) {
    return (
      <Card>
        <CardContent className="p-3">
          <div className="flex items-center gap-2 mb-2">
            <Bot className="h-4 w-4 animate-pulse" />
            <span className="text-xs text-muted-foreground">Generating summary...</span>
          </div>
          <Skeleton className="h-12 w-full" />
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Alert variant="default" className="bg-muted">
        <Bot className="h-4 w-4" />
        <AlertDescription className="text-xs">
          AI summary unavailable
        </AlertDescription>
      </Alert>
    );
  }

  if (!summary) {
    return null;
  }

  const risk = riskLevel ? RISK_CONFIG[riskLevel] : RISK_CONFIG.low;
  const RiskIcon = risk.icon;

  return (
    <Card>
      <CardContent className="p-3">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <Bot className="h-4 w-4 text-muted-foreground" />
            <span className="text-xs font-medium text-muted-foreground uppercase">
              AI Analysis
            </span>
          </div>
          <Badge className={`${risk.color} text-white text-xs`}>
            <RiskIcon className="h-3 w-3 mr-1" />
            {risk.label}
          </Badge>
        </div>
        <p className="text-sm">{summary}</p>
      </CardContent>
    </Card>
  );
}
```

**Step 3: Add worker endpoint (append to worker/src/index.ts)**

```typescript
// Add this handler to the worker's fetch handler switch/if block

// POST /api/summarize-user - Generate AI summary of user behavior
if (request.method === 'POST' && url.pathname === '/api/summarize-user') {
  try {
    const body = await request.json() as {
      pubkey: string;
      recentPosts: Array<{ content: string; created_at: number }>;
      existingLabels: Array<{ tags: string[][]; created_at: number }>;
      reportHistory: Array<{ content: string; tags: string[][]; created_at: number }>;
    };

    // Check cache first
    const cacheKey = `summary:${body.pubkey}`;
    const cached = await env.KV?.get(cacheKey);
    if (cached) {
      return new Response(cached, {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Build context for Claude
    const postSummary = body.recentPosts
      .map(p => `- "${p.content.slice(0, 200)}"`)
      .join('\n');

    const labelSummary = body.existingLabels
      .map(l => {
        const label = l.tags.find(t => t[0] === 'l')?.[1] || 'unknown';
        return `- ${label}`;
      })
      .join('\n') || 'None';

    const reportSummary = body.reportHistory
      .map(r => {
        const category = r.tags.find(t => t[0] === 'report')?.[1] || 'unknown';
        return `- ${category}: ${r.content?.slice(0, 100) || 'no details'}`;
      })
      .join('\n') || 'None';

    const prompt = `You are a trust & safety analyst. Analyze this Nostr user and provide a brief 2-3 sentence summary of their behavior patterns and risk level.

Recent posts (${body.recentPosts.length} total):
${postSummary}

Existing moderation labels:
${labelSummary}

Previous reports against them:
${reportSummary}

Respond with JSON only:
{
  "summary": "2-3 sentence behavioral summary",
  "riskLevel": "low|medium|high|critical"
}`;

    const claudeResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-3-haiku-20240307',
        max_tokens: 256,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!claudeResponse.ok) {
      throw new Error(`Claude API error: ${claudeResponse.status}`);
    }

    const claudeData = await claudeResponse.json() as {
      content: Array<{ type: string; text: string }>;
    };

    const responseText = claudeData.content[0]?.text || '';
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);

    if (!jsonMatch) {
      throw new Error('Invalid response format');
    }

    const result = JSON.parse(jsonMatch[0]);

    // Cache for 1 hour
    await env.KV?.put(cacheKey, JSON.stringify(result), { expirationTtl: 3600 });

    return new Response(JSON.stringify(result), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Summarize error:', error);
    return new Response(JSON.stringify({
      error: 'Failed to generate summary',
      summary: 'Unable to analyze user behavior at this time.',
      riskLevel: 'medium'
    }), {
      status: 200, // Return 200 with fallback to not break UI
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
```

**Step 4: Commit**

```bash
git add src/hooks/useUserSummary.ts src/components/AISummary.tsx worker/src/index.ts
git commit -m "feat: add AI summary component and worker endpoint"
```

---

## Task 8: Create ReportDetail Component

**Files:**
- Create: `src/components/ReportDetail.tsx`

**Step 1: Create the component**

```typescript
// ABOUTME: Full detail view for a selected report in the split-pane layout
// ABOUTME: Combines thread context, user profile, AI summary, and action buttons

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/useToast";
import { useReportContext } from "@/hooks/useReportContext";
import { useUserSummary } from "@/hooks/useUserSummary";
import { ThreadContext } from "@/components/ThreadContext";
import { UserProfileCard } from "@/components/UserProfileCard";
import { ReporterInfo } from "@/components/ReporterInfo";
import { AISummary } from "@/components/AISummary";
import { LabelPublisherInline } from "@/components/LabelPublisher";
import { ThreadModal } from "@/components/ThreadModal";
import { banPubkey } from "@/lib/adminApi";
import { UserX, Tag, XCircle, Flag } from "lucide-react";
import type { NostrEvent } from "@nostrify/nostrify";

// DTSP category display names
const CATEGORY_LABELS: Record<string, string> = {
  'sexual_minors': 'CSAM',
  'nonconsensual_sexual_content': 'Non-consensual',
  'credible_threats': 'Threats',
  'doxxing_pii': 'Doxxing/PII',
  'terrorism_extremism': 'Terrorism',
  'malware_scam': 'Malware/Scam',
  'illegal_goods': 'Illegal Goods',
  'hate_harassment': 'Hate/Harassment',
  'self_harm_suicide': 'Self-harm',
  'graphic_violence_gore': 'Violence/Gore',
  'bullying_abuse': 'Bullying',
  'adult_nudity': 'Nudity',
  'explicit_sex': 'Explicit',
  'pornography': 'Pornography',
  'spam': 'Spam',
  'impersonation': 'Impersonation',
  'copyright': 'Copyright',
  'other': 'Other',
};

function getReportCategory(event: NostrEvent): string {
  const reportTag = event.tags.find(t => t[0] === 'report');
  if (reportTag && reportTag[1]) return reportTag[1];
  const lTag = event.tags.find(t => t[0] === 'l');
  if (lTag && lTag[1]) return lTag[1];
  return 'other';
}

interface ReportDetailProps {
  report: NostrEvent | null;
  onDismiss?: () => void;
}

export function ReportDetail({ report, onDismiss }: ReportDetailProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [showThreadModal, setShowThreadModal] = useState(false);
  const [showLabelForm, setShowLabelForm] = useState(false);
  const [confirmBan, setConfirmBan] = useState(false);

  const context = useReportContext(report);

  const summary = useUserSummary(
    context.reportedUser.pubkey || undefined,
    context.userStats?.recentPosts,
    context.userStats?.existingLabels,
    context.userStats?.previousReports
  );

  const banMutation = useMutation({
    mutationFn: async ({ pubkey, reason }: { pubkey: string; reason: string }) => {
      await banPubkey(pubkey, reason);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['banned-users'] });
      queryClient.invalidateQueries({ queryKey: ['banned-pubkeys'] });
      toast({ title: "User banned successfully" });
      setConfirmBan(false);
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to ban user",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  if (!report) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground">
        <div className="text-center">
          <Flag className="h-12 w-12 mx-auto mb-4 opacity-50" />
          <p>Select a report to view details</p>
        </div>
      </div>
    );
  }

  const category = getReportCategory(report);
  const categoryLabel = CATEGORY_LABELS[category] || category;

  return (
    <>
      {/* Ban Confirmation Dialog */}
      <AlertDialog open={confirmBan} onOpenChange={setConfirmBan}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Ban User?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently ban this user from the relay.
              <br />
              <code className="text-xs bg-muted px-1 py-0.5 rounded mt-2 inline-block">
                {context.reportedUser.pubkey?.slice(0, 24)}...
              </code>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={banMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (context.reportedUser.pubkey) {
                  banMutation.mutate({
                    pubkey: context.reportedUser.pubkey,
                    reason: `Report: ${categoryLabel}`,
                  });
                }
              }}
              disabled={banMutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {banMutation.isPending ? 'Banning...' : 'Ban User'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Thread Modal */}
      {context.target?.type === 'event' && (
        <ThreadModal
          eventId={context.target.value}
          open={showThreadModal}
          onOpenChange={setShowThreadModal}
        />
      )}

      <ScrollArea className="h-full">
        <div className="p-4 space-y-4">
          {/* Header */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Badge variant="outline">{categoryLabel}</Badge>
              <Badge variant="secondary">
                {context.target?.type === 'event' ? 'Event' : 'User'}
              </Badge>
            </div>
            <span className="text-xs text-muted-foreground">
              {new Date(report.created_at * 1000).toLocaleString()}
            </span>
          </div>

          {/* Report Content */}
          {report.content && (
            <Card>
              <CardContent className="p-3">
                <p className="text-sm">{report.content}</p>
              </CardContent>
            </Card>
          )}

          <Separator />

          {/* Thread Context */}
          {context.target?.type === 'event' && (
            <ThreadContext
              ancestors={context.thread?.ancestors || []}
              reportedEvent={context.thread?.event || null}
              onViewFullThread={() => setShowThreadModal(true)}
              isLoading={context.isLoading}
            />
          )}

          <Separator />

          {/* Reported User */}
          <UserProfileCard
            profile={context.reportedUser.profile}
            pubkey={context.reportedUser.pubkey}
            stats={context.userStats}
            isLoading={context.isLoading}
          />

          {/* AI Summary */}
          <AISummary
            summary={summary.data?.summary}
            riskLevel={summary.data?.riskLevel}
            isLoading={summary.isLoading}
            error={summary.error as Error | null}
          />

          <Separator />

          {/* Reporter Info */}
          <ReporterInfo
            profile={context.reporter.profile}
            pubkey={context.reporter.pubkey}
            reportCount={context.reporter.reportCount}
            isLoading={context.isLoading}
          />

          <Separator />

          {/* Inline Label Form */}
          {showLabelForm && context.target && (
            <LabelPublisherInline
              targetType={context.target.type}
              targetValue={context.target.value}
              onSuccess={() => setShowLabelForm(false)}
              onCancel={() => setShowLabelForm(false)}
            />
          )}

          {/* Action Buttons */}
          <div className="flex gap-2 pt-2">
            {context.reportedUser.pubkey && (
              <Button
                variant="destructive"
                onClick={() => setConfirmBan(true)}
                disabled={banMutation.isPending}
              >
                <UserX className="h-4 w-4 mr-1" />
                Ban User
              </Button>
            )}
            {context.target && !showLabelForm && (
              <Button
                variant="outline"
                onClick={() => setShowLabelForm(true)}
              >
                <Tag className="h-4 w-4 mr-1" />
                Create Label
              </Button>
            )}
            {onDismiss && (
              <Button variant="ghost" onClick={onDismiss}>
                <XCircle className="h-4 w-4 mr-1" />
                Dismiss
              </Button>
            )}
          </div>
        </div>
      </ScrollArea>
    </>
  );
}
```

**Step 2: Commit**

```bash
git add src/components/ReportDetail.tsx
git commit -m "feat: add ReportDetail component with full context view"
```

---

## Task 9: Create ThreadModal Component

**Files:**
- Create: `src/components/ThreadModal.tsx`

**Step 1: Create the component**

```typescript
// ABOUTME: Modal dialog showing the complete thread for a reported event
// ABOUTME: Displays full conversation with nested replies

import { useNostr } from "@nostrify/react";
import { useQuery } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuthor } from "@/hooks/useAuthor";
import { MessageSquare } from "lucide-react";
import type { NostrEvent } from "@nostrify/nostrify";

interface ThreadModalProps {
  eventId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  highlightEventId?: string;
}

interface ThreadNode {
  event: NostrEvent;
  replies: ThreadNode[];
  depth: number;
}

function buildThreadTree(events: NostrEvent[], rootId: string): ThreadNode | null {
  const eventMap = new Map<string, NostrEvent>();
  events.forEach(e => eventMap.set(e.id, e));

  const root = eventMap.get(rootId);
  if (!root) return null;

  function buildNode(event: NostrEvent, depth: number): ThreadNode {
    const replies = events
      .filter(e => {
        const replyTag = e.tags.find(t => t[0] === 'e' && (t[3] === 'reply' || !t[3]));
        return replyTag && replyTag[1] === event.id;
      })
      .map(e => buildNode(e, depth + 1))
      .sort((a, b) => a.event.created_at - b.event.created_at);

    return { event, replies, depth };
  }

  return buildNode(root, 0);
}

function ThreadPost({
  node,
  highlightId
}: {
  node: ThreadNode;
  highlightId?: string;
}) {
  const author = useAuthor(node.event.pubkey);
  const displayName = author.data?.metadata?.name || node.event.pubkey.slice(0, 8) + '...';
  const avatar = author.data?.metadata?.picture;
  const date = new Date(node.event.created_at * 1000);
  const isHighlighted = node.event.id === highlightId;

  return (
    <div className={`${node.depth > 0 ? 'ml-4 border-l-2 border-muted pl-3' : ''}`}>
      <div
        className={`p-3 rounded-lg mb-2 ${
          isHighlighted
            ? 'bg-destructive/10 border border-destructive'
            : 'bg-muted/50'
        }`}
      >
        <div className="flex items-start gap-2">
          <Avatar className="h-6 w-6">
            <AvatarImage src={avatar} />
            <AvatarFallback className="text-xs">
              {displayName.slice(0, 2).toUpperCase()}
            </AvatarFallback>
          </Avatar>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-medium">{displayName}</span>
              <span className="text-xs text-muted-foreground">
                {date.toLocaleString()}
              </span>
              {isHighlighted && (
                <Badge variant="destructive" className="text-xs">Reported</Badge>
              )}
            </div>
            <p className="text-sm mt-1 whitespace-pre-wrap break-words">
              {node.event.content}
            </p>
          </div>
        </div>
      </div>
      {node.replies.map(reply => (
        <ThreadPost key={reply.event.id} node={reply} highlightId={highlightId} />
      ))}
    </div>
  );
}

export function ThreadModal({ eventId, open, onOpenChange, highlightEventId }: ThreadModalProps) {
  const { nostr } = useNostr();

  // Fetch full thread
  const { data: thread, isLoading } = useQuery({
    queryKey: ['full-thread', eventId],
    queryFn: async ({ signal }) => {
      const timeout = AbortSignal.timeout(10000);
      const combinedSignal = AbortSignal.any([signal, timeout]);

      // First get the target event to find root
      const [targetEvent] = await nostr.query(
        [{ ids: [eventId], limit: 1 }],
        { signal: combinedSignal }
      );

      if (!targetEvent) return null;

      // Find root event ID
      const rootTag = targetEvent.tags.find(t => t[0] === 'e' && t[3] === 'root');
      const rootId = rootTag ? rootTag[1] : eventId;

      // Fetch all events in thread
      const [rootEvent] = await nostr.query(
        [{ ids: [rootId], limit: 1 }],
        { signal: combinedSignal }
      );

      const replies = await nostr.query(
        [{ kinds: [1], '#e': [rootId], limit: 100 }],
        { signal: combinedSignal }
      );

      const allEvents = rootEvent ? [rootEvent, ...replies] : replies;
      return buildThreadTree(allEvents, rootId);
    },
    enabled: open && !!eventId,
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MessageSquare className="h-5 w-5" />
            Full Thread
          </DialogTitle>
        </DialogHeader>
        <ScrollArea className="h-[60vh] pr-4">
          {isLoading ? (
            <div className="space-y-3">
              {[...Array(5)].map((_, i) => (
                <Skeleton key={i} className="h-20 w-full" />
              ))}
            </div>
          ) : thread ? (
            <ThreadPost node={thread} highlightId={highlightEventId || eventId} />
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              <p>Could not load thread</p>
            </div>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
```

**Step 2: Commit**

```bash
git add src/components/ThreadModal.tsx
git commit -m "feat: add ThreadModal for viewing full conversation"
```

---

## Task 10: Refactor Reports.tsx to Split-Pane Layout

**Files:**
- Modify: `src/components/Reports.tsx`

**Step 1: Replace Reports.tsx with split-pane layout**

```typescript
// ABOUTME: Displays kind 1984 reports with split-pane layout
// ABOUTME: List on left, full context detail view on right

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNostr } from "@nostrify/react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Flag, RefreshCw, Clock } from "lucide-react";
import { ReportDetail } from "@/components/ReportDetail";
import type { NostrEvent } from "@nostrify/nostrify";

interface ReportsProps {
  relayUrl: string;
}

// DTSP category display names
const CATEGORY_LABELS: Record<string, string> = {
  'sexual_minors': 'CSAM',
  'nonconsensual_sexual_content': 'Non-consensual',
  'credible_threats': 'Threats',
  'doxxing_pii': 'Doxxing/PII',
  'terrorism_extremism': 'Terrorism',
  'malware_scam': 'Malware/Scam',
  'illegal_goods': 'Illegal Goods',
  'hate_harassment': 'Hate/Harassment',
  'self_harm_suicide': 'Self-harm',
  'graphic_violence_gore': 'Violence/Gore',
  'bullying_abuse': 'Bullying',
  'adult_nudity': 'Nudity',
  'explicit_sex': 'Explicit',
  'pornography': 'Pornography',
  'spam': 'Spam',
  'impersonation': 'Impersonation',
  'copyright': 'Copyright',
  'other': 'Other',
};

function getReportCategory(event: NostrEvent): string {
  const reportTag = event.tags.find(t => t[0] === 'report');
  if (reportTag && reportTag[1]) return reportTag[1];
  const lTag = event.tags.find(t => t[0] === 'l');
  if (lTag && lTag[1]) return lTag[1];
  return 'other';
}

function getReportTarget(event: NostrEvent): { type: 'event' | 'pubkey'; value: string } | null {
  const eTag = event.tags.find(t => t[0] === 'e');
  if (eTag) return { type: 'event', value: eTag[1] };
  const pTag = event.tags.find(t => t[0] === 'p');
  if (pTag) return { type: 'pubkey', value: pTag[1] };
  return null;
}

function ReportListItem({
  report,
  isSelected,
  onClick
}: {
  report: NostrEvent;
  isSelected: boolean;
  onClick: () => void;
}) {
  const category = getReportCategory(report);
  const target = getReportTarget(report);
  const categoryLabel = CATEGORY_LABELS[category] || category;

  return (
    <div
      className={`p-3 border rounded-lg cursor-pointer transition-colors ${
        isSelected
          ? 'border-primary bg-primary/5 ring-1 ring-primary'
          : 'hover:bg-muted/50'
      }`}
      onClick={onClick}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="space-y-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <Badge variant="outline" className="text-xs">{categoryLabel}</Badge>
            {target && (
              <Badge variant="secondary" className="text-xs">
                {target.type === 'event' ? 'Event' : 'User'}
              </Badge>
            )}
          </div>
          {target && (
            <p className="text-xs text-muted-foreground font-mono truncate">
              {target.value.slice(0, 16)}...
            </p>
          )}
        </div>
        <div className="flex items-center gap-1 text-xs text-muted-foreground shrink-0">
          <Clock className="h-3 w-3" />
          {new Date(report.created_at * 1000).toLocaleDateString()}
        </div>
      </div>
    </div>
  );
}

export function Reports({ relayUrl }: ReportsProps) {
  const { nostr } = useNostr();
  const [selectedReport, setSelectedReport] = useState<NostrEvent | null>(null);

  const { data: reports, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['reports', relayUrl],
    queryFn: async ({ signal }) => {
      const events = await nostr.query(
        [{ kinds: [1984], limit: 100 }],
        { signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) }
      );
      return events.sort((a, b) => b.created_at - a.created_at);
    },
  });

  if (isLoading) {
    return (
      <Card className="h-[calc(100vh-200px)]">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Flag className="h-5 w-5" />
            User Reports
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {[...Array(5)].map((_, i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertDescription>
          Failed to load reports: {error instanceof Error ? error.message : "Unknown error"}
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-5 gap-4 h-[calc(100vh-200px)]">
      {/* Left Pane - Report List */}
      <Card className="lg:col-span-2">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2 text-lg">
                <Flag className="h-5 w-5" />
                Reports
              </CardTitle>
              <CardDescription>
                {reports?.length || 0} reports
              </CardDescription>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => refetch()}
              disabled={isFetching}
            >
              <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <ScrollArea className="h-[calc(100vh-320px)]">
            <div className="space-y-2 p-4 pt-0">
              {!reports || reports.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  <Flag className="h-8 w-8 mx-auto mb-2 opacity-50" />
                  <p className="text-sm">No reports found</p>
                </div>
              ) : (
                reports.map((report) => (
                  <ReportListItem
                    key={report.id}
                    report={report}
                    isSelected={selectedReport?.id === report.id}
                    onClick={() => setSelectedReport(report)}
                  />
                ))
              )}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>

      {/* Right Pane - Report Detail */}
      <Card className="lg:col-span-3 overflow-hidden">
        <ReportDetail
          report={selectedReport}
          onDismiss={() => setSelectedReport(null)}
        />
      </Card>
    </div>
  );
}
```

**Step 2: Commit**

```bash
git add src/components/Reports.tsx
git commit -m "refactor: Reports to split-pane layout with full context"
```

---

## Task 11: Add ANTHROPIC_API_KEY to Worker Config

**Files:**
- Modify: `worker/wrangler.toml` (if needed)

**Step 1: Add the secret via Wrangler CLI**

Run:
```bash
cd worker && npx wrangler secret put ANTHROPIC_API_KEY
```

Enter your Anthropic API key when prompted.

**Step 2: Add KV namespace for caching (if not exists)**

```bash
npx wrangler kv:namespace create "SUMMARY_CACHE"
```

Update `wrangler.toml`:
```toml
kv_namespaces = [
  { binding = "KV", id = "your-namespace-id" }
]
```

**Step 3: Deploy worker**

```bash
npx wrangler deploy
```

---

## Task 12: Build and Test

**Step 1: Run build**

```bash
npm run build
```

Expected: Build succeeds with no errors

**Step 2: Run dev server and test manually**

```bash
npm run dev
```

Test checklist:
- [ ] Reports tab shows split-pane layout
- [ ] Clicking a report loads detail view
- [ ] Thread context shows 3 levels
- [ ] "View Full Thread" opens modal
- [ ] User profile shows stats and labels
- [ ] AI summary loads (or shows "unavailable" gracefully)
- [ ] Reporter info shows with trust level
- [ ] Ban User works with confirmation
- [ ] Create Label opens inline form

**Step 3: Commit final state**

```bash
git add -A
git commit -m "feat: complete rich moderation context implementation"
```

---

## Summary

This plan implements:
1. **3 new hooks**: useThread, useUserStats, useReportContext
2. **6 new components**: ThreadContext, UserProfileCard, ReporterInfo, AISummary, ReportDetail, ThreadModal
3. **1 refactored component**: Reports.tsx (split-pane layout)
4. **1 worker endpoint**: /api/summarize-user (AI summaries)

Total commits: 11
