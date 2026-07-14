// ABOUTME: Single source of truth for the divine-login session AND the resolved
// moderator identity (pubkey + signer). The SDK owns storage/refresh; this
// context resolves the pubkey ONCE so every useCurrentUser consumer shares it
// (no per-mount RPC, no act-before-resolve null-attribution race).
import {
  createContext,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { StoredCredentials } from '@divinevideo/login';
import type { NostrSigner } from '@nostrify/nostrify';
import { getSession, logout as sdkLogout, startLogin as sdkStartLogin } from '@/lib/divineLogin';
import { DivineRpcSigner } from '@/lib/divineSigner';

const HEX_64 = /^[0-9a-f]{64}$/;

export interface DivineSessionValue {
  credentials: StoredCredentials | null;
  /** The moderator's canonical 64-hex pubkey, once resolved. */
  pubkey: string | undefined;
  /** Signer bound to the current session token, or null when signed out. */
  signer: NostrSigner | null;
  /** True until the session (and, with a token, the pubkey) has resolved. */
  isResolving: boolean;
  startLogin: (returnPath?: string) => Promise<void>;
  logout: () => void;
  refresh: () => Promise<void>;
}

const defaultValue: DivineSessionValue = {
  credentials: null,
  pubkey: undefined,
  signer: null,
  isResolving: false,
  startLogin: sdkStartLogin,
  logout: () => {},
  refresh: async () => {},
};

// Default value is signed-out so components render logged-out without a
// provider (test ergonomics); the real provider overrides with live state.
export const DivineSessionContext = createContext<DivineSessionValue>(defaultValue);

export function DivineSessionProvider({ children }: { children: ReactNode }) {
  const [credentials, setCredentials] = useState<StoredCredentials | null>(null);
  const [credentialsResolved, setCredentialsResolved] = useState(false);
  const [pubkey, setPubkey] = useState<string | undefined>();
  // Whether the pubkey-resolution attempt has settled (success OR failure), so a
  // failed/absent getPublicKey settles isResolving instead of hanging the skeleton.
  const [identityResolved, setIdentityResolved] = useState(true);

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
      setIdentityResolved(true);
      return;
    }
    setIdentityResolved(false);
    signer
      .getPublicKey()
      // Keep the prior pubkey on a re-resolve (token refresh) to avoid flapping.
      // The worker rejects non-canonical pubkeys, so only accept lowercase 64-hex.
      .then((pk) => {
        if (!cancelled) setPubkey((prev) => (HEX_64.test(pk) ? pk : prev));
      })
      .catch(() => {
        /* attribution degrades to null; never block on identity */
      })
      .finally(() => {
        if (!cancelled) setIdentityResolved(true);
      });
    return () => {
      cancelled = true;
    };
  }, [signer]);

  const logout = useCallback(() => {
    generationRef.current += 1;
    sdkLogout();
    setCredentials(null);
    setPubkey(undefined);
    setCredentialsResolved(true); // logout is a definitive "signed out" resolution
  }, []);

  const isResolving = !credentialsResolved || (!!accessToken && !identityResolved);

  const value = useMemo<DivineSessionValue>(
    () => ({ credentials, pubkey, signer, isResolving, startLogin: sdkStartLogin, logout, refresh }),
    [credentials, pubkey, signer, isResolving, logout, refresh],
  );

  return <DivineSessionContext.Provider value={value}>{children}</DivineSessionContext.Provider>;
}
