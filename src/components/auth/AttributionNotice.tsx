// ABOUTME: Tells a moderator with no resolved identity that their moderation
// ABOUTME: actions are being recorded without attribution, and offers sign-in.
//
// CF Access is the access gate, so this never blocks anything -- it is the cue
// that replaces the login walls this tool used to put in front of the relay
// management surfaces. Without it a moderator has no reason to sign in and
// every decision they write lands moderator_pubkey = null (#178, #181).
import { LogIn, UserX } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useDivineSession } from '@/hooks/useDivineSession';
import { useStartSignIn } from '@/hooks/useStartSignIn';

export function AttributionNotice() {
  const { user } = useCurrentUser();
  const { isResolving } = useDivineSession();
  const handleSignIn = useStartSignIn();

  // Nothing to say while the session is still resolving: an already-signed-in
  // moderator would otherwise see the warning flash on every load.
  if (isResolving || user) return null;

  return (
    <Alert className="mb-3 shrink-0">
      <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-2">
          <UserX className="h-4 w-4 shrink-0" aria-hidden />
          Moderation actions are being recorded without attribution.
        </span>
        <Button size="sm" variant="outline" onClick={handleSignIn}>
          <LogIn className="h-4 w-4 mr-2" />
          Sign in
        </Button>
      </AlertDescription>
    </Alert>
  );
}
