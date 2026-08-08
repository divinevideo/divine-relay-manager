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
  const { startLogin, logout, isResolving, isSignedIn, identityUnavailable } = useDivineSession();
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
    return (
      <div className="flex items-center gap-2">
        <div className="h-9 w-24 animate-pulse rounded-md bg-muted" aria-hidden />
        {/* A resolve is not quickly bounded: DivineRpc.call retries 429 up to
            four attempts and 401 once, each with its own 30s timeout and an
            unclamped server-supplied Retry-After, so a single getPublicKey can
            stall for minutes. Without this the moderator spends that window
            looking at an aria-hidden placeholder with no sign-out and nothing
            for a screen reader -- the same dead end this component exists to
            remove, reached through a slower door. No timer and no new state:
            the escape hatch is simply always available once a session exists.
            Gated on isSignedIn so a signed-out visitor, who is also briefly
            "resolving" at boot, is never offered a sign-out. */}
        {isSignedIn && (
          <Button variant="ghost" size="sm" onClick={logout} title="Sign out">
            <LogOut className="h-4 w-4" />
            <span className="sr-only">Sign out</span>
          </Button>
        )}
      </div>
    );
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
          {/* "may be", matching the title: DivineRpcSigner caches the pubkey only
              on success, so getModeratorPubkey retries the RPC on every action.
              After a transient failure the banner is latched for the life of the
              token while attribution has already recovered, and a label that
              states it as fact would be wrong for exactly that window. */}
          {/* Widened with the wording: measured against the built CSS in a
              headless browser, this label is 300px natural, so the previous
              16rem (256px) truncated it mid-phrase and cut off the consequence
              -- which is the reason the consequence was moved out of the hover
              title and onto the label in the first place. 24rem clears it.
              truncate caps the width against that max only; it is NOT a
              narrow-viewport guard. Shrink pressure never reaches this label
              because the header's outer flex row (RelayManager's gap-3
              container) keeps min-width:auto, so a very narrow header overflows
              instead of truncating. Measured: min-width:0 on this label, on the
              banner span, and on the gap-2 wrapper all change nothing -- and
              unblocking the whole chain is not the fix either, since the label
              then shrinks to nothing at 375px, which is worse than an overflow
              on a desktop-only tool. That overflow predates this banner and
              affects the signed-in name the same way. jsdom performs no layout,
              so no test can pin any of this. */}
          <span className="max-w-[24rem] truncate">Identity unavailable, actions may be unattributed</span>
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
