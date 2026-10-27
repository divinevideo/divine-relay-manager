// ABOUTME: The report pane's Related Reports card: reports on the same account and on its events.
// ABOUTME: Counted from the complete per-account read, so it does not depend on what the queue has loaded.

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CopyableId } from "@/components/CopyableId";
import { useRelatedReports } from "@/hooks/useRelatedReports";
import { historyCount } from "@/lib/historyCount";
import { getCategoryLabel, getReportCategory } from "@/lib/constants";
import { Link2, User, FileText, Loader2 } from "lucide-react";
import { getReportTarget, type ReportTarget } from "../../shared/report-target";

interface RelatedReportsCardProps {
  pubkey: string;
  currentTarget: ReportTarget | null;
}

const CARD_CLASS = "border-orange-200 bg-orange-50/50 dark:bg-orange-950/20";
const TITLE_CLASS = "text-sm flex items-center gap-2 text-orange-700 dark:text-orange-400";

export function RelatedReportsCard({ pubkey, currentTarget }: RelatedReportsCardProps) {
  const related = useRelatedReports(pubkey, currentTarget);

  if (!pubkey) return null;

  if (related.status === 'loading') {
    return (
      <Card className={CARD_CLASS}>
        <CardHeader className="py-3">
          <CardTitle className={TITLE_CLASS}>
            <Link2 className="h-4 w-4" />
            Related Reports: checking…
          </CardTitle>
        </CardHeader>
      </Card>
    );
  }

  // A failed read is not "no related reports": say so, and let the moderator retry.
  if (related.status === 'error') {
    return (
      <Card className={CARD_CLASS}>
        <CardHeader className="py-3">
          <CardTitle className={TITLE_CLASS}>
            <Link2 className="h-4 w-4" />
            Related reports could not be loaded
            <Button variant="outline" size="sm" className="ml-auto h-7" onClick={related.retry} disabled={related.retrying}>
              {related.retrying && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
              Try again
            </Button>
          </CardTitle>
        </CardHeader>
      </Card>
    );
  }

  const { userReports, eventReports, truncated } = related;
  const total = userReports.length + eventReports.length;
  // Hidden only after a complete read finds nothing. A read that stopped early
  // is not proof of nothing, so the card stays and says what was and was not read.
  if (total === 0 && !truncated) return null;
  if (total === 0) {
    return (
      <Card className={CARD_CLASS}>
        <CardHeader className="py-3">
          <CardTitle className={TITLE_CLASS}>
            <Link2 className="h-4 w-4" />
            Related Reports: none found in the part of this account's history that could be read.
          </CardTitle>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card className={CARD_CLASS}>
      <CardHeader className="py-3">
        <CardTitle className={TITLE_CLASS}>
          <Link2 className="h-4 w-4" />
          Related Reports ({historyCount(total, truncated)} more on this account)
        </CardTitle>
      </CardHeader>
      <CardContent className="py-0 pb-3">
        <div className="space-y-2">
          {userReports.length > 0 && (
            <div>
              <p className="text-xs font-medium flex items-center gap-1 mb-1.5 text-muted-foreground">
                <User className="h-3 w-3" />
                Reports on this User ({historyCount(userReports.length, truncated)})
              </p>
              <div className="space-y-1">
                {userReports.slice(0, 3).map((r) => {
                  const cat = getReportCategory(r);
                  const catLabel = getCategoryLabel(cat);
                  return (
                    <div key={r.id} className="flex items-center gap-2 text-xs p-1.5 bg-background rounded">
                      <Badge variant="outline" className="text-xs">{catLabel}</Badge>
                      <span className="text-muted-foreground truncate flex-1">
                        {r.content?.slice(0, 40) || 'No description'}
                        {(r.content?.length || 0) > 40 && '...'}
                      </span>
                    </div>
                  );
                })}
                {userReports.length > 3 && (
                  <p className="text-xs text-muted-foreground pl-1">
                    +{historyCount(userReports.length - 3, truncated)} more user reports
                  </p>
                )}
              </div>
            </div>
          )}
          {eventReports.length > 0 && (
            <div>
              <p className="text-xs font-medium flex items-center gap-1 mb-1.5 text-muted-foreground">
                <FileText className="h-3 w-3" />
                Reports on their Events ({historyCount(eventReports.length, truncated)})
              </p>
              <div className="space-y-1">
                {eventReports.slice(0, 3).map((r) => {
                  const cat = getReportCategory(r);
                  const catLabel = getCategoryLabel(cat);
                  const target = getReportTarget(r);
                  return (
                    <div key={r.id} className="flex items-center gap-2 text-xs p-1.5 bg-background rounded">
                      <Badge variant="outline" className="text-xs">{catLabel}</Badge>
                      {target?.value && (
                        <CopyableId
                          value={target.value}
                          type="note"
                          truncateStart={10}
                          truncateEnd={4}
                          size="xs"
                        />
                      )}
                    </div>
                  );
                })}
                {eventReports.length > 3 && (
                  <p className="text-xs text-muted-foreground pl-1">
                    +{historyCount(eventReports.length - 3, truncated)} more event reports
                  </p>
                )}
              </div>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
