// ABOUTME: Displays Hive AI moderation results and other AI-based content analysis
// ABOUTME: Shows confidence scores and classification categories from AI services

import { useQuery } from "@tanstack/react-query";
import { useNostr } from "@nostrify/react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Bot, AlertTriangle, Shield, CheckCircle } from "lucide-react";
import type { NostrEvent } from "@nostrify/nostrify";

interface HiveAIReportProps {
  targetType: 'event' | 'pubkey';
  targetValue: string;
  className?: string;
}

// Known AI moderation label namespaces
const AI_NAMESPACES = [
  'hive.ai',
  'hive',
  'ai-moderation',
  'NS-ai-generated',
  'ai-generated',
  'content-moderation',
  'divine.video/moderation',
  'nostr.watch/moderation',
];

// Category severity levels for display
const CATEGORY_SEVERITY: Record<string, 'low' | 'medium' | 'high' | 'critical'> = {
  'ai-generated': 'low',
  'aiGenerated': 'low',
  'spam': 'medium',
  'nsfw': 'medium',
  'adult': 'medium',
  'nudity': 'medium',
  'sexual': 'high',
  'violence': 'high',
  'hate': 'high',
  'harassment': 'medium',
  'csam': 'critical',
  'illegal': 'critical',
  'terrorism': 'critical',
};

function getSeverityColor(severity: string): string {
  switch (severity) {
    case 'low': return 'bg-blue-500';
    case 'medium': return 'bg-yellow-500';
    case 'high': return 'bg-orange-500';
    case 'critical': return 'bg-red-600';
    default: return 'bg-gray-500';
  }
}

function getSeverityForCategory(category: string): 'low' | 'medium' | 'high' | 'critical' {
  const lowerCategory = category.toLowerCase();
  for (const [key, severity] of Object.entries(CATEGORY_SEVERITY)) {
    if (lowerCategory.includes(key.toLowerCase())) {
      return severity;
    }
  }
  return 'medium';
}

interface AIClassification {
  label: string;
  namespace: string;
  confidence?: number;
  source: string;
  timestamp: number;
}

function extractAIClassifications(labels: NostrEvent[]): AIClassification[] {
  const classifications: AIClassification[] = [];

  for (const event of labels) {
    const namespace = event.tags.find(t => t[0] === 'L')?.[1] || '';

    // Check if this is from an AI namespace
    const isAILabel = AI_NAMESPACES.some(ns =>
      namespace.toLowerCase().includes(ns.toLowerCase())
    );

    if (!isAILabel) continue;

    // Extract all labels
    const labelTags = event.tags.filter(t => t[0] === 'l');
    for (const tag of labelTags) {
      const label = tag[1];
      const labelNamespace = tag[2] || namespace;

      // Try to extract confidence from tag or content
      let confidence: number | undefined;
      if (tag[3]) {
        const parsed = parseFloat(tag[3]);
        if (!isNaN(parsed)) confidence = parsed;
      }

      // Try to parse confidence from content if JSON
      if (!confidence && event.content) {
        try {
          const parsed = JSON.parse(event.content);
          if (parsed.confidence !== undefined) {
            confidence = parsed.confidence;
          }
          if (parsed.score !== undefined) {
            confidence = parsed.score;
          }
        } catch {
          // Not JSON, ignore
        }
      }

      classifications.push({
        label,
        namespace: labelNamespace,
        confidence,
        source: event.pubkey,
        timestamp: event.created_at,
      });
    }
  }

  return classifications;
}

export function HiveAIReport({ targetType, targetValue, className }: HiveAIReportProps) {
  const { nostr } = useNostr();

  // Query for AI-related labels on this target
  const { data: aiLabels, isLoading } = useQuery({
    queryKey: ['ai-labels', targetType, targetValue],
    queryFn: async ({ signal }) => {
      const filter = targetType === 'event'
        ? { kinds: [1985], '#e': [targetValue], limit: 50 }
        : { kinds: [1985], '#p': [targetValue], limit: 50 };

      const events = await nostr.query(
        [filter],
        { signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) }
      );

      return events;
    },
    staleTime: 5 * 60 * 1000,
  });

  if (isLoading) {
    return (
      <div className={className}>
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }

  if (!aiLabels || aiLabels.length === 0) {
    return null; // No AI labels found, don't show anything
  }

  const classifications = extractAIClassifications(aiLabels);

  if (classifications.length === 0) {
    return null; // No AI-specific classifications
  }

  return (
    <Card className={`border-blue-200 dark:border-blue-800 ${className}`}>
      <CardHeader className="py-2 px-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <Bot className="h-4 w-4 text-blue-500" />
          AI Moderation Results
        </CardTitle>
      </CardHeader>
      <CardContent className="py-2 px-3 space-y-2">
        {classifications.map((classification, idx) => {
          const severity = getSeverityForCategory(classification.label);
          const severityColor = getSeverityColor(severity);

          return (
            <div key={idx} className="flex items-center gap-2">
              <Badge className={`${severityColor} text-white text-xs`}>
                {classification.label}
              </Badge>
              {classification.confidence !== undefined && (
                <div className="flex items-center gap-2 flex-1">
                  <Progress
                    value={classification.confidence * 100}
                    className="h-1.5 flex-1 max-w-20"
                  />
                  <span className="text-xs text-muted-foreground">
                    {Math.round(classification.confidence * 100)}%
                  </span>
                </div>
              )}
              <span className="text-xs text-muted-foreground">
                {classification.namespace}
              </span>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

interface AIStatusBadgeProps {
  labels: NostrEvent[];
  className?: string;
}

export function AIStatusBadge({ labels, className }: AIStatusBadgeProps) {
  const classifications = extractAIClassifications(labels);

  if (classifications.length === 0) {
    return null;
  }

  // Find highest severity
  const severities = classifications.map(c => getSeverityForCategory(c.label));
  const hasCritical = severities.includes('critical');
  const hasHigh = severities.includes('high');
  const hasMedium = severities.includes('medium');

  let statusColor = 'bg-blue-500';
  let statusIcon = <Bot className="h-3 w-3" />;
  let statusText = 'AI Flagged';

  if (hasCritical) {
    statusColor = 'bg-red-600';
    statusIcon = <AlertTriangle className="h-3 w-3" />;
    statusText = 'Critical';
  } else if (hasHigh) {
    statusColor = 'bg-orange-500';
    statusIcon = <AlertTriangle className="h-3 w-3" />;
    statusText = 'High Risk';
  } else if (hasMedium) {
    statusColor = 'bg-yellow-500';
    statusIcon = <Shield className="h-3 w-3" />;
    statusText = 'Flagged';
  }

  return (
    <Badge className={`${statusColor} text-white ${className}`}>
      {statusIcon}
      <span className="ml-1">{statusText}</span>
    </Badge>
  );
}
