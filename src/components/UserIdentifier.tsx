// ABOUTME: Reusable component for displaying user identifiers with npub, name, and copy functionality
// ABOUTME: Looks up kind 0 profile data and shows name/nip05 when available

import { useState } from "react";
import { nip19 } from "nostr-tools";
import { Copy, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useAuthor } from "@/hooks/useAuthor";
import { cn } from "@/lib/utils";
import { getDivineProfileUrl } from "@/lib/constants";

interface UserIdentifierProps {
  pubkey: string;
  showAvatar?: boolean;
  avatarSize?: "sm" | "md" | "lg";
  showCopyButton?: boolean;
  showNip05?: boolean;
  linkToProfile?: boolean;
  variant?: "inline" | "block" | "compact";
  className?: string;
}

export function UserIdentifier({
  pubkey,
  showAvatar = false,
  avatarSize = "sm",
  showCopyButton = true,
  showNip05 = true,
  linkToProfile = false,
  variant = "inline",
  className,
}: UserIdentifierProps) {
  const [copied, setCopied] = useState(false);
  const author = useAuthor(pubkey);

  // Convert hex to npub
  let npub = "";
  try {
    npub = nip19.npubEncode(pubkey);
  } catch {
    npub = pubkey; // Fallback to hex if conversion fails
  }

  const metadata = author.data?.metadata;
  const displayName = metadata?.display_name || metadata?.name;
  const nip05 = metadata?.nip05;
  const picture = metadata?.picture;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(npub);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  };

  const avatarSizeClasses = {
    sm: "h-5 w-5",
    md: "h-8 w-8",
    lg: "h-10 w-10",
  };

  const avatarTextSizes = {
    sm: "text-[8px]",
    md: "text-xs",
    lg: "text-sm",
  };

  // Generate initials from display name or npub
  const initials = displayName
    ? displayName.slice(0, 2).toUpperCase()
    : npub.slice(5, 7).toUpperCase();

  // Truncated npub for display (npub1abc...xyz)
  const truncatedNpub = `${npub.slice(0, 8)}...${npub.slice(-4)}`;

  const profileUrl = getDivineProfileUrl(npub);

  if (variant === "compact") {
    const content = (
      <>
        {showAvatar && (
          <Avatar className={avatarSizeClasses[avatarSize]}>
            <AvatarImage src={picture} alt={displayName || npub} />
            <AvatarFallback className={avatarTextSizes[avatarSize]}>
              {initials}
            </AvatarFallback>
          </Avatar>
        )}
        <span className="font-medium">
          {displayName || truncatedNpub}
        </span>
      </>
    );

    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            {linkToProfile ? (
              <a
                href={profileUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={cn(
                  "inline-flex items-center gap-1 hover:opacity-80",
                  className
                )}
              >
                {content}
              </a>
            ) : (
              <span
                className={cn(
                  "inline-flex items-center gap-1 cursor-pointer hover:opacity-80",
                  className
                )}
                onClick={handleCopy}
              >
                {content}
                {copied && <Check className="h-3 w-3 text-green-500" />}
              </span>
            )}
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-xs">
            <div className="space-y-1">
              {displayName && (
                <p className="font-medium">{displayName}</p>
              )}
              {nip05 && showNip05 && (
                <p className="text-xs text-muted-foreground">{nip05}</p>
              )}
              <p className="text-xs font-mono break-all">{npub}</p>
              <p className="text-xs text-muted-foreground">
                {linkToProfile ? "Click to view profile" : "Click to copy"}
              </p>
            </div>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  if (variant === "block") {
    const avatarElement = showAvatar && (
      <Avatar className={avatarSizeClasses[avatarSize]}>
        <AvatarImage src={picture} alt={displayName || npub} />
        <AvatarFallback className={avatarTextSizes[avatarSize]}>
          {initials}
        </AvatarFallback>
      </Avatar>
    );

    const nameElement = displayName && (
      <p className="font-medium text-sm truncate">{displayName}</p>
    );

    return (
      <div className={cn("flex items-center gap-2", className)}>
        {linkToProfile ? (
          <a
            href={profileUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 hover:opacity-80 shrink-0"
          >
            {avatarElement}
          </a>
        ) : (
          avatarElement
        )}
        <div className="flex-1 min-w-0">
          {linkToProfile && displayName ? (
            <a
              href={profileUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:opacity-80"
            >
              {nameElement}
            </a>
          ) : (
            nameElement
          )}
          {nip05 && showNip05 && (
            <p className="text-xs text-muted-foreground truncate">{nip05}</p>
          )}
          <div className="flex items-center gap-1">
            <code className="text-xs font-mono text-muted-foreground truncate">
              {truncatedNpub}
            </code>
            {showCopyButton && (
              <Button
                variant="ghost"
                size="icon"
                className="h-5 w-5 shrink-0"
                onClick={handleCopy}
              >
                {copied ? (
                  <Check className="h-3 w-3 text-green-500" />
                ) : (
                  <Copy className="h-3 w-3" />
                )}
              </Button>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Default inline variant
  const inlineContent = (
    <>
      {showAvatar && (
        <Avatar className={avatarSizeClasses[avatarSize]}>
          <AvatarImage src={picture} alt={displayName || npub} />
          <AvatarFallback className={avatarTextSizes[avatarSize]}>
            {initials}
          </AvatarFallback>
        </Avatar>
      )}
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex items-center gap-1">
              {displayName ? (
                <span className="font-medium">{displayName}</span>
              ) : (
                <code className="text-xs font-mono">{truncatedNpub}</code>
              )}
              {nip05 && showNip05 && !displayName && (
                <span className="text-xs text-muted-foreground">({nip05})</span>
              )}
            </span>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-xs">
            <div className="space-y-1">
              {displayName && <p className="font-medium">{displayName}</p>}
              {nip05 && showNip05 && (
                <p className="text-xs text-muted-foreground">{nip05}</p>
              )}
              <p className="text-xs font-mono break-all">{npub}</p>
            </div>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </>
  );

  return (
    <span className={cn("inline-flex items-center gap-1", className)}>
      {linkToProfile ? (
        <a
          href={profileUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 hover:opacity-80"
        >
          {inlineContent}
        </a>
      ) : (
        inlineContent
      )}
      {showCopyButton && (
        <Button
          variant="ghost"
          size="icon"
          className="h-5 w-5 shrink-0"
          onClick={handleCopy}
        >
          {copied ? (
            <Check className="h-3 w-3 text-green-500" />
          ) : (
            <Copy className="h-3 w-3" />
          )}
        </Button>
      )}
    </span>
  );
}

// Simple inline display for use in lists, etc.
interface UserDisplayNameProps {
  pubkey: string;
  fallbackLength?: number;
  linkToProfile?: boolean;
  className?: string;
}

export function UserDisplayName({
  pubkey,
  fallbackLength = 8,
  linkToProfile = false,
  className,
}: UserDisplayNameProps) {
  const author = useAuthor(pubkey);
  const metadata = author.data?.metadata;
  const displayName = metadata?.display_name || metadata?.name;

  let npub = "";
  try {
    npub = nip19.npubEncode(pubkey);
  } catch {
    npub = pubkey;
  }

  const content = displayName ? (
    <span className={className}>{displayName}</span>
  ) : (
    <code className={cn("font-mono", className)}>
      {npub.slice(0, fallbackLength)}...
    </code>
  );

  if (linkToProfile) {
    return (
      <a
        href={getDivineProfileUrl(npub)}
        target="_blank"
        rel="noopener noreferrer"
        className="hover:opacity-80"
      >
        {content}
      </a>
    );
  }

  return content;
}

// Avatar with profile lookup
interface UserAvatarProps {
  pubkey: string;
  size?: "sm" | "md" | "lg" | "xl";
  className?: string;
}

export function UserAvatar({ pubkey, size = "md", className }: UserAvatarProps) {
  const author = useAuthor(pubkey);
  const metadata = author.data?.metadata;
  const displayName = metadata?.display_name || metadata?.name;
  const picture = metadata?.picture;

  let npub = "";
  try {
    npub = nip19.npubEncode(pubkey);
  } catch {
    npub = pubkey;
  }

  const sizeClasses = {
    sm: "h-6 w-6",
    md: "h-8 w-8",
    lg: "h-10 w-10",
    xl: "h-12 w-12",
  };

  const textSizes = {
    sm: "text-[10px]",
    md: "text-xs",
    lg: "text-sm",
    xl: "text-base",
  };

  const initials = displayName
    ? displayName.slice(0, 2).toUpperCase()
    : npub.slice(5, 7).toUpperCase();

  return (
    <Avatar className={cn(sizeClasses[size], className)}>
      <AvatarImage src={picture} alt={displayName || npub} />
      <AvatarFallback className={textSizes[size]}>{initials}</AvatarFallback>
    </Avatar>
  );
}
