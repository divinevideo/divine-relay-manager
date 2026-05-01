// ABOUTME: Compact product and trust stats strip for the admin dashboard
// ABOUTME: Shows key operational health signals with a link to detailed trends

import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { ComponentType } from 'react';
import { AlertTriangle, ArrowRight, Flag, Repeat2, Users, Video } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useAdminApi } from '@/hooks/useAdminApi';
import { DASHBOARD_STATS_QUERY_KEY, formatCount, formatStatus, statusTone } from '@/lib/dashboardStatsFormat';
import type { DashboardStats } from '@/lib/adminApi';

interface PulseMetricProps {
  label: string;
  value: number;
  icon: ComponentType<{ className?: string }>;
}

function PulseMetric({ label, value, icon: Icon }: PulseMetricProps) {
  return (
    <div
      aria-label={label}
      className="rounded-md border bg-background px-3 py-2 shadow-sm"
    >
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <Icon className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{label}</span>
      </div>
      <div className="mt-1 text-2xl font-semibold tabular-nums leading-none">
        {formatCount(value)}
      </div>
    </div>
  );
}

function PulseSkeleton() {
  return (
    <section className="rounded-lg border bg-white/85 p-3 shadow-sm dark:bg-gray-900/85">
      <div className="flex items-center justify-between gap-3">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-8 w-28" />
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, index) => (
          <Skeleton key={index} className="h-16 rounded-md" />
        ))}
      </div>
    </section>
  );
}

function metricsFromStats(stats: DashboardStats) {
  return [
    {
      label: 'Active users',
      value: stats.videoActivity.value.activePublishersLastDay,
      icon: Users,
    },
    {
      label: 'Video posts',
      value: stats.platform.value?.total_videos ?? 0,
      icon: Video,
    },
    {
      label: 'Videos last hour',
      value: stats.videoActivity.value.postsLastHour,
      icon: Video,
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
  ];
}

export function DashboardPulse() {
  const adminApi = useAdminApi();
  const { data, isLoading, isError, error } = useQuery({
    queryKey: DASHBOARD_STATS_QUERY_KEY,
    queryFn: adminApi.fetchDashboardStats,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  if (isLoading) {
    return <PulseSkeleton />;
  }

  if (isError || !data?.stats) {
    return (
      <section className="rounded-lg border border-red-200 bg-red-50 p-3 text-red-800 shadow-sm dark:border-red-900 dark:bg-red-950 dark:text-red-200">
        <div className="flex items-center gap-2 text-sm font-medium">
          <AlertTriangle className="h-4 w-4" />
          <span>Stats unavailable</span>
        </div>
        <p className="mt-1 text-sm opacity-80">
          {error instanceof Error ? error.message : 'Unable to load dashboard stats.'}
        </p>
      </section>
    );
  }

  const stats = data.stats;

  return (
    <section className="rounded-lg border bg-white/85 p-3 shadow-sm backdrop-blur-sm dark:bg-gray-900/85">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold leading-none">Product + Trust Pulse</h2>
            <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${statusTone(stats.videoActivity.status)}`}>
              {formatStatus(stats.videoActivity.status)}
            </span>
            <span className="text-xs text-muted-foreground">
              Updated {new Date(stats.generatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
            </span>
          </div>
        </div>
        <Button asChild variant="outline" size="sm" className="shrink-0 self-start lg:self-auto">
          <Link to="/stats">
            Stats & trends
            <ArrowRight className="ml-2 h-4 w-4" />
          </Link>
        </Button>
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        {metricsFromStats(stats).map(metric => (
          <PulseMetric
            key={metric.label}
            label={metric.label}
            value={metric.value}
            icon={metric.icon}
          />
        ))}
      </div>
    </section>
  );
}
