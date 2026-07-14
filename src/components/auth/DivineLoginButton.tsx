// ABOUTME: Sign-in surface for the shell header. Signed out -> "Sign in";
// signed in -> the moderator's name/pubkey + "Sign out". Attribution only;
// CF Access remains the access gate.
import { LogIn, LogOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useDivineSession } from '@/hooks/useDivineSession';

function shortPubkey(pubkey: string): string {
  return `${pubkey.slice(0, 8)}...${pubkey.slice(-4)}`;
}

export function DivineLoginButton() {
  const { user, metadata } = useCurrentUser() as {
    user?: { pubkey: string };
    metadata?: { name?: string };
  };
  const { startLogin, logout, isResolving } = useDivineSession();

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

  return (
    <Button
      size="sm"
      onClick={() => startLogin(`${window.location.pathname}${window.location.search}`)}
    >
      <LogIn className="h-4 w-4 mr-2" />
      Sign in
    </Button>
  );
}
