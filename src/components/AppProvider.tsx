import { ReactNode, useEffect, useMemo } from 'react';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { AppContext, type AppConfig, type AppContextType, type Theme } from '@/contexts/AppContext';
import { parseStoredConfig } from '@/lib/appConfig';
import { getEnvironmentById } from '@/lib/environments';

interface AppProviderProps {
  children: ReactNode;
  /** Application storage key */
  storageKey: string;
  /** Default app configuration */
  defaultConfig: AppConfig;
  /** Optional list of preset relays to display in the RelaySelector */
  presetRelays?: { name: string; url: string }[];
}

export function AppProvider(props: AppProviderProps) {
  const {
    children,
    storageKey,
    defaultConfig,
    presetRelays,
  } = props;

  // App configuration state with localStorage persistence. The stored copy is
  // reconciled against defaultConfig on read so a config saved before a field
  // existed picks it up instead of staying undefined for the life of the browser.
  const serializer = useMemo(() => ({
    serialize: JSON.stringify,
    deserialize: (raw: string) => parseStoredConfig(raw, defaultConfig),
  }), [defaultConfig]);

  const [config, setConfig] = useLocalStorage<AppConfig>(storageKey, defaultConfig, serializer);

  // Reset stale addresses only to usable defaults so the effect settles (#433).
  useEffect(() => {
    const staleApi = isStaleApiUrl(config.apiUrl);
    const staleRelay = isStaleRelayUrl(config.relayUrl);
    const resetApi = staleApi
      && Boolean(defaultConfig.apiUrl) && !isStaleApiUrl(defaultConfig.apiUrl);
    const resetRelay = staleRelay
      && Boolean(defaultConfig.relayUrl) && !isStaleRelayUrl(defaultConfig.relayUrl);
    if (!resetApi && !resetRelay) return;

    // Keep a saved local pair together if only one default can replace it.
    if (staleApi && staleRelay && (!resetApi || !resetRelay)) return;

    // The dev server's Local preset is configured separately from the defaults.
    const local = import.meta.env.DEV ? getEnvironmentById('local') : undefined;
    if (local?.apiUrl === config.apiUrl && local?.relayUrl === config.relayUrl) return;

    // The storage setter builds from the current render's state, so write once.
    setConfig((prev) => ({
      ...prev,
      ...(resetApi && { apiUrl: defaultConfig.apiUrl }),
      ...(resetRelay && { relayUrl: defaultConfig.relayUrl }),
    }));
  }, [config.apiUrl, config.relayUrl, defaultConfig.apiUrl, defaultConfig.relayUrl, setConfig]);

  // Generic config updater with callback pattern
  const updateConfig = (updater: (currentConfig: AppConfig) => AppConfig) => {
    setConfig(updater);
  };

  const appContextValue: AppContextType = {
    config,
    updateConfig,
    presetRelays,
  };

  // Apply theme effects to document
  useApplyTheme(config.theme);

  return (
    <AppContext.Provider value={appContextValue}>
      {children}
    </AppContext.Provider>
  );
}

function isStaleApiUrl(url: string | undefined): boolean {
  return !!url && (url.includes('localhost') || url.startsWith('http://'));
}

function isStaleRelayUrl(url: string | undefined): boolean {
  return !!url && url.includes('localhost');
}

/**
 * Hook to apply theme changes to the document root
 */
function useApplyTheme(theme: Theme) {
  useEffect(() => {
    const root = window.document.documentElement;

    root.classList.remove('light', 'dark');

    if (theme === 'system') {
      const systemTheme = window.matchMedia('(prefers-color-scheme: dark)')
        .matches
        ? 'dark'
        : 'light';

      root.classList.add(systemTheme);
      return;
    }

    root.classList.add(theme);
  }, [theme]);

  // Handle system theme changes when theme is set to "system"
  useEffect(() => {
    if (theme !== 'system') return;

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    
    const handleChange = () => {
      const root = window.document.documentElement;
      root.classList.remove('light', 'dark');
      
      const systemTheme = mediaQuery.matches ? 'dark' : 'light';
      root.classList.add(systemTheme);
    };

    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, [theme]);
}
