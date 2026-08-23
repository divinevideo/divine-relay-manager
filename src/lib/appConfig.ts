// ABOUTME: Reconciles the persisted app config in localStorage against the current defaults.
// ABOUTME: Keeps the relay and its worker together, so a partial config can never straddle two environments.

import type { AppConfig } from '@/contexts/AppContext';
import { getEnvironmentByRelayUrl } from '@/lib/environments';

/**
 * Parses a persisted AppConfig, filling in anything the stored copy is missing.
 *
 * `useLocalStorage` only applies its default when nothing is stored at all, so a
 * config written before a field was introduced keeps that field undefined for as
 * long as the browser holds it. No current write path produces that shape under
 * `nostr:app-config-v2` — this is forward-compatibility hardening for the next
 * field added to `AppConfig`, not a repair for a config in the wild.
 *
 * `relayUrl` and `apiUrl` are resolved as a pair. Backfilling them independently
 * could pin a staging relay to the production API, which would show staging
 * content while executing moderation actions against production.
 *
 * Malformed JSON is re-thrown so `useLocalStorage` handles it the way it always
 * has: ignored on a cross-tab `storage` event, defaulted on init.
 */
export function parseStoredConfig(raw: string, defaults: AppConfig): AppConfig {
  const parsed: unknown = JSON.parse(raw);

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ...defaults };
  }

  const stored = parsed as Partial<AppConfig>;
  const { relayUrl, apiUrl } = resolveEndpointPair(stored, defaults);

  return { ...defaults, ...stored, relayUrl, apiUrl };
}

/**
 * Picks a coherent relay/API pair from a possibly incomplete stored config.
 *
 * A complete pair is taken as-is, including custom relays the environment list
 * does not know about. When one half is missing, a known environment matching
 * the stored relay supplies the other half; otherwise both come from defaults.
 */
function resolveEndpointPair(
  stored: Partial<AppConfig>,
  defaults: AppConfig,
): Pick<AppConfig, 'relayUrl' | 'apiUrl'> {
  const relayUrl = stored.relayUrl || '';
  const apiUrl = stored.apiUrl || '';

  if (relayUrl && apiUrl) {
    return { relayUrl, apiUrl };
  }

  const environment = relayUrl ? getEnvironmentByRelayUrl(relayUrl) : undefined;
  if (environment) {
    return { relayUrl: environment.relayUrl, apiUrl: environment.apiUrl };
  }

  return { relayUrl: defaults.relayUrl, apiUrl: defaults.apiUrl };
}
