// ABOUTME: Displays AI-generated behavioral summary for reported user
// ABOUTME: Shows risk level badge and summary text

import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Bot, AlertTriangle, AlertCircle, ShieldAlert, Skull } from "lucide-react";

interface AISummaryProps {
  summary?: string;
  riskLevel?: 'low' | 'medium' | 'high' | 'critical';
  isLoading?: boolean;
  error?: Error | null;
}

const RISK_CONFIG = {
  low: {
    icon: AlertCircle,
    color: 'bg-green-500',
    textColor: 'text-green-700',
    label: 'Low Risk'
  },
  medium: {
    icon: AlertTriangle,
    color: 'bg-yellow-500',
    textColor: 'text-yellow-700',
    label: 'Medium Risk'
  },
  high: {
    icon: ShieldAlert,
    color: 'bg-orange-500',
    textColor: 'text-orange-700',
    label: 'High Risk'
  },
  critical: {
    icon: Skull,
    color: 'bg-red-600',
    textColor: 'text-red-700',
    label: 'Critical Risk'
  },
};

export function AISummary({ summary, riskLevel, isLoading, error }: AISummaryProps) {
  if (isLoading) {
    return (
      <Card>
        <CardContent className="p-3">
          <div className="flex items-center gap-2 mb-2">
            <Bot className="h-4 w-4 animate-pulse" />
            <span className="text-xs text-muted-foreground">Generating summary...</span>
          </div>
          <Skeleton className="h-12 w-full" />
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Alert variant="default" className="bg-muted">
        <Bot className="h-4 w-4" />
        <AlertDescription className="text-xs">
          AI summary unavailable
        </AlertDescription>
      </Alert>
    );
  }

  if (!summary) {
    return null;
  }

  const risk = riskLevel ? RISK_CONFIG[riskLevel] : RISK_CONFIG.low;
  const RiskIcon = risk.icon;

  return (
    <Card>
      <CardContent className="p-3">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <Bot className="h-4 w-4 text-muted-foreground" />
            <span className="text-xs font-medium text-muted-foreground uppercase">
              AI Analysis
            </span>
          </div>
          <Badge className={`${risk.color} text-white text-xs`}>
            <RiskIcon className="h-3 w-3 mr-1" />
            {risk.label}
          </Badge>
        </div>
        <p className="text-sm">{summary}</p>
      </CardContent>
    </Card>
  );
}
