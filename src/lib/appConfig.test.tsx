// ABOUTME: Tests that a persisted app config is reconciled against current defaults.
// ABOUTME: Covers a config saved before a field existed, and the relay/API pairing that keeps environments from mixing.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/lib/environments', () => ({
  getEnvironmentByRelayUrl: (relayUrl: string) =>
    relayUrl === 'wss://relay.staging.example.com'
      ? {
          id: 'staging',
          name: 'Staging',
          relayUrl: 'wss://relay.staging.example.com',
          apiUrl: 'https://api-staging.example.com',
        }
      : undefined,
}));

import { parseStoredConfig } from './appConfig';
import { AppProvider } from '@/components/AppProvider';
import { useAppContext } from '@/hooks/useAppContext';
import type { AppConfig } from '@/contexts/AppContext';

const defaults: AppConfig = {
  theme: 'light',
  relayUrl: 'wss://relay.example.com',
  apiUrl: 'https://api.example.com',
};

describe('parseStoredConfig', () => {
  it('keeps values the user actually chose', () => {
    const raw = JSON.stringify({
      theme: 'dark',
      relayUrl: 'wss://relay.staging.example.com',
      apiUrl: 'https://api-staging.example.com',
    });

    expect(parseStoredConfig(raw, defaults)).toEqual({
      theme: 'dark',
      relayUrl: 'wss://relay.staging.example.com',
      apiUrl: 'https://api-staging.example.com',
    });
  });

  it('keeps a custom relay the environment list does not know about', () => {
    const raw = JSON.stringify({
      theme: 'light',
      relayUrl: 'wss://relay.custom.example.com',
      apiUrl: 'https://api-custom.example.com',
    });
    const result = parseStoredConfig(raw, defaults);

    expect(result.relayUrl).toBe('wss://relay.custom.example.com');
    expect(result.apiUrl).toBe('https://api-custom.example.com');
  });

  it('fills in a field that did not exist when the config was saved', () => {
    // The shape persisted before apiUrl was introduced. Without this, apiUrl is
    // undefined forever and every worker request throws "No relay selected".
    const raw = JSON.stringify({ theme: 'dark', relayUrl: 'wss://relay.example.com' });

    expect(parseStoredConfig(raw, defaults).apiUrl).toBe('https://api.example.com');
  });

  it('preserves the rest of the stored config while filling a gap', () => {
    const raw = JSON.stringify({ theme: 'dark', relayUrl: 'wss://relay.example.com' });

    expect(parseStoredConfig(raw, defaults).theme).toBe('dark');
  });

  it('takes the missing half from the environment the stored relay belongs to', () => {
    // Backfilling apiUrl from defaults here would pair a staging relay with the
    // production API: staging content on screen, production bans on the wire.
    const raw = JSON.stringify({ theme: 'light', relayUrl: 'wss://relay.staging.example.com' });
    const result = parseStoredConfig(raw, defaults);

    expect(result.relayUrl).toBe('wss://relay.staging.example.com');
    expect(result.apiUrl).toBe('https://api-staging.example.com');
  });

  it('takes both halves from defaults when the stored relay matches no environment', () => {
    const raw = JSON.stringify({ theme: 'light', relayUrl: 'wss://relay.unknown.example.com' });
    const result = parseStoredConfig(raw, defaults);

    expect(result.relayUrl).toBe('wss://relay.example.com');
    expect(result.apiUrl).toBe('https://api.example.com');
  });

  it('replaces an empty URL rather than leaving nothing to talk to', () => {
    const raw = JSON.stringify({ theme: 'light', relayUrl: '', apiUrl: '' });
    const result = parseStoredConfig(raw, defaults);

    expect(result.apiUrl).toBe('https://api.example.com');
    expect(result.relayUrl).toBe('wss://relay.example.com');
  });

  it('falls back to defaults when the stored value is the wrong shape', () => {
    expect(parseStoredConfig('null', defaults)).toEqual(defaults);
    expect(parseStoredConfig('"a string"', defaults)).toEqual(defaults);
    expect(parseStoredConfig('[1,2]', defaults)).toEqual(defaults);
  });

  it('re-throws malformed JSON so a bad cross-tab write is ignored, not applied', () => {
    // useLocalStorage catches this: on init it falls back to defaults, and on a
    // storage event it leaves the live config alone. Returning defaults here
    // would instead drop a moderator back to production mid-session.
    expect(() => parseStoredConfig('not json', defaults)).toThrow();
  });
});

function ShowConfig() {
  const { config } = useAppContext();
  return (
    <div>
      <span data-testid="relay">{config.relayUrl}</span>
      <span data-testid="api">{config.apiUrl}</span>
    </div>
  );
}

describe('AppProvider config reconciliation', () => {
  beforeEach(() => {
    vi.mocked(localStorage.getItem).mockReset();
  });

  it('reconciles the config stored under the key the app actually reads', () => {
    // Guards the wiring, not just the parser: the serializer argument is
    // optional, so dropping it from AppProvider leaves types and unit tests green.
    vi.mocked(localStorage.getItem).mockImplementation((key: string) =>
      key === 'nostr:app-config-v2'
        ? JSON.stringify({ theme: 'light', relayUrl: 'wss://relay.staging.example.com' })
        : null,
    );

    render(
      <AppProvider storageKey="nostr:app-config-v2" defaultConfig={defaults}>
        <ShowConfig />
      </AppProvider>,
    );

    expect(screen.getByTestId('relay')).toHaveTextContent('wss://relay.staging.example.com');
    expect(screen.getByTestId('api')).toHaveTextContent('https://api-staging.example.com');
  });
});
