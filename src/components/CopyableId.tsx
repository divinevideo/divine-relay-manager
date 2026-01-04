// ABOUTME: Reusable component for displaying truncated IDs with click-to-copy functionality
// ABOUTME: Handles event IDs, note IDs, hashes, and npubs with appropriate formatting

import { useState } from "react";
import { nip19 } from "nostr-tools";
import { Copy, Check } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface CopyableIdProps {
  /** The raw value to copy (hex id, hash, etc.) */
  value: string;
  /** Type of ID for formatting. 'note' and 'npub' will encode to bech32 */
  type?: 'event' | 'note' | 'npub' | 'hash' | 'hex';
  /** Number of characters to show at start */
  truncateStart?: number;
  /** Number of characters to show at end */
  truncateEnd?: number;
  /** Optional label to show before the ID */
  label?: string;
  /** Additional class names */
  className?: string;
  /** Size variant */
  size?: 'xs' | 'sm' | 'md';
}

export function CopyableId({
  value,
  type = 'hex',
  truncateStart = 12,
  truncateEnd = 4,
  label,
  className,
  size = 'sm',
}: CopyableIdProps) {
  const [copied, setCopied] = useState(false);

  // Format the display value based on type
  let displayValue = value;
  let copyValue = value;

  try {
    if (type === 'note') {
      displayValue = nip19.noteEncode(value);
      copyValue = displayValue;
    } else if (type === 'npub') {
      displayValue = nip19.npubEncode(value);
      copyValue = displayValue;
    }
  } catch {
    // Keep original value if encoding fails
  }

  // Truncate for display
  const truncated = displayValue.length > truncateStart + truncateEnd + 3
    ? `${displayValue.slice(0, truncateStart)}...${displayValue.slice(-truncateEnd)}`
    : displayValue;

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(copyValue);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  };

  const sizeClasses = {
    xs: 'text-[10px]',
    sm: 'text-xs',
    md: 'text-sm',
  };

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={handleCopy}
            className={cn(
              "inline-flex items-center gap-1 font-mono cursor-pointer",
              "hover:bg-muted/50 px-1 py-0.5 rounded transition-colors",
              "text-muted-foreground hover:text-foreground",
              sizeClasses[size],
              className
            )}
          >
            {label && <span className="font-sans text-muted-foreground">{label}</span>}
            <span className="truncate">{truncated}</span>
            {copied ? (
              <Check className="h-3 w-3 text-green-500 shrink-0" />
            ) : (
              <Copy className="h-3 w-3 opacity-50 shrink-0" />
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-sm">
          <div className="space-y-1">
            <p className="text-xs font-mono break-all">{displayValue}</p>
            {type === 'note' || type === 'npub' ? (
              <p className="text-[10px] font-mono text-muted-foreground break-all">hex: {value}</p>
            ) : null}
            <p className="text-xs text-muted-foreground">Click to copy</p>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

interface CopyableTagsProps {
  /** Array of tags to display */
  tags: string[][];
  /** Maximum number of tags to show before truncating */
  maxTags?: number;
  /** Additional class names */
  className?: string;
}

export function CopyableTags({ tags, maxTags = 10, className }: CopyableTagsProps) {
  const [copied, setCopied] = useState(false);
  const [expandedTag, setExpandedTag] = useState<number | null>(null);

  const handleCopyAll = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(tags, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  };

  const handleCopyTag = async (tag: string[], index: number, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(JSON.stringify(tag));
      setExpandedTag(index);
      setTimeout(() => setExpandedTag(null), 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  };

  const displayTags = tags.slice(0, maxTags);
  const remainingCount = tags.length - maxTags;

  return (
    <div className={cn("space-y-1", className)}>
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">Tags ({tags.length})</span>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={handleCopyAll}
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                {copied ? (
                  <>
                    <Check className="h-3 w-3 text-green-500" />
                    Copied
                  </>
                ) : (
                  <>
                    <Copy className="h-3 w-3" />
                    Copy all
                  </>
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent>Copy all tags as JSON</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
      <div className="space-y-0.5">
        {displayTags.map((tag, i) => {
          const [tagName, ...values] = tag;
          const valueStr = values.join(', ');
          const truncatedValue = valueStr.length > 40
            ? `${valueStr.slice(0, 40)}...`
            : valueStr;

          return (
            <TooltipProvider key={i}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={(e) => handleCopyTag(tag, i, e)}
                    className="flex items-center gap-1.5 w-full text-left text-xs font-mono px-1.5 py-0.5 rounded hover:bg-muted/50 transition-colors"
                  >
                    <span className="text-primary font-medium shrink-0">{tagName}</span>
                    <span className="text-muted-foreground truncate flex-1">{truncatedValue}</span>
                    {expandedTag === i ? (
                      <Check className="h-3 w-3 text-green-500 shrink-0" />
                    ) : (
                      <Copy className="h-3 w-3 opacity-0 group-hover:opacity-50 shrink-0" />
                    )}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="left" className="max-w-md">
                  <pre className="text-xs font-mono whitespace-pre-wrap break-all">
                    {JSON.stringify(tag, null, 2)}
                  </pre>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          );
        })}
        {remainingCount > 0 && (
          <p className="text-xs text-muted-foreground px-1.5">+{remainingCount} more tags</p>
        )}
      </div>
    </div>
  );
}
