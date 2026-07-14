// ABOUTME: Provider that resolves the divine-login session AND the moderator
// identity (pubkey + signer) once, so every useCurrentUser consumer shares it
// (no per-mount RPC, no act-before-resolve null-attribution race).
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { StoredCredentials } from '@divinevideo/login';
import type { NostrSigner } from '@nostrify/nostrify';
import { getSession, logout as sdkLogout, startLogin as sdkStartLogin } from '@/lib/divineLogin';
import { DivineRpcSigner } from '@/lib/divineSigner';
import { DivineSessionContext, type DivineSessionValue } from '@/contexts/DivineSessionContext';

const HEX_64 = /^[0-9a-f]{64}$/;

export function DivineSessionProvider({ children }: { children: ReactNode }) {
  const [credentials, setCredentials] = useState<StoredCredentials | null>(null);
  const [credentialsResolved, setCredentialsResolved] = useState(false);
  const [pubkey, setPubkey] = useState<string | undefined>();
  // The access token the pubkey-resolution attempt has settled for (success OR
  // failure). Compared against the live token during render so isResolving is
  // derived, not lagged by a post-commit effect (avoids a one-frame "Sign in"
  // flash for an already-signed-in moderator on load).
  const [resolvedForToken, setResolvedForToken] = useState<string | undefined>(undefined);

  // Bumped on logout so an in-flight refresh that started earlier can detect it
  // lost the race and undo any session the SDK re-persisted mid-refresh.
  const generationRef = useRef(0);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Known phase-1 limitation: getSessionWithRefresh() returns null both for "no
  // session" and "refresh transiently failed", so a network blip during a
  // focus-triggered refresh collapses to signed-out until the next resolve.
  // Attribution-only and self-recovering (next focus/action re-resolves), so not
  // worth the getSession-fallback complexity here; revisit with phase-2 verify.
  const refresh = useCallback(async () => {
    const gen = generationRef.current;
    let creds: StoredCredentials | null = null;
    try {
      creds = await getSession();
    } catch {
      // Storage disabled (private mode) or an SDK throw: degrade to signed-out
      // rather than hanging on the loading state forever.
      creds = null;
    }
    if (!mountedRef.current) return;
    if (gen !== generationRef.current) {
      // A logout landed while this resolve was in flight; getSessionWithRefresh
      // may have re-persisted a refreshed session, so clear it again and bail.
      sdkLogout();
      return;
    }
    setCredentials(creds);
    setCredentialsResolved(true);
  }, []);

  useEffect(() => {
    void refresh();
    const onFocus = () => {
      void refresh();
    };
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
    };
  }, [refresh]);

  const accessToken = credentials?.accessToken;
  const signer = useMemo<NostrSigner | null>(
    () => (accessToken ? new DivineRpcSigner(() => accessToken) : null),
    [accessToken],
  );

  useEffect(() => {
    let cancelled = false;
    if (!signer) {
      setPubkey(undefined);
      return;
    }
    signer
      .getPublicKey()
      .then((pk) => {
        if (cancelled) return;
        // The worker requires canonical lowercase 64-hex. Normalize the common
        // non-canonical shapes (uppercase / whitespace); keep the prior pubkey
        // and warn on anything still invalid rather than degrading silently.
        const normalized = pk.trim().toLowerCase();
        if (HEX_64.test(normalized)) {
          setPubkey(normalized);
        } else {
          console.warn('[divine-login] getPublicKey returned a non-canonical pubkey; attribution unavailable', pk);
        }
      })
      .catch(() => {
        /* attribution degrades to null; never block on identity */
      })
      .finally(() => {
        // Mark this token resolved (success or failure) so isResolving settles.
        if (!cancelled) setResolvedForToken(accessToken);
      });
    return () => {
      cancelled = true;
    };
  }, [signer, accessToken]);

  const logout = useCallback(() => {
    generationRef.current += 1;
    sdkLogout();
    setCredentials(null);
    setPubkey(undefined);
    setCredentialsResolved(true); // logout is a definitive "signed out" resolution
  }, []);

  // Identity is pending when there's a token we have not finished resolving for.
  // Derived during render so it never lags the token by a frame.
  const identityResolved = !accessToken || resolvedForToken === accessToken;
  const isResolving = !credentialsResolved || !identityResolved;

  const value = useMemo<DivineSessionValue>(
    () => ({ credentials, pubkey, signer, isResolving, startLogin: sdkStartLogin, logout, refresh }),
    [credentials, pubkey, signer, isResolving, logout, refresh],
  );

  return <DivineSessionContext.Provider value={value}>{children}</DivineSessionContext.Provider>;
}
