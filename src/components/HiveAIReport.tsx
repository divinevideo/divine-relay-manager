// ABOUTME: Displays Hive AI moderation results from the divine-moderation-service
// ABOUTME: Shows confidence scores, classification categories, timestamps, and re-check ability

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Bot, ShieldCheck, ShieldAlert, ShieldX, Eye, Clock, RefreshCw, Loader2 } from "lucide-react";
import { CopyableId } from "@/components/CopyableId";
import { useApiUrl } from "@/hooks/useAdminApi";

interface HiveAIReportProps {
  sha256?: string;
  videoUrl?: string;
  eventTags?: string[][];
  className?: string;
}

interface ModerationResult {
  action: 'SAFE' | 'REVIEW' | 'AGE_RESTRICTED' | 'PERMANENT_BAN' | 'FLAGGED' | 'QUARANTINE';
  scores: {
    nudity?: number;
    violence?: number;
    gore?: number;
    offensive?: number;
    weapon?: number;
    self_harm?: number;
    recreational_drug?: number;
    alcohol?: number;
    tobacco?: number;
    ai_generated?: number;
    deepfake?: number;
    medical?: number;
    gambling?: number;
  };
  category?: string;
  reason?: string;
  processedAt?: string;
  created_at?: string;
  categoryVerifications?: Record<string, 'confirmed' | 'rejected' | null>;
}

// Extract sha256 from event tags (x tag, imeta, or URL patterns)
function extractSha256FromTags(tags: string[][]): string | null {
  // Check for 'x' tag (file hash)
  const xTag = tags.find(t => t[0] === 'x');
  if (xTag?.[1] && /^[a-f0-9]{64}$/i.test(xTag[1])) {
    return xTag[1].toLowerCase();
  }

  // Check imeta tags for sha256
  for (const tag of tags) {
    if (tag[0] === 'imeta') {
      for (let i = 1; i < tag.length; i++) {
        const part = tag[i];
        if (part.startsWith('x ')) {
          const hash = part.slice(2);
          if (/^[a-f0-9]{64}$/i.test(hash)) {
            return hash.toLowerCase();
          }
        }
      }
    }
  }

  // Check URLs for sha256 patterns (divine.video URLs often include hash)
  for (const tag of tags) {
    if (tag[0] === 'url' || tag[0] === 'imeta') {
      const urlMatch = tag.join(' ').match(/([a-f0-9]{64})/i);
      if (urlMatch) {
        return urlMatch[1].toLowerCase();
      }
    }
  }

  return null;
}

// Category display configuration
const CATEGORY_CONFIG: Record<string, { label: string; color: string; severity: number }> = {
  nudity: { label: 'Nudity', color: 'bg-orange-500', severity: 2 },
  violence: { label: 'Violence', color: 'bg-red-500', severity: 3 },
  gore: { label: 'Gore', color: 'bg-red-700', severity: 4 },
  offensive: { label: 'Offensive', color: 'bg-yellow-500', severity: 2 },
  weapon: { label: 'Weapon', color: 'bg-red-400', severity: 2 },
  self_harm: { label: 'Self-harm', color: 'bg-red-600', severity: 4 },
  recreational_drug: { label: 'Drugs', color: 'bg-purple-500', severity: 2 },
  alcohol: { label: 'Alcohol', color: 'bg-amber-500', severity: 1 },
  tobacco: { label: 'Tobacco', color: 'bg-amber-600', severity: 1 },
  ai_generated: { label: 'AI Generated', color: 'bg-blue-500', severity: 1 },
  deepfake: { label: 'Deepfake', color: 'bg-purple-600', severity: 3 },
  medical: { label: 'Medical', color: 'bg-teal-500', severity: 1 },
  gambling: { label: 'Gambling', color: 'bg-green-600', severity: 1 },
};

const ACTION_CONFIG: Record<string, { label: string; icon: typeof ShieldCheck; color: string }> = {
  SAFE: { label: 'Safe', icon: ShieldCheck, color: 'text-green-500' },
  REVIEW: { label: 'Needs Review', icon: Eye, color: 'text-yellow-500' },
  AGE_RESTRICTED: { label: 'Age Restricted', icon: ShieldAlert, color: 'text-orange-500' },
  FLAGGED: { label: 'Flagged', icon: ShieldAlert, color: 'text-orange-500' },
  QUARANTINE: { label: 'Quarantined', icon: ShieldX, color: 'text-red-500' },
  PERMANENT_BAN: { label: 'Banned', icon: ShieldX, color: 'text-red-600' },
};

// Extract video URL from event tags
function extractVideoUrlFromTags(tags: string[][]): string | null {
  // Check imeta tags for video URLs
  for (const tag of tags) {
    if (tag[0] === 'imeta') {
      for (let i = 1; i < tag.length; i++) {
        const part = tag[i];
        if (part.startsWith('url ')) {
          const url = part.slice(4);
          // Match video extensions and divine.video URLs
          if (/\.(mp4|webm|mov|m4v|avi)(\?|$)/i.test(url) || url.includes('divine.video')) {
            return url;
          }
        }
      }
    }
  }

  // Check url tags
  for (const tag of tags) {
    if (tag[0] === 'url' && tag[1]) {
      const url = tag[1];
      if (/\.(mp4|webm|mov|m4v|avi|jpg|jpeg|png|gif|webp)(\?|$)/i.test(url) || url.includes('divine.video')) {
        return url;
      }
    }
  }

  return null;
}

function formatDate(dateStr: string | undefined): string {
  if (!dateStr) return 'Unknown';
  try {
    const date = new Date(dateStr);
    return date.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return dateStr;
  }
}

export function HiveAIReport({ sha256: providedSha256, videoUrl: providedVideoUrl, eventTags, className }: HiveAIReportProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const queryClient = useQueryClient();
  const apiUrl = useApiUrl();

  // Determine sha256 from props or tags
  const sha256 = providedSha256 || (eventTags ? extractSha256FromTags(eventTags) : null);
  const videoUrl = providedVideoUrl || (eventTags ? extractVideoUrlFromTags(eventTags) : null);

  const { data: result, isLoading, error, refetch } = useQuery({
    queryKey: ['hive-moderation', sha256],
    queryFn: async (): Promise<ModerationResult | null> => {
      if (!sha256) return null;

      const response = await fetch(`${apiUrl}/api/check-result/${sha256}`);
      if (!response.ok) {
        if (response.status === 404) return null;
        throw new Error(`Failed to fetch moderation result: ${response.status}`);
      }

      return response.json();
    },
    enabled: !!sha256,
    staleTime: 5 * 60 * 1000, // Cache for 5 minutes
  });

  // No sha256 found - nothing to show
  if (!sha256) {
    return null;
  }

  if (isLoading) {
    return (
      <Card className={`border-blue-200 dark:border-blue-800 ${className}`}>
        <CardHeader className="py-2 px-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Bot className="h-4 w-4 text-blue-500" />
            Hive AI Analysis
          </CardTitle>
        </CardHeader>
        <CardContent className="py-2 px-3">
          <Skeleton className="h-12 w-full" />
        </CardContent>
      </Card>
    );
  }

  // Trigger re-check
  const handleRecheck = async () => {
    if (!sha256 || !videoUrl) return;

    setIsSubmitting(true);
    try {
      // Call the worker to trigger a moderation check
      const response = await fetch(`${apiUrl}/api/moderate-check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: videoUrl, sha256 }),
      });

      if (response.ok) {
        // Invalidate and refetch
        queryClient.invalidateQueries({ queryKey: ['hive-moderation', sha256] });
        refetch();
      }
    } catch (err) {
      console.error('Failed to trigger moderation check:', err);
    } finally {
      setIsSubmitting(false);
    }
  };

  // No result found - show option to trigger check
  if (!result || error) {
    return (
      <Card className={`border-blue-200 dark:border-blue-800 ${className}`}>
        <CardHeader className="py-2 px-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Bot className="h-4 w-4 text-blue-500" />
            Hive AI Analysis
          </CardTitle>
        </CardHeader>
        <CardContent className="py-2 px-3">
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">Not analyzed yet</p>
            {videoUrl && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleRecheck}
                disabled={isSubmitting}
                className="h-7 text-xs"
              >
                {isSubmitting ? (
                  <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                ) : (
                  <RefreshCw className="h-3 w-3 mr-1" />
                )}
                Analyze
              </Button>
            )}
          </div>
          <CopyableId value={sha256} type="hash" label="sha256:" size="xs" className="mt-2" />
        </CardContent>
      </Card>
    );
  }

  const actionConfig = ACTION_CONFIG[result.action] || ACTION_CONFIG.REVIEW;
  const ActionIcon = actionConfig.icon;
  const checkedAt = result.processedAt || result.created_at;

  // Filter scores above threshold (0.3)
  const significantScores = Object.entries(result.scores || {})
    .filter(([_, score]) => score && score >= 0.3)
    .sort((a, b) => (b[1] || 0) - (a[1] || 0));

  return (
    <Card className={`border-blue-200 dark:border-blue-800 ${className}`}>
      <CardHeader className="py-2 px-3">
        <CardTitle className="text-sm flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Bot className="h-4 w-4 text-blue-500" />
            Hive AI Analysis
          </div>
          <div className={`flex items-center gap-1 ${actionConfig.color}`}>
            <ActionIcon className="h-4 w-4" />
            <span className="text-xs font-medium">{actionConfig.label}</span>
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent className="py-2 px-3 space-y-3">
        {/* Significant scores */}
        {significantScores.length > 0 ? (
          <div className="space-y-2">
            {significantScores.map(([category, score]) => {
              const config = CATEGORY_CONFIG[category] || { label: category, color: 'bg-gray-500', severity: 1 };
              const verification = result.categoryVerifications?.[category];
              const percentage = Math.round((score || 0) * 100);

              return (
                <div key={category} className="space-y-1">
                  <div className="flex items-center justify-between text-xs">
                    <div className="flex items-center gap-2">
                      <Badge className={`${config.color} text-white text-xs`}>
                        {config.label}
                      </Badge>
                      {verification === 'confirmed' && (
                        <Badge variant="destructive" className="text-xs">Confirmed</Badge>
                      )}
                      {verification === 'rejected' && (
                        <Badge variant="outline" className="text-xs text-green-600">Rejected</Badge>
                      )}
                    </div>
                    <span className="text-muted-foreground">{percentage}%</span>
                  </div>
                  <Progress
                    value={percentage}
                    className={`h-1.5 ${percentage >= 70 ? '[&>div]:bg-red-500' : percentage >= 50 ? '[&>div]:bg-orange-500' : '[&>div]:bg-yellow-500'}`}
                  />
                </div>
              );
            })}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">No significant detections</p>
        )}

        {/* Reason if provided */}
        {result.reason && (
          <p className="text-xs text-muted-foreground border-t pt-2">
            {result.reason}
          </p>
        )}

        {/* Timestamp and re-check */}
        <div className="flex items-center justify-between text-xs text-muted-foreground border-t pt-2">
          <div className="flex items-center gap-2">
            <Clock className="h-3 w-3" />
            {checkedAt ? (
              <span>Checked: {formatDate(checkedAt)}</span>
            ) : (
              <span>Check time unknown</span>
            )}
          </div>
          {videoUrl && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleRecheck}
                    disabled={isSubmitting}
                    className="h-6 text-xs px-2"
                  >
                    {isSubmitting ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <RefreshCw className="h-3 w-3" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>Re-analyze content</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </div>

        {/* Hash reference */}
        <CopyableId value={sha256} type="hash" label="sha256:" size="xs" />
      </CardContent>
    </Card>
  );
}

// Compact badge version for list views
interface HiveStatusBadgeProps {
  sha256?: string;
  eventTags?: string[][];
  className?: string;
}

export function HiveStatusBadge({ sha256: providedSha256, eventTags, className }: HiveStatusBadgeProps) {
  const apiUrl = useApiUrl();
  const sha256 = providedSha256 || (eventTags ? extractSha256FromTags(eventTags) : null);

  const { data: result } = useQuery({
    queryKey: ['hive-moderation', sha256],
    queryFn: async (): Promise<ModerationResult | null> => {
      if (!sha256) return null;
      const response = await fetch(`${apiUrl}/api/check-result/${sha256}`);
      if (!response.ok) return null;
      return response.json();
    },
    enabled: !!sha256,
    staleTime: 5 * 60 * 1000,
  });

  if (!sha256 || !result) return null;

  const actionConfig = ACTION_CONFIG[result.action] || ACTION_CONFIG.REVIEW;
  const ActionIcon = actionConfig.icon;
  const checkedAt = result.processedAt || result.created_at;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge variant="outline" className={`${className} ${actionConfig.color} cursor-help`}>
            <ActionIcon className="h-3 w-3 mr-1" />
            {actionConfig.label}
          </Badge>
        </TooltipTrigger>
        <TooltipContent>
          <div className="text-xs space-y-1">
            <p><strong>Hive AI:</strong> {actionConfig.label}</p>
            {checkedAt && (
              <p><strong>Checked:</strong> {formatDate(checkedAt)}</p>
            )}
            {result.category && (
              <p><strong>Category:</strong> {result.category}</p>
            )}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
