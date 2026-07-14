// ABOUTME: Single source of truth for the divine-login session. The SDK owns
// storage/refresh; this context holds the resolved credentials for the app.
import { createContext, useCallback, useEffect, useState, type ReactNode } from 'react';
import type { StoredCredentials } from '@divinevideo/login';
import { getSession, logout as sdkLogout, startLogin as sdkStartLogin } from '@/lib/divineLogin';

export interface DivineSessionValue {
  credentials: StoredCredentials | null;
  isResolving: boolean;
  startLogin: (returnPath?: string) => Promise<void>;
  logout: () => void;
  refresh: () => Promise<void>;
}

const defaultValue: DivineSessionValue = {
  credentials: null,
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
  const [isResolving, setIsResolving] = useState(true);

  const refresh = useCallback(async () => {
    const creds = await getSession();
    setCredentials(creds);
    setIsResolving(false);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const creds = await getSession();
      if (!cancelled) {
        setCredentials(creds);
        setIsResolving(false);
      }
    })();
    const onFocus = () => {
      void refresh();
    };
    window.addEventListener('focus', onFocus);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', onFocus);
    };
  }, [refresh]);

  const logout = useCallback(() => {
    sdkLogout();
    setCredentials(null);
  }, []);

  return (
    <DivineSessionContext.Provider
      value={{ credentials, isResolving, startLogin: sdkStartLogin, logout, refresh }}
    >
      {children}
    </DivineSessionContext.Provider>
  );
}
