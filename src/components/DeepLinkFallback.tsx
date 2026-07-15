// ABOUTME: Right-pane fallback shown when a Reports deep-link target is no
// ABOUTME: longer retrievable from the relay (gone) or the relay was unreachable.
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import type { ModerationDecision } from '@/lib/adminApi';

const GONE_COPY =
  "This report's event is no longer on the relay. The reported content was deleted, or the account was removed. The report was recorded when it arrived.";
const UNAVAILABLE_COPY = "Couldn't reach the relay to look up this report. Try again.";

interface DeepLinkFallbackProps {
  status: 'gone' | 'unavailable';
  target: { type: 'event' | 'pubkey'; value: string };
  decisions: ModerationDecision[];
  onRetry: () => void;
}

export function DeepLinkFallback({ status, target, decisions, onRetry }: DeepLinkFallbackProps) {
  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>{status === 'gone' ? 'Report no longer on relay' : 'Relay unavailable'}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          {status === 'gone' ? GONE_COPY : UNAVAILABLE_COPY}
        </p>

        <div className="text-xs text-muted-foreground">
          <span className="font-medium">
            {target.type === 'event' ? 'Reported event' : 'Reported pubkey'}:
          </span>{' '}
          <code className="break-all">{target.value}</code>
        </div>

        {status === 'unavailable' && (
          <Button variant="outline" size="sm" onClick={onRetry}>
            Try again
          </Button>
        )}

        {status === 'gone' && decisions.length > 0 && (
          <div className="space-y-1">
            <p className="text-xs font-medium">Prior moderation actions on this target:</p>
            <ul className="text-xs text-muted-foreground space-y-2">
              {decisions.map((d) => (
                <li key={d.id}>
                  <code>{d.action}</code>
                  {d.created_at ? ` — ${d.created_at}` : ''}
                  {d.moderator_pubkey ? (
                    <>
                      {' '}by <code className="break-all">{d.moderator_pubkey}</code>
                    </>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        )}
        {status === 'gone' && decisions.length === 0 && (
          <p className="text-xs text-muted-foreground">
            No prior moderation actions recorded for this target.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
