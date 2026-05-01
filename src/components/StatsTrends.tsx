// ABOUTME: Detailed product and trust stats dashboard page
// ABOUTME: Expands the top pulse into source status, engagement, and trust trend tables

import { useQuery } from '@tanstack/react-query';
import type { ComponentType } from 'react';
import { AlertTriangle, BarChart3, Eye, Flag, Repeat2, Users, Video } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useAdminApi } from '@/hooks/useAdminApi';
import {
  DASHBOARD_STATS_QUERY_KEY,
  formatCount,
  formatStatus,
  shortId,
  statusTone,
} from '@/lib/dashboardStatsFormat';
import type { DashboardMetric, DashboardStats, LeaderboardCreator, LeaderboardVideo } from '@/lib/adminApi';

interface StatBoxProps {
  label: string;
  value: number;
  icon: ComponentType<{ className?: string }>;
}

function StatusPill({ status }: { status: DashboardMetric<unknown>['status'] }) {
  return (
    <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${statusTone(status)}`}>
      {formatStatus(status)}
    </span>
  );
}

function StatBox({ label, value, icon: Icon }: StatBoxProps) {
  return (
    <div aria-label={label} className="rounded-md border bg-background p-4 shadow-sm">
      <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
        <Icon className="h-4 w-4 shrink-0" />
        <span>{label}</span>
      </div>
      <div className="mt-2 text-3xl font-semibold tabular-nums leading-none">
        {formatCount(value)}
      </div>
    </div>
  );
}

function SourceStatus({
  label,
  metric,
}: {
  label: string;
  metric: DashboardMetric<unknown>;
}) {
  return (
    <div aria-label={label} className="flex items-center justify-between gap-3 rounded-md border bg-background px-3 py-2">
      <span className="text-sm font-medium">{label}</span>
      <StatusPill status={metric.status} />
    </div>
  );
}

function LoadingState() {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Skeleton className="h-8 w-44" />
        <Skeleton className="h-5 w-32" />
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <Skeleton key={index} className="h-28 rounded-md" />
        ))}
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <Skeleton className="h-64 rounded-md" />
        <Skeleton className="h-64 rounded-md" />
      </div>
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
      <div className="flex items-center gap-2 font-medium">
        <AlertTriangle className="h-4 w-4" />
        <span>Stats unavailable</span>
      </div>
      <p className="mt-1 text-sm opacity-80">{message}</p>
    </div>
  );
}

function videoLabel(video: LeaderboardVideo): string {
  return shortId(video.id || video.event_id, 'unknown video');
}

function authorLabel(video: LeaderboardVideo): string {
  return shortId(video.author || video.pubkey, 'unknown author');
}

function TopVideosTable({ videos }: { videos: LeaderboardVideo[] }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-lg">Top videos</CardTitle>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Video</TableHead>
              <TableHead className="text-right">Views</TableHead>
              <TableHead className="text-right">Loops</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {videos.length === 0 ? (
              <TableRow>
                <TableCell colSpan={3} className="text-muted-foreground">No video leaderboard rows</TableCell>
              </TableRow>
            ) : videos.map(video => (
              <TableRow key={video.id || video.event_id || `${video.author}-${video.views}`}>
                <TableCell>
                  <div className="font-medium">{videoLabel(video)}</div>
                  <div className="text-xs text-muted-foreground">by {authorLabel(video)}</div>
                </TableCell>
                <TableCell className="text-right tabular-nums">{formatCount(video.views)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatCount(video.loops)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function TopCreatorsTable({ creators }: { creators: LeaderboardCreator[] }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-lg">Top creators</CardTitle>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Creator</TableHead>
              <TableHead className="text-right">Videos</TableHead>
              <TableHead className="text-right">Loops</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {creators.length === 0 ? (
              <TableRow>
                <TableCell colSpan={3} className="text-muted-foreground">No creator leaderboard rows</TableCell>
              </TableRow>
            ) : creators.map(creator => (
              <TableRow key={creator.pubkey}>
                <TableCell className="font-medium">{shortId(creator.pubkey, 'unknown creator')}</TableCell>
                <TableCell className="text-right tabular-nums">{formatCount(creator.videos_with_views)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatCount(creator.loops)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function renderStats(stats: DashboardStats) {
  const metrics = [
    {
      label: 'Active users',
      value: stats.videoActivity.value.activePublishersLastDay,
      icon: Users,
    },
    {
      label: 'Videos last day',
      value: stats.videoActivity.value.postsLastDay,
      icon: Video,
    },
    {
      label: 'Views last day',
      value: stats.engagement.value.viewsLastDay,
      icon: Eye,
    },
    {
      label: 'Loops last day',
      value: stats.engagement.value.loopsLastDay,
      icon: Repeat2,
    },
    {
      label: 'Pending reports',
      value: stats.trust.value.pendingReports,
      icon: Flag,
    },
    {
      label: 'Report targets',
      value: stats.trust.value.reportTargets,
      icon: AlertTriangle,
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center gap-3">
          <div className="rounded-md bg-blue-600 p-2 text-white">
            <BarChart3 className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-normal">Stats & Trends</h1>
            <p className="text-sm text-muted-foreground">
              Updated {new Date(stats.generatedAt).toLocaleString()}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <StatusPill status={stats.platform.status} />
          <StatusPill status={stats.trust.status} />
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
        {metrics.map(metric => (
          <StatBox key={metric.label} {...metric} />
        ))}
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <SourceStatus label="Platform stats" metric={stats.platform} />
        <SourceStatus label="Video activity" metric={stats.videoActivity} />
        <SourceStatus label="Registrations" metric={stats.auth.registrations} />
        <SourceStatus label="Logins" metric={stats.auth.logins} />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <TopVideosTable videos={stats.topVideos.value} />
        <TopCreatorsTable creators={stats.topCreators.value} />
      </div>
    </div>
  );
}

export function StatsTrends() {
  const adminApi = useAdminApi();
  const { data, isLoading, isError, error } = useQuery({
    queryKey: DASHBOARD_STATS_QUERY_KEY,
    queryFn: adminApi.fetchDashboardStats,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  if (isLoading) {
    return <LoadingState />;
  }

  if (isError || !data?.stats) {
    return (
      <ErrorState message={error instanceof Error ? error.message : 'Unable to load dashboard stats.'} />
    );
  }

  return renderStats(data.stats);
}
