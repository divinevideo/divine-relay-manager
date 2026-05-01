// ABOUTME: Shared formatting helpers for product and trust dashboard stats
// ABOUTME: Keeps compact and detailed stats views consistent

import type { MetricStatus } from './adminApi';

export const DASHBOARD_STATS_QUERY_KEY = ['dashboard-stats'] as const;

export function formatCount(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '0';
  return new Intl.NumberFormat('en', {
    notation: value >= 10_000 ? 'compact' : 'standard',
    maximumFractionDigits: 1,
  }).format(value);
}

export function formatStatus(status: MetricStatus): string {
  switch (status) {
    case 'live':
      return 'Live';
    case 'partial':
      return 'Partial';
    case 'unavailable':
      return 'Unavailable';
    case 'error':
      return 'Error';
  }
}

export function statusTone(status: MetricStatus): string {
  switch (status) {
    case 'live':
      return 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300';
    case 'partial':
      return 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300';
    case 'unavailable':
      return 'border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300';
    case 'error':
      return 'border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300';
  }
}

export function shortId(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  if (value.length <= 18) return value;
  return `${value.slice(0, 10)}...${value.slice(-6)}`;
}
