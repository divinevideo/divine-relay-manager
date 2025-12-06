// ABOUTME: Displays information about who submitted a report
// ABOUTME: Shows reporter profile and their report history count

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Flag, Star } from "lucide-react";
import type { NostrMetadata } from "@nostrify/nostrify";

interface ReporterInfoProps {
  profile?: NostrMetadata;
  pubkey?: string;
  reportCount: number;
  isLoading?: boolean;
}

function getTrustLevel(reportCount: number): { level: string; stars: number; color: string } {
  if (reportCount >= 50) return { level: 'Trusted', stars: 5, color: 'text-green-500' };
  if (reportCount >= 20) return { level: 'Active', stars: 4, color: 'text-blue-500' };
  if (reportCount >= 10) return { level: 'Regular', stars: 3, color: 'text-yellow-500' };
  if (reportCount >= 3) return { level: 'New', stars: 2, color: 'text-orange-500' };
  return { level: 'First-time', stars: 1, color: 'text-gray-500' };
}

export function ReporterInfo({ profile, pubkey, reportCount, isLoading }: ReporterInfoProps) {
  if (isLoading) {
    return (
      <Card>
        <CardContent className="p-3">
          <div className="flex items-center gap-3">
            <Skeleton className="h-8 w-8 rounded-full" />
            <div className="space-y-1">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-3 w-16" />
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!pubkey) {
    return null;
  }

  const displayName = profile?.name || pubkey.slice(0, 12) + '...';
  const trust = getTrustLevel(reportCount);

  return (
    <Card>
      <CardContent className="p-3">
        <h5 className="text-xs font-medium text-muted-foreground uppercase mb-2">
          Reported By
        </h5>
        <div className="flex items-center gap-3">
          <Avatar className="h-8 w-8">
            <AvatarImage src={profile?.picture} />
            <AvatarFallback>{displayName.slice(0, 2).toUpperCase()}</AvatarFallback>
          </Avatar>
          <div className="flex-1">
            <p className="text-sm font-medium">{displayName}</p>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="flex items-center gap-1">
                <Flag className="h-3 w-3" />
                {reportCount} reports
              </span>
              <span className={`flex items-center gap-0.5 ${trust.color}`}>
                {Array.from({ length: trust.stars }).map((_, i) => (
                  <Star key={i} className="h-3 w-3 fill-current" />
                ))}
              </span>
              <Badge variant="outline" className="text-xs">
                {trust.level}
              </Badge>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
