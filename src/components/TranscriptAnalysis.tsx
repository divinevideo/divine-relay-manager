// ABOUTME: Displays transcript/topic analysis data from the divine-moderation-service VTT pipeline
// ABOUTME: Shows primary topic, language, speech detection, and topic confidence breakdown

import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { MessageSquareText } from "lucide-react";
import { useApiUrl } from "@/hooks/useAdminApi";
import { getClassifierData } from "@/lib/adminApi";

interface TranscriptAnalysisProps {
  sha256: string;
  className?: string;
}

export function TranscriptAnalysis({ sha256, className }: TranscriptAnalysisProps) {
  const apiUrl = useApiUrl();

  const { data: classifierData, isLoading } = useQuery({
    queryKey: ['classifier-data', sha256],
    queryFn: () => getClassifierData(apiUrl, sha256),
    enabled: !!sha256,
    staleTime: 5 * 60 * 1000, // Cache for 5 minutes
  });

  // No sha256 - nothing to show
  if (!sha256) return null;

  // Loading state
  if (isLoading) {
    return (
      <Card className={`border-teal-200 dark:border-teal-800 ${className}`}>
        <CardHeader className="py-2 px-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <MessageSquareText className="h-4 w-4 text-teal-500" />
            Transcript Analysis
          </CardTitle>
        </CardHeader>
        <CardContent className="py-2 px-3">
          <Skeleton className="h-12 w-full" />
        </CardContent>
      </Card>
    );
  }

  // No data or no topic profile - render nothing
  if (!classifierData?.topicProfile) return null;

  const profile = classifierData.topicProfile;

  // If profile has no meaningful data at all, render nothing
  const hasData = profile.primary_topic || profile.topics?.length ||
    profile.has_speech !== undefined || profile.language_hint;
  if (!hasData) return null;

  return (
    <Card className={`border-teal-200 dark:border-teal-800 ${className}`}>
      <CardHeader className="py-2 px-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <MessageSquareText className="h-4 w-4 text-teal-500" />
          Transcript Analysis
        </CardTitle>
      </CardHeader>
      <CardContent className="py-2 px-3 space-y-3">
        {/* Primary topic and indicators */}
        <div className="flex flex-wrap items-center gap-2">
          {profile.primary_topic && (
            <Badge className="text-xs bg-teal-500 text-white">
              {profile.primary_topic}
            </Badge>
          )}
          {profile.language_hint && (
            <Badge variant="outline" className="text-xs">
              {profile.language_hint}
            </Badge>
          )}
          {profile.has_speech !== undefined && (
            <Badge variant={profile.has_speech ? "secondary" : "outline"} className="text-xs">
              {profile.has_speech ? "Speech detected" : "No speech"}
            </Badge>
          )}
        </div>

        {/* Topic breakdown with confidence bars */}
        {profile.topics && profile.topics.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">Topic Breakdown</p>
            {profile.topics.map((topic) => {
              const percentage = Math.round(topic.confidence * 100);
              return (
                <div key={topic.category} className="space-y-1">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-foreground">{topic.category}</span>
                    <span className="text-muted-foreground">{percentage}%</span>
                  </div>
                  <Progress
                    value={percentage}
                    className="h-1.5 [&>div]:bg-teal-500"
                  />
                  {topic.keywords_matched && topic.keywords_matched.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-0.5">
                      {topic.keywords_matched.map((keyword) => (
                        <span key={keyword} className="text-[10px] text-muted-foreground">
                          {keyword}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
