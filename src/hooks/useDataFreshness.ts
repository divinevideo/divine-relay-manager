// ABOUTME: Hook that returns a human-readable relative time string
// ABOUTME: Updates every 5 seconds — "just now", "12s ago", "3m ago"

import { useState, useEffect } from "react";

function formatRelativeTime(dataUpdatedAt: number): string {
  const seconds = Math.floor((Date.now() - dataUpdatedAt) / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ago`;
}

export function useDataFreshness(dataUpdatedAt: number | undefined): string {
  const [text, setText] = useState<string>("");

  useEffect(() => {
    if (!dataUpdatedAt) return;

    const update = () => setText(formatRelativeTime(dataUpdatedAt));
    update();
    const interval = setInterval(update, 5000);
    return () => clearInterval(interval);
  }, [dataUpdatedAt]);

  return text;
}

// Exported for testing
export { formatRelativeTime };
