// ABOUTME: Starts the divine-login redirect and reports a failed start as a
// ABOUTME: toast. Shared by every sign-in affordance so they cannot drift.
import { useCallback } from 'react';

import { useDivineSession } from '@/hooks/useDivineSession';
import { useToast } from '@/hooks/useToast';

export function useStartSignIn(): () => void {
  const { startLogin } = useDivineSession();
  const { toast } = useToast();

  // startLogin builds the authorize URL (can reject on a network failure) before
  // redirecting; surface that instead of silently doing nothing.
  return useCallback(() => {
    startLogin(`${window.location.pathname}${window.location.search}`).catch((e) => {
      toast({
        title: 'Could not start sign-in',
        description: e instanceof Error ? e.message : 'Please try again.',
        variant: 'destructive',
      });
    });
  }, [startLogin, toast]);
}
