// ABOUTME: OAuth callback landing. Exchanges the code via the SDK, refreshes the
// session, and returns the moderator to where they started signing in.
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { completeLogin } from '@/lib/divineLogin';
import { useDivineSession } from '@/hooks/useDivineSession';

export default function AuthCallback() {
  const navigate = useNavigate();
  const { refresh } = useDivineSession();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { returnPath } = await completeLogin(window.location.href);
        await refresh();
        if (!cancelled) navigate(returnPath, { replace: true });
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Sign-in failed');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [navigate, refresh]);

  return (
    <div className="flex h-screen items-center justify-center">
      {error ? (
        <div className="max-w-md text-center space-y-3">
          <p className="text-destructive font-medium">Sign-in failed</p>
          <p className="text-sm text-muted-foreground">{error}</p>
          <a href="/reports" className="text-sm text-primary hover:underline">
            Return to the tool
          </a>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Signing you in...</p>
      )}
    </div>
  );
}
