// ABOUTME: Environment definitions for relay/worker pairs
// ABOUTME: Enables switching between staging and production from a single frontend

export interface Environment {
  /** Unique identifier for the environment */
  id: string;
  /** Display name shown in the UI */
  name: string;
  /** WebSocket URL of the Nostr relay */
  relayUrl: string;
  /** HTTP URL of the admin API worker */
  apiUrl: string;
}

/**
 * Available environments for moderation.
 * Each environment pairs a relay with its corresponding worker,
 * ensuring moderation actions always go to the correct backend.
 */
export const environments: Environment[] = [
  {
    id: 'production',
    name: 'Production',
    relayUrl: 'wss://relay.dvines.org',
    apiUrl: 'https://api-relay-prod.divine.video',
  },
  {
    id: 'staging',
    name: 'Staging',
    relayUrl: 'wss://relay.divine.video',
    apiUrl: 'https://api-relay.divine.video',
  },
];

/**
 * Get an environment by its ID.
 */
export function getEnvironmentById(id: string): Environment | undefined {
  return environments.find(e => e.id === id);
}

/**
 * Get an environment by its relay URL.
 */
export function getEnvironmentByRelayUrl(relayUrl: string): Environment | undefined {
  return environments.find(e => e.relayUrl === relayUrl);
}

/**
 * Get an environment by its API URL.
 */
export function getEnvironmentByApiUrl(apiUrl: string): Environment | undefined {
  return environments.find(e => e.apiUrl === apiUrl);
}

/**
 * Get the current environment based on config values.
 * Returns undefined if the config doesn't match any known environment.
 */
export function getCurrentEnvironment(relayUrl: string, apiUrl: string): Environment | undefined {
  return environments.find(e => e.relayUrl === relayUrl && e.apiUrl === apiUrl);
}

/**
 * Default environment (production — canonical relay for moderation)
 */
export const defaultEnvironment = environments.find(e => e.id === 'production') || environments[0];
