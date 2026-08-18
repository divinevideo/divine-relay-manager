// ABOUTME: Tells a moderator with no resolved identity that their moderation
// ABOUTME: actions are being recorded without attribution, and offers sign-in.
//
// CF Access is the access gate, so this never blocks anything -- it is the cue
// that replaces the login walls this tool used to put in front of the relay
// management surfaces. Without it a moderator has no reason to sign in and
// every decision they write lands moderator_pubkey = null (#178, #181).
//
// Dismissable: the banner is informational, not a gate, and on a short viewport
// it steals vertical space from the report panes. A moderator who cannot (or
// will not) sign in can dismiss it; the choice persists so it does not return
// on every load.
import { useState } from 'react';
import { LogIn, UserX, X } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useDivineSession } from '@/hooks/useDivineSession';
import { useStartSignIn } from '@/hooks/useStartSignIn';

const DISMISS_KEY = 'attribution-notice:dismissed';

// localStorage can throw (Safari private mode, storage disabled) -- the session
// layer already degrades on that, so mirror it: never let a storage failure
// crash the banner.
function readDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

export function AttributionNotice() {
  const { user } = useCurrentUser();
  const { isResolving } = useDivineSession();
  const handleSignIn = useStartSignIn();
  const [dismissed, setDismissed] = useState(readDismissed);

  // Nothing to say while the session is still resolving: an already-signed-in
  // moderator would otherwise see the warning flash on every load.
  if (isResolving || user || dismissed) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      // Storage unavailable: still hide it for this session.
    }
    setDismissed(true);
  };

  return (
    <Alert className="mb-3 shrink-0">
      <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-2">
          <UserX className="h-4 w-4 shrink-0" aria-hidden />
          Moderation actions are being recorded without attribution.
        </span>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={handleSignIn}>
            <LogIn className="h-4 w-4 mr-2" />
            Sign in
          </Button>
          <Button size="sm" variant="ghost" onClick={dismiss} aria-label="Dismiss">
            <X className="h-4 w-4" />
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}
