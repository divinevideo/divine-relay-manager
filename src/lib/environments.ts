// ABOUTME: Environment definitions for relay/worker pairs
// ABOUTME: Enables switching between staging and production from a single frontend
// ABOUTME: URLs are loaded from environment variables (VITE_*) to avoid committing domains

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
 * Build environments array from environment variables.
 * Only includes environments where both URLs are configured.
 * URLs are set via VITE_* env vars to avoid committing domains.
 */
function buildEnvironments(): Environment[] {
  const envs: Environment[] = [];

  // Production
  if (import.meta.env.VITE_PROD_RELAY_URL && import.meta.env.VITE_PROD_API_URL) {
    envs.push({
      id: 'production',
      name: 'Production',
      relayUrl: import.meta.env.VITE_PROD_RELAY_URL,
      apiUrl: import.meta.env.VITE_PROD_API_URL,
    });
  }

  // Staging
  if (import.meta.env.VITE_STAGING_RELAY_URL && import.meta.env.VITE_STAGING_API_URL) {
    envs.push({
      id: 'staging',
      name: 'Staging',
      relayUrl: import.meta.env.VITE_STAGING_RELAY_URL,
      apiUrl: import.meta.env.VITE_STAGING_API_URL,
    });
  }

  // Local (dev only)
  if (import.meta.env.VITE_LOCAL_RELAY_URL && import.meta.env.VITE_LOCAL_API_URL) {
    envs.push({
      id: 'local',
      name: 'Local',
      relayUrl: import.meta.env.VITE_LOCAL_RELAY_URL,
      apiUrl: import.meta.env.VITE_LOCAL_API_URL,
    });
  }

  return envs;
}

/**
 * Available environments for moderation.
 * Each environment pairs a relay with its corresponding worker,
 * ensuring moderation actions always go to the correct backend.
 */
export const environments: Environment[] = buildEnvironments();

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
