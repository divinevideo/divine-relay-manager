// ABOUTME: Reusable data freshness indicator with refresh button
// ABOUTME: Shows relative time since last fetch + spinning refresh icon

import { Button } from "@/components/ui/button";
import { RefreshCw } from "lucide-react";
import { useDataFreshness } from "@/hooks/useDataFreshness";

interface DataFreshnessProps {
  dataUpdatedAt: number | undefined;
  onRefresh: () => void;
  isRefetching: boolean;
}

export function DataFreshness({ dataUpdatedAt, onRefresh, isRefetching }: DataFreshnessProps) {
  const lastUpdatedText = useDataFreshness(dataUpdatedAt);

  return (
    <div className="flex items-center gap-2">
      {lastUpdatedText && (
        <span className="text-xs text-muted-foreground hidden sm:inline">
          {lastUpdatedText}
        </span>
      )}
      <Button
        variant="outline"
        size="sm"
        onClick={onRefresh}
        disabled={isRefetching}
        title={lastUpdatedText ? `Last updated ${lastUpdatedText}` : "Refresh"}
        className="min-w-[44px] min-h-[44px] sm:min-w-0 sm:min-h-0"
      >
        <RefreshCw className={`h-4 w-4 ${isRefetching ? "animate-spin" : ""}`} />
      </Button>
    </div>
  );
}
