// ABOUTME: Inline warning when a query result hits its limit
// ABOUTME: Renders nothing when count < limit, amber warning when count >= limit

import { AlertTriangle } from "lucide-react";

interface TruncationWarningProps {
  count: number;
  limit: number;
  noun?: string;
}

export function TruncationWarning({ count, limit, noun = "results" }: TruncationWarningProps) {
  if (count < limit) return null;

  return (
    <span className="inline-flex items-center gap-1 text-xs text-amber-600">
      <AlertTriangle className="h-3 w-3 shrink-0" />
      Showing {count} {noun} (limit reached — there may be more)
    </span>
  );
}
