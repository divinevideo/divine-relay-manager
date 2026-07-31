// ABOUTME: Sign-in surface for the shell header. Signed out -> "Sign in";
// signed in -> the moderator's name/pubkey + "Sign out". Attribution only;
// CF Access remains the access gate.
import { AlertTriangle, LogIn, LogOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useDivineSession } from '@/hooks/useDivineSession';
import { useToast } from '@/hooks/useToast';

function shortPubkey(pubkey: string): string {
  return `${pubkey.slice(0, 8)}...${pubkey.slice(-4)}`;
}

export function DivineLoginButton() {
  const { user, metadata } = useCurrentUser();
  const { startLogin, logout, isResolving, identityUnavailable } = useDivineSession();
  const { toast } = useToast();

  // startLogin builds the authorize URL (can reject on a network failure) before
  // redirecting; surface that instead of silently doing nothing.
  const handleSignIn = () => {
    startLogin(`${window.location.pathname}${window.location.search}`).catch((e) => {
      toast({
        title: 'Could not start sign-in',
        description: e instanceof Error ? e.message : 'Please try again.',
        variant: 'destructive',
      });
    });
  };

  if (isResolving) {
    return <div className="h-9 w-24 animate-pulse rounded-md bg-muted" aria-hidden />;
  }

  if (user) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium max-w-[12rem] truncate" title={user.pubkey}>
          {metadata?.name || shortPubkey(user.pubkey)}
        </span>
        <Button variant="ghost" size="sm" onClick={logout} title="Sign out">
          <LogOut className="h-4 w-4" />
          <span className="sr-only">Sign out</span>
        </Button>
      </div>
    );
  }

  // Signed in, but no identity came back. Say so and offer the way out; sending
  // them back through "Sign in" just loops them through the same failure.
  if (identityUnavailable) {
    return (
      <div className="flex items-center gap-2">
        {/* No role="status": it is not a name-from-content role, so the title
            would replace the visible label as the accessible name, and a region
            inserted already-populated is not reliably announced anyway. */}
        <span
          className="flex items-center gap-1.5 text-sm text-destructive whitespace-nowrap"
          title="Your moderator identity could not be loaded, so moderation actions may be recorded without attribution. Moderation itself still works. If signing out and back in does not help, this account may have no Keycast-managed key."
        >
          <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
          <span className="max-w-[16rem] truncate">Identity unavailable, actions unattributed</span>
        </span>
        <Button variant="ghost" size="sm" onClick={logout} title="Sign out">
          <LogOut className="h-4 w-4" />
          <span className="sr-only">Sign out</span>
        </Button>
      </div>
    );
  }

  return (
    <Button size="sm" onClick={handleSignIn}>
      <LogIn className="h-4 w-4 mr-2" />
      Sign in
    </Button>
  );
}
