import { ReactNode, useEffect, useMemo } from 'react';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { AppContext, type AppConfig, type AppContextType, type Theme } from '@/contexts/AppContext';
import { parseStoredConfig } from '@/lib/appConfig';

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

  // Fix stale localhost URLs saved from dev sessions: a deployed build should
  // never keep talking to a local stack. Only reset to a default that is set
  // and not itself local. In a local build (defaults from VITE_WORKER_URL/
  // VITE_RELAY_URL pointing at localhost) there is nothing to protect, and
  // resetting one local address to another re-ran on every render, since
  // setConfig changes identity each render: "Maximum update depth exceeded"
  // (#433). With this guard the reset leaves a value the check no longer
  // matches, so it cannot repeat.
  //
  // Both fields go in one setConfig call: useLocalStorage's setter builds from
  // the render's state rather than the latest, so a second call in the same
  // pass would overwrite the first.
  useEffect(() => {
    const resetApi = isStaleApiUrl(config.apiUrl)
      && Boolean(defaultConfig.apiUrl) && !isStaleApiUrl(defaultConfig.apiUrl);
    const resetRelay = isStaleRelayUrl(config.relayUrl)
      && Boolean(defaultConfig.relayUrl) && !isStaleRelayUrl(defaultConfig.relayUrl);
    if (!resetApi && !resetRelay) return;

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
