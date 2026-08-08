// ABOUTME: Reconciles the persisted app config in localStorage against the current defaults.
// ABOUTME: A config saved before a field existed must not leave the app with no API to talk to.

import type { AppConfig } from '@/contexts/AppContext';

/**
 * Parses a persisted AppConfig, backfilling anything the stored copy is missing.
 *
 * `useLocalStorage` only applies its default when nothing is stored at all, so a
 * config written before a field was introduced keeps that field undefined for as
 * long as the browser holds it. For `apiUrl` that means every worker request
 * throws "No relay selected" — permanently, and only for the people who have
 * used the tool the longest.
 */
export function parseStoredConfig(raw: string, defaults: AppConfig): AppConfig {
  let stored: Partial<AppConfig>;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ...defaults };
    }
    stored = parsed as Partial<AppConfig>;
  } catch {
    return { ...defaults };
  }

  return {
    ...defaults,
    ...stored,
    // Empty is as unusable as absent: a failed environment switch can leave
    // these blank, and blank reads back as "no environment selected".
    relayUrl: stored.relayUrl || defaults.relayUrl,
    apiUrl: stored.apiUrl || defaults.apiUrl,
  };
}
