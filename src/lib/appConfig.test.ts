// ABOUTME: Tests that a persisted app config is reconciled against current defaults.
// ABOUTME: Covers configs saved before a field existed, which otherwise stay broken forever.

import { describe, it, expect } from 'vitest';

import { parseStoredConfig } from './appConfig';
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

  it('fills in a field that did not exist when the config was saved', () => {
    // The shape persisted before apiUrl was introduced. Without this, apiUrl is
    // undefined forever and every worker request throws "No relay selected".
    const raw = JSON.stringify({ theme: 'dark', relayUrl: 'wss://relay.example.com' });

    expect(parseStoredConfig(raw, defaults).apiUrl).toBe('https://api.example.com');
  });

  it('preserves the rest of the stored config while backfilling', () => {
    const raw = JSON.stringify({ theme: 'dark', relayUrl: 'wss://relay.chosen.example.com' });
    const result = parseStoredConfig(raw, defaults);

    expect(result.theme).toBe('dark');
    expect(result.relayUrl).toBe('wss://relay.chosen.example.com');
  });

  it('replaces an empty URL rather than leaving nothing to talk to', () => {
    const raw = JSON.stringify({ theme: 'light', relayUrl: '', apiUrl: '' });
    const result = parseStoredConfig(raw, defaults);

    expect(result.apiUrl).toBe('https://api.example.com');
    expect(result.relayUrl).toBe('wss://relay.example.com');
  });

  it('falls back to defaults when the stored value is unusable', () => {
    expect(parseStoredConfig('not json', defaults)).toEqual(defaults);
    expect(parseStoredConfig('null', defaults)).toEqual(defaults);
    expect(parseStoredConfig('"a string"', defaults)).toEqual(defaults);
    expect(parseStoredConfig('[1,2]', defaults)).toEqual(defaults);
  });
});
