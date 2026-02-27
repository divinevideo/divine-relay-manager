// ABOUTME: Displays scene classification data from the divine-moderation-service VLM pipeline
// ABOUTME: Shows description, topics, activities, objects, setting, and mood for a given media hash

import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Eye } from "lucide-react";
import { useApiUrl } from "@/hooks/useAdminApi";
import { getClassifierData } from "@/lib/adminApi";

interface SceneClassificationProps {
  sha256: string;
  className?: string;
}

export function SceneClassification({ sha256, className }: SceneClassificationProps) {
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
      <Card className={`border-purple-200 dark:border-purple-800 ${className}`}>
        <CardHeader className="py-2 px-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Eye className="h-4 w-4 text-purple-500" />
            Scene Classification
          </CardTitle>
        </CardHeader>
        <CardContent className="py-2 px-3">
          <Skeleton className="h-12 w-full" />
        </CardContent>
      </Card>
    );
  }

  // No data or no scene classification - render nothing
  if (!classifierData?.sceneClassification) return null;

  const scene = classifierData.sceneClassification;

  // If scene has no meaningful data at all, render nothing
  const hasData = scene.description || scene.topics?.length || scene.activities?.length ||
    scene.objects?.length || scene.setting || scene.mood || scene.labels?.length;
  if (!hasData) return null;

  return (
    <Card className={`border-purple-200 dark:border-purple-800 ${className}`}>
      <CardHeader className="py-2 px-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <Eye className="h-4 w-4 text-purple-500" />
          Scene Classification
        </CardTitle>
      </CardHeader>
      <CardContent className="py-2 px-3 space-y-3">
        {/* Description */}
        {scene.description && (
          <p className="text-sm text-foreground">{scene.description}</p>
        )}

        {/* Topics */}
        {scene.topics && scene.topics.length > 0 && (
          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground">Topics</p>
            <div className="flex flex-wrap gap-1">
              {scene.topics.map((topic) => (
                <Badge key={topic} variant="secondary" className="text-xs">
                  {topic}
                </Badge>
              ))}
            </div>
          </div>
        )}

        {/* Activities */}
        {scene.activities && scene.activities.length > 0 && (
          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground">Activities</p>
            <div className="flex flex-wrap gap-1">
              {scene.activities.map((activity) => (
                <Badge key={activity} variant="outline" className="text-xs">
                  {activity}
                </Badge>
              ))}
            </div>
          </div>
        )}

        {/* Objects */}
        {scene.objects && scene.objects.length > 0 && (
          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground">Objects</p>
            <div className="flex flex-wrap gap-1">
              {scene.objects.map((obj) => (
                <Badge key={obj} variant="outline" className="text-xs">
                  {obj}
                </Badge>
              ))}
            </div>
          </div>
        )}

        {/* Labels */}
        {scene.labels && scene.labels.length > 0 && (
          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground">Labels</p>
            <div className="flex flex-wrap gap-1">
              {scene.labels.map((label) => (
                <Badge key={label} className="text-xs bg-purple-500 text-white">
                  {label}
                </Badge>
              ))}
            </div>
          </div>
        )}

        {/* Setting and Mood */}
        {(scene.setting || scene.mood) && (
          <div className="flex flex-wrap gap-4 text-xs text-muted-foreground border-t pt-2">
            {scene.setting && (
              <div>
                <span className="font-medium">Setting:</span> {scene.setting}
              </div>
            )}
            {scene.mood && (
              <div>
                <span className="font-medium">Mood:</span> {scene.mood}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
