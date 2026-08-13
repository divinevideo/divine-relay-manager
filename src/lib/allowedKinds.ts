// ABOUTME: Normalizes the relay's `listallowedkinds` NIP-86 response into a flat number[].
// ABOUTME: Funnelcake returns Array<{kind, added_at}>; older relays returned bare number[].

/** A single entry from the relay's `listallowedkinds` response, either shape. */
export type AllowedKindEntry = number | { kind: number; added_at?: string };

/**
 * The relay's `listallowedkinds` response drifted from its original contract:
 * funnelcake returns objects (`{kind, added_at}`), while the code assumed bare
 * numbers. Rendering an object directly as a React child throws React #31
 * ("Objects are not valid as a React child") and takes down the whole Settings
 * tab, so collapse both shapes to a plain number[] and drop anything that does
 * not carry a finite numeric kind.
 */
export function normalizeAllowedKinds(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry): number | undefined => {
      if (typeof entry === 'number') return entry;
      if (
        entry &&
        typeof entry === 'object' &&
        typeof (entry as { kind?: unknown }).kind === 'number'
      ) {
        return (entry as { kind: number }).kind;
      }
      return undefined;
    })
    .filter((kind): kind is number => typeof kind === 'number' && Number.isFinite(kind));
}
