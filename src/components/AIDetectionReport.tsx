// ABOUTME: Displays multi-provider AI detection results from Reality Defender, Hive, and Sensity
// ABOUTME: Shows consensus verdict, individual provider scores, timestamps, and trigger-check ability

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Bot,
  ShieldCheck,
  ShieldAlert,
  ShieldQuestion,
  RefreshCw,
  ChevronDown,
  ChevronUp,
  Clock,
  XCircle,
  Loader2,
  ExternalLink,
} from "lucide-react";
import { useAdminApi } from "@/hooks/useAdminApi";
import { useToast } from "@/hooks/useToast";
import type {
  AIDetectionResult,
  AIVerdict,
  AIProviderResult,
} from "@/lib/adminApi";
import { CopyableId } from "@/components/CopyableId";

interface AIDetectionReportProps {
  sha256?: string;
  videoUrl?: string;
  eventId?: string;
  eventTags?: string[][];
  className?: string;
  compact?: boolean;
}

// Extract sha256 from event tags
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

  // Check URLs for sha256 patterns
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

// Extract video URL from event tags
function extractVideoUrlFromTags(tags: string[][]): string | null {
  const videoExtensions = /\.(mp4|webm|mov|m4v|avi|mkv)(\?|$)/i;
  const videoMimeTypes = /^video\//i;

  // Check imeta tags first (most reliable - can have mime type)
  for (const tag of tags) {
    if (tag[0] === 'imeta') {
      let url: string | undefined;
      let mimeType: string | undefined;

      for (let i = 1; i < tag.length; i++) {
        const part = tag[i];
        if (part.startsWith('url ')) {
          url = part.slice(4);
        } else if (part.startsWith('m ')) {
          mimeType = part.slice(2);
        }
      }

      // Return if we have a URL and it's a video (by mime type or extension)
      if (url) {
        if (mimeType && videoMimeTypes.test(mimeType)) {
          return url;
        }
        if (videoExtensions.test(url)) {
          return url;
        }
      }
    }
  }

  // Check url tags
  for (const tag of tags) {
    if (tag[0] === 'url' && tag[1]) {
      const url = tag[1];
      if (videoExtensions.test(url)) {
        return url;
      }
    }
  }

  return null;
}

const VERDICT_CONFIG: Record<AIVerdict, { label: string; icon: typeof ShieldCheck; color: string; bgColor: string }> = {
  AUTHENTIC: { label: 'Authentic', icon: ShieldCheck, color: 'text-green-600', bgColor: 'bg-green-100 dark:bg-green-900/30' },
  UNCERTAIN: { label: 'Uncertain', icon: ShieldQuestion, color: 'text-yellow-600', bgColor: 'bg-yellow-100 dark:bg-yellow-900/30' },
  LIKELY_AI: { label: 'Likely AI', icon: ShieldAlert, color: 'text-red-600', bgColor: 'bg-red-100 dark:bg-red-900/30' },
};

const PROVIDER_NAMES: Record<string, string> = {
  reality_defender: 'Reality Defender',
  hive: 'Hive AI',
  sensity: 'Sensity',
};

const REALNESS_DASHBOARD_URL = 'https://realness.admin.divine.video';

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

function ProviderResultRow({ name, result }: { name: string; result: AIProviderResult }) {
  const percentage = result.score !== null ? Math.round(result.score * 100) : null;
  const verdict = result.verdict;
  const config = verdict ? VERDICT_CONFIG[verdict] : null;

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <div className="flex items-center gap-2">
          <span className="font-medium">{PROVIDER_NAMES[name] || name}</span>
          {result.status === 'pending' && (
            <Badge variant="outline" className="text-xs py-0">
              <Loader2 className="h-2 w-2 mr-1 animate-spin" />
              Pending
            </Badge>
          )}
          {result.status === 'processing' && (
            <Badge variant="outline" className="text-xs py-0 text-blue-600">
              <Loader2 className="h-2 w-2 mr-1 animate-spin" />
              Processing
            </Badge>
          )}
          {result.status === 'error' && (
            <Badge variant="destructive" className="text-xs py-0">
              <XCircle className="h-2 w-2 mr-1" />
              Error
            </Badge>
          )}
          {result.status === 'complete' && verdict && (
            <Badge className={`text-xs py-0 ${config?.bgColor} ${config?.color} border-0`}>
              {config?.label}
            </Badge>
          )}
        </div>
        {percentage !== null && (
          <span className="text-muted-foreground font-mono">{percentage}%</span>
        )}
      </div>
      {percentage !== null && (
        <Progress
          value={percentage}
          className={`h-1.5 ${
            percentage >= 70
              ? '[&>div]:bg-red-500'
              : percentage >= 30
              ? '[&>div]:bg-yellow-500'
              : '[&>div]:bg-green-500'
          }`}
        />
      )}
      {result.error && (
        <p className="text-xs text-red-500 truncate">{result.error}</p>
      )}
    </div>
  );
}

function ProviderBreakdown({ name, result }: { name: string; result: AIProviderResult }) {
  const breakdown = result.breakdown;
  if (!breakdown) return null;

  const items: Array<{ label: string; value: number | null }> = [];

  if (name === 'reality_defender') {
    if (breakdown.face_swap != null) items.push({ label: 'Face Swap', value: breakdown.face_swap });
    if (breakdown.lip_sync != null) items.push({ label: 'Lip Sync', value: breakdown.lip_sync });
    if (breakdown.voice_clone != null) items.push({ label: 'Voice Clone', value: breakdown.voice_clone });
    if (breakdown.full_synthetic != null) items.push({ label: 'Full Synthetic', value: breakdown.full_synthetic });
  } else if (name === 'hive') {
    if (breakdown.deepfake_score != null) items.push({ label: 'Deepfake', value: breakdown.deepfake_score });
    if (breakdown.ai_generated_score != null) items.push({ label: 'AI Generated', value: breakdown.ai_generated_score });
    if (breakdown.synthetic_score != null) items.push({ label: 'Synthetic', value: breakdown.synthetic_score });
  } else if (name === 'sensity') {
    if (breakdown.deepfake_probability != null) items.push({ label: 'Deepfake', value: breakdown.deepfake_probability });
    if (breakdown.detection_score != null) items.push({ label: 'Detection', value: breakdown.detection_score });
  }

  if (items.length === 0) return null;

  return (
    <div className="ml-4 mt-1 space-y-1">
      {items.map(({ label, value }) => (
        <div key={label} className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{label}</span>
          <span className="font-mono">{value !== null ? `${Math.round(value * 100)}%` : '-'}</span>
        </div>
      ))}
      {name === 'sensity' && breakdown.techniques_detected && breakdown.techniques_detected.length > 0 && (
        <div className="text-xs text-muted-foreground">
          Techniques: {breakdown.techniques_detected.join(', ')}
        </div>
      )}
    </div>
  );
}

export function AIDetectionReport({
  sha256: providedSha256,
  videoUrl: providedVideoUrl,
  eventId,
  eventTags,
  className,
  compact = false,
}: AIDetectionReportProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { getAIDetectionResult, submitAIDetection } = useAdminApi();

  const sha256 = providedSha256 || (eventTags ? extractSha256FromTags(eventTags) : null);
  const videoUrl = providedVideoUrl || (eventTags ? extractVideoUrlFromTags(eventTags) : null);

  const { data: result, isLoading, error, refetch } = useQuery({
    queryKey: ['ai-detection', eventId],
    queryFn: async (): Promise<AIDetectionResult | null> => {
      if (!eventId) return null;
      return getAIDetectionResult(eventId);
    },
    enabled: !!eventId,
    staleTime: 30 * 1000, // 30 seconds - AI detection results change during processing
    refetchInterval: (query) => {
      // Auto-refresh while processing
      const data = query.state.data;
      if (data?.status === 'pending' || data?.status === 'processing') {
        return 5000; // Poll every 5 seconds while processing
      }
      return false;
    },
  });

  const handleTriggerCheck = async () => {
    if (!sha256 || !videoUrl || !eventId) return;

    setIsSubmitting(true);
    try {
      const submitResult = await submitAIDetection(videoUrl, sha256, eventId);
      if (submitResult) {
        // Invalidate and refetch
        queryClient.invalidateQueries({ queryKey: ['ai-detection', eventId] });
        refetch();
        toast({
          title: "Analysis submitted",
          description: "AI detection is processing. Results will appear shortly.",
        });
      } else {
        toast({
          variant: "destructive",
          title: "Analysis failed",
          description: "Could not submit video for AI detection. Check console for details.",
        });
      }
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Analysis failed",
        description: error instanceof Error ? error.message : "Unknown error occurred",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  // No sha256 found - nothing to show
  if (!sha256) {
    return null;
  }

  if (isLoading) {
    return (
      <Card className={`border-purple-200 dark:border-purple-800 ${className}`}>
        <CardHeader className="py-2 px-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Bot className="h-4 w-4 text-purple-500" />
            AI Detection
          </CardTitle>
        </CardHeader>
        <CardContent className="py-2 px-3">
          <Skeleton className="h-16 w-full" />
        </CardContent>
      </Card>
    );
  }

  // No result found - show option to trigger check
  if (!result || error) {
    return (
      <Card className={`border-purple-200 dark:border-purple-800 ${className}`}>
        <CardHeader className="py-2 px-3">
          <CardTitle className="text-sm flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Bot className="h-4 w-4 text-purple-500" />
              AI Detection
            </div>
          </CardTitle>
        </CardHeader>
        <CardContent className="py-2 px-3">
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">Not analyzed yet</p>
            <div className="flex items-center gap-2">
              {videoUrl && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleTriggerCheck}
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
              <Button
                variant="ghost"
                size="sm"
                asChild
                className="h-7 text-xs"
              >
                <a href={eventId ? `${REALNESS_DASHBOARD_URL}?event=${eventId}` : REALNESS_DASHBOARD_URL} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="h-3 w-3 mr-1" />
                  Realness
                </a>
              </Button>
            </div>
          </div>
          {eventId && (
            <CopyableId value={eventId} type="hex" label="Event ID:" size="xs" className="mt-2" />
          )}
          <CopyableId value={sha256} type="hash" label="sha256:" size="xs" className="mt-2" />
        </CardContent>
      </Card>
    );
  }

  const consensus = result.details.ai_detection.consensus;
  const providers = result.details.ai_detection.providers;
  const hasProviders = Object.keys(providers).length > 0;
  const consensusConfig = consensus ? VERDICT_CONFIG[consensus.verdict] : null;
  const ConsensusIcon = consensusConfig?.icon || ShieldQuestion;
  const isProcessing = result.status === 'pending' || result.status === 'processing';

  if (compact) {
    // Compact badge version
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge
              variant="outline"
              className={`${className} ${consensusConfig?.color || 'text-gray-500'} cursor-help`}
            >
              {isProcessing ? (
                <Loader2 className="h-3 w-3 mr-1 animate-spin" />
              ) : (
                <ConsensusIcon className="h-3 w-3 mr-1" />
              )}
              {isProcessing ? 'Analyzing...' : consensus?.verdict || 'Unknown'}
            </Badge>
          </TooltipTrigger>
          <TooltipContent>
            <div className="text-xs space-y-1">
              <p><strong>AI Detection:</strong> {consensus?.verdict || 'Unknown'}</p>
              <p><strong>Confidence:</strong> {consensus?.confidence || 'N/A'}</p>
              <p><strong>Agreement:</strong> {consensus?.agreement || 'N/A'}</p>
              {result.metadata.completed && (
                <p><strong>Checked:</strong> {formatDate(result.metadata.completed)}</p>
              )}
            </div>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return (
    <Card className={`border-purple-200 dark:border-purple-800 ${className}`}>
      <CardHeader className="py-2 px-3">
        <CardTitle className="text-sm flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Bot className="h-4 w-4 text-purple-500" />
            AI Detection
            {isProcessing && (
              <Badge variant="outline" className="text-xs py-0">
                <Loader2 className="h-2 w-2 mr-1 animate-spin" />
                Processing
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-2">
            {consensus && (
              <div className={`flex items-center gap-1 ${consensusConfig?.color}`}>
                <ConsensusIcon className="h-4 w-4" />
                <span className="text-xs font-medium">{consensus.verdict}</span>
              </div>
            )}
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent className="py-2 px-3 space-y-3">
        {/* Consensus info */}
        {consensus && (
          <div className={`p-2 rounded-md ${consensusConfig?.bgColor}`}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <ConsensusIcon className={`h-5 w-5 ${consensusConfig?.color}`} />
                <div>
                  <p className={`text-sm font-medium ${consensusConfig?.color}`}>
                    {consensus.verdict === 'AUTHENTIC' && 'Content appears authentic'}
                    {consensus.verdict === 'UNCERTAIN' && 'AI detection inconclusive'}
                    {consensus.verdict === 'LIKELY_AI' && 'Content likely AI-generated'}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {consensus.confidence === 'high' && consensus.agreement === 'unanimous' && 'All providers agree'}
                    {consensus.confidence === 'medium' && consensus.agreement === 'majority' && 'Majority of providers agree'}
                    {consensus.confidence === 'low' && 'Providers disagree'}
                  </p>
                </div>
              </div>
              <div className="text-right text-xs text-muted-foreground">
                <div className="flex items-center gap-1">
                  {result.details.ai_detection.provider_count || 0} providers
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Aggregate scores */}
        {result.scores.ai_generated > 0 && (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium">AI Generated Score</span>
              <span className="text-muted-foreground font-mono">
                {Math.round(result.scores.ai_generated * 100)}%
              </span>
            </div>
            <Progress
              value={result.scores.ai_generated * 100}
              className={`h-2 ${
                result.scores.ai_generated >= 0.7
                  ? '[&>div]:bg-red-500'
                  : result.scores.ai_generated >= 0.3
                  ? '[&>div]:bg-yellow-500'
                  : '[&>div]:bg-green-500'
              }`}
            />
          </div>
        )}

        {/* Provider details (collapsible) */}
        {hasProviders && (
          <Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
            <CollapsibleTrigger asChild>
              <Button variant="ghost" size="sm" className="w-full justify-between h-7 text-xs">
                <span>Provider Details</span>
                {isExpanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-3 pt-2">
              {providers.reality_defender && (
                <div className="space-y-1">
                  <ProviderResultRow name="reality_defender" result={providers.reality_defender} />
                  <ProviderBreakdown name="reality_defender" result={providers.reality_defender} />
                </div>
              )}
              {providers.hive && (
                <div className="space-y-1">
                  <ProviderResultRow name="hive" result={providers.hive} />
                  <ProviderBreakdown name="hive" result={providers.hive} />
                </div>
              )}
              {providers.sensity && (
                <div className="space-y-1">
                  <ProviderResultRow name="sensity" result={providers.sensity} />
                  <ProviderBreakdown name="sensity" result={providers.sensity} />
                </div>
              )}
            </CollapsibleContent>
          </Collapsible>
        )}

        {/* Metadata */}
        <div className="flex items-center justify-between text-xs text-muted-foreground border-t pt-2">
          <div className="flex items-center gap-2">
            <Clock className="h-3 w-3" />
            {result.metadata.completed ? (
              <span>Checked: {formatDate(result.metadata.completed)}</span>
            ) : result.metadata.submitted ? (
              <span>Submitted: {formatDate(result.metadata.submitted)}</span>
            ) : (
              <span>Unknown</span>
            )}
          </div>
          <div className="flex items-center gap-1">
            {videoUrl && !isProcessing && (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleTriggerCheck}
                disabled={isSubmitting}
                className="h-6 text-xs px-2"
                title="Re-analyze"
              >
                {isSubmitting ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <RefreshCw className="h-3 w-3" />
                )}
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              asChild
              className="h-6 text-xs px-2"
              title="Open in Realness dashboard"
            >
              <a href={eventId ? `${REALNESS_DASHBOARD_URL}?event=${eventId}` : REALNESS_DASHBOARD_URL} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="h-3 w-3" />
              </a>
            </Button>
          </div>
        </div>

        {/* Event and hash references */}
        {eventId && (
          <CopyableId value={eventId} type="hex" label="Event ID:" size="xs" />
        )}
        <CopyableId value={sha256} type="hash" label="sha256:" size="xs" />
      </CardContent>
    </Card>
  );
}

// Compact badge version for list views
export function AIDetectionBadge({
  sha256: providedSha256,
  eventTags,
  className,
}: {
  sha256?: string;
  eventTags?: string[][];
  className?: string;
}) {
  return (
    <AIDetectionReport
      sha256={providedSha256}
      eventTags={eventTags}
      className={className}
      compact
    />
  );
}
