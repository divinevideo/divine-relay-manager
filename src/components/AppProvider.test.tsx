// ABOUTME: Tests AppProvider's reset of stale local relay/API addresses in the stored config.
// ABOUTME: Covers the update loop when the defaults are themselves local (#433) and the deployed-build reset it must keep.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { AppProvider } from '@/components/AppProvider';
import { useAppContext } from '@/hooks/useAppContext';
import type { AppConfig } from '@/contexts/AppContext';
import * as environments from '@/lib/environments';

// A deployed build: the defaults point at real, remote infrastructure.
const deployedDefaults: AppConfig = {
  theme: 'light',
  relayUrl: 'wss://relay.example.com',
  apiUrl: 'https://api.example.com',
};

// A local build: .env.local sets VITE_RELAY_URL / VITE_WORKER_URL to the local
// stack, so App's defaultConfig is itself local.
const localDefaults: AppConfig = {
  theme: 'light',
  relayUrl: 'ws://localhost:4444',
  apiUrl: 'http://localhost:8787',
};

// The Local environment from .env.example (Caddy-fronted local stack).
const localEnvironment = {
  relayUrl: 'wss://localhost:4443',
  apiUrl: 'https://localhost:8788',
};
const localPreset = { id: 'local', name: 'Local', ...localEnvironment };

const STORAGE_KEY = 'nostr:app-config-v2';

// Above this, the provider is stuck re-setting its own config. Throwing from
// render stops a runaway passive-effect loop at a readable failure instead of
// letting the test hang or crash the worker.
const RENDER_LIMIT = 25;
let renders = 0;

function ShowConfig() {
  renders += 1;
  if (renders > RENDER_LIMIT) {
    throw new Error(`AppProvider re-rendered more than ${RENDER_LIMIT} times: config update loop`);
  }
  const { config, updateConfig } = useAppContext();
  return (
    <div>
      <span data-testid="relay">{config.relayUrl}</span>
      <span data-testid="api">{config.apiUrl}</span>
      <button onClick={() => updateConfig((current) => ({ ...current, ...localEnvironment }))}>
        Select Local
      </button>
    </div>
  );
}

function storeConfig(config: Partial<AppConfig> | null) {
  vi.mocked(localStorage.getItem).mockImplementation((key: string) =>
    key === STORAGE_KEY && config ? JSON.stringify(config) : null,
  );
}

function storedWrites(): AppConfig[] {
  return vi
    .mocked(localStorage.setItem)
    .mock.calls.filter(([key]) => key === STORAGE_KEY)
    .map(([, value]) => JSON.parse(value) as AppConfig);
}

function renderProvider(defaultConfig: AppConfig) {
  return render(
    <AppProvider storageKey={STORAGE_KEY} defaultConfig={defaultConfig}>
      <ShowConfig />
    </AppProvider>,
  );
}

describe('AppProvider stale local address reset', () => {
  beforeEach(() => {
    renders = 0;
    vi.stubEnv('DEV', false);
    // The storage mock is the shared one from src/test/setup.ts. Clearing call
    // history is enough: every test installs its own getItem implementation via
    // storeConfig, and setItem's implementation is a no-op worth keeping.
    vi.mocked(localStorage.getItem).mockClear();
    vi.mocked(localStorage.setItem).mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('keeps the selected Local preset in Vite dev even with remote defaults', () => {
    vi.stubEnv('DEV', true);
    vi.spyOn(environments, 'getEnvironmentById').mockReturnValue(localPreset);
    storeConfig(null);

    renderProvider(deployedDefaults);
    fireEvent.click(screen.getByRole('button', { name: 'Select Local' }));

    expect(screen.getByTestId('relay')).toHaveTextContent(localEnvironment.relayUrl);
    expect(screen.getByTestId('api')).toHaveTextContent(localEnvironment.apiUrl);
    expect(storedWrites()).toEqual([{ theme: 'light', ...localEnvironment }]);
  });

  describe('in a local build, where the defaults are themselves local', () => {
    it('settles on the local defaults instead of looping (#433)', () => {
      storeConfig(null);

      renderProvider(localDefaults);

      expect(screen.getByTestId('relay')).toHaveTextContent('ws://localhost:4444');
      expect(screen.getByTestId('api')).toHaveTextContent('http://localhost:8787');
      expect(localStorage.setItem).not.toHaveBeenCalled();
    });

    it('keeps the Local environment a moderator selected', () => {
      // Resetting here would only swap one local address for another, so there
      // is nothing to protect, and it used to loop on every render.
      storeConfig({ theme: 'light', ...localEnvironment });

      renderProvider(localDefaults);

      expect(screen.getByTestId('relay')).toHaveTextContent(localEnvironment.relayUrl);
      expect(screen.getByTestId('api')).toHaveTextContent(localEnvironment.apiUrl);
      expect(localStorage.setItem).not.toHaveBeenCalled();
    });
  });

  describe('in a deployed build', () => {
    it('resets a stale localhost relay and API to the deployed defaults', () => {
      // The protection the reset was added for: a localhost address persisted in
      // this origin's storage would otherwise break every relay read and API call.
      storeConfig({ theme: 'dark', ...localEnvironment });

      renderProvider(deployedDefaults);

      expect(screen.getByTestId('relay')).toHaveTextContent('wss://relay.example.com');
      expect(screen.getByTestId('api')).toHaveTextContent('https://api.example.com');
      // One write carrying both resets, with the rest of the config intact.
      // useLocalStorage's setter builds from the render's state, not the latest,
      // so a second setConfig in the same pass would overwrite the first.
      expect(storedWrites()).toEqual([
        { theme: 'dark', relayUrl: 'wss://relay.example.com', apiUrl: 'https://api.example.com' },
      ]);
    });

    it('resets saved Local addresses even if the build includes the Local preset', () => {
      vi.spyOn(environments, 'getEnvironmentById').mockReturnValue(localPreset);
      storeConfig({ theme: 'light', ...localEnvironment });

      renderProvider(deployedDefaults);

      expect(storedWrites()).toEqual([deployedDefaults]);
    });

    it('resets a plain-HTTP API on a remote hostname and keeps the chosen relay', () => {
      const relayUrl = 'wss://custom-relay.example.com';
      storeConfig({ theme: 'light', relayUrl, apiUrl: 'http://api.example.com' });

      renderProvider(deployedDefaults);

      expect(screen.getByTestId('api')).toHaveTextContent('https://api.example.com');
      expect(screen.getByTestId('relay')).toHaveTextContent(relayUrl);
      expect(storedWrites()).toEqual([{ ...deployedDefaults, relayUrl }]);
    });

    it('does not wipe a stored address when the default is empty', () => {
      // An unset default is not something to reset to: keep what was stored.
      storeConfig({ theme: 'light', ...localEnvironment });

      renderProvider({ theme: 'light', relayUrl: '', apiUrl: '' });

      expect(screen.getByTestId('relay')).toHaveTextContent(localEnvironment.relayUrl);
      expect(screen.getByTestId('api')).toHaveTextContent(localEnvironment.apiUrl);
      expect(localStorage.setItem).not.toHaveBeenCalled();
    });

    it.each(['apiUrl', 'relayUrl'] as const)('keeps both local addresses if the default %s is local', (localDefault) => {
      storeConfig({ theme: 'light', ...localEnvironment });

      renderProvider({ ...deployedDefaults, [localDefault]: localDefaults[localDefault] });

      expect(screen.getByTestId('relay')).toHaveTextContent(localEnvironment.relayUrl);
      expect(screen.getByTestId('api')).toHaveTextContent(localEnvironment.apiUrl);
      expect(storedWrites()).toEqual([]);
    });

    it('leaves a remote environment the moderator chose alone', () => {
      storeConfig({
        theme: 'light',
        relayUrl: 'wss://relay.staging.example.com',
        apiUrl: 'https://api-staging.example.com',
      });

      renderProvider(deployedDefaults);

      expect(screen.getByTestId('relay')).toHaveTextContent('wss://relay.staging.example.com');
      expect(screen.getByTestId('api')).toHaveTextContent('https://api-staging.example.com');
      expect(localStorage.setItem).not.toHaveBeenCalled();
    });
  });
});
