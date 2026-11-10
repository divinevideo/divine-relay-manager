// ABOUTME: Displays Hive AI moderation results from the divine-moderation-service
// ABOUTME: Shows confidence scores, classification categories and timestamps (read-only)

import { type MediaStatusAction } from "@/lib/adminApi";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Bot, ShieldCheck, ShieldAlert, ShieldX, Eye, Clock } from "lucide-react";
import { CopyableId } from "@/components/CopyableId";
import { useMediaStatus } from "@/hooks/useMediaStatus";

interface HiveAIReportProps {
  sha256?: string;
  eventTags?: string[][];
  className?: string;
}

interface ModerationResult {
  // Absent when there is no record: check-result then answers 200 with status 'unknown'.
  action?: MediaStatusAction | 'FLAGGED';
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
  // When the record was written, not always a scan: a report writes it and a later
  // report can move it forward, while a moderator action leaves it as it was.
  moderated_at?: string;
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
  DELETE: { label: 'Deleted', icon: ShieldX, color: 'text-red-600' },
};

function formatDate(dateStr: string | undefined): string {
  if (!dateStr) return 'Unknown';
  const date = new Date(dateStr);
  // An unparseable string gives an Invalid Date rather than throwing.
  if (Number.isNaN(date.getTime())) return dateStr;
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// Read-only. Re-analysis isn't offered here: moderation-service runs reactive
// moderation only (its queue skips every scan request) and skips videos that
// already have a result, so a re-check button could never do anything (#406).
// The AI detection card is the on-demand check.
export function HiveAIReport({ sha256: providedSha256, eventTags, className }: HiveAIReportProps) {
  // Determine sha256 from props or tags
  const sha256 = providedSha256 || (eventTags ? extractSha256FromTags(eventTags) : null);

  // The same read the media actions use: bounded by the API timeout, refetched
  // when an action invalidates 'media-status', and a failed read comes back
  // marked unreadable instead of as no decision.
  const { results, isPending } = useMediaStatus(sha256 ? [sha256] : []);
  const result = results[0]?.status as ModerationResult | null | undefined;
  const error = results[0]?.unreadable;

  // No sha256 found - nothing to show
  if (!sha256) {
    return null;
  }

  // isPending, not isLoading: a read paused while offline is pending but not
  // loading, and has read nothing, so it is not "Not analyzed yet".
  if (isPending) {
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

  // No record, so no action to show, or the record could not be read
  if (!result?.action || error) {
    return (
      <Card className={`border-blue-200 dark:border-blue-800 ${className}`}>
        <CardHeader className="py-2 px-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Bot className="h-4 w-4 text-blue-500" />
            Hive AI Analysis
          </CardTitle>
        </CardHeader>
        <CardContent className="py-2 px-3">
          <p className="text-xs text-muted-foreground">
            {error ? 'Status could not be read. Reload to try again.' : 'Not analyzed yet'}
          </p>
          <CopyableId value={sha256} type="hash" label="sha256:" size="xs" className="mt-2" />
        </CardContent>
      </Card>
    );
  }

  const actionConfig = ACTION_CONFIG[result.action] || ACTION_CONFIG.REVIEW;
  const ActionIcon = actionConfig.icon;
  // moderated_at is the record's last write, not the scan time: a report can
  // advance it without a new scan (moderation-service report-review).
  const recordUpdatedAt = result.moderated_at;

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
              const percentage = Math.round((score || 0) * 100);

              return (
                <div key={category} className="space-y-1">
                  <div className="flex items-center justify-between text-xs">
                    <Badge className={`${config.color} text-white text-xs`}>
                      {config.label}
                    </Badge>
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

        {/* Timestamp */}
        <div className="flex items-center gap-2 text-xs text-muted-foreground border-t pt-2">
          <Clock className="h-3 w-3" />
          {recordUpdatedAt ? (
            <span>Record updated: {formatDate(recordUpdatedAt)}</span>
          ) : (
            <span>Update time unknown</span>
          )}
        </div>

        {/* Hash reference */}
        <CopyableId value={sha256} type="hash" label="sha256:" size="xs" />
      </CardContent>
    </Card>
  );
}

