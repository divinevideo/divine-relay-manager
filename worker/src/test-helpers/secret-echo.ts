// Test-only: checks that a configured secret value does not reappear in an
// error or a log line, plus shared fixtures for those checks. Not imported by
// the worker itself.
//
// Scope: echoedFragments looks in strings; Errors (message, stack, cause and
// own properties, such as an AggregateError's errors); iterables (arrays,
// Headers, Map, Set); the keys and values of plain objects; and objects that
// expose state through prototype getters (Request, Response, URL). It is a
// regression net for the shapes the worker logs, not proof that no
// serialization of a value could ever contain the secret.
import { vi } from 'vitest';

// A malformed webhook URL (no scheme), as a misconfigured secret would be.
// Synthetic: not a real webhook.
export const MALFORMED_WEBHOOK = 'hooks.example.test/services/T0SYNTHETIC/B0SYNTHETIC/synthetic-webhook-token';

// The Workers runtime rejects a fetch to a malformed URL with
// `TypeError: Invalid URL: <the url>` and no cause. This fake gives the same
// message and also adds a cause carrying the URL, so a check has to look past
// the message to pass.
export function rejectLikeWorkersRuntime() {
  return vi.fn(async (url: string) => {
    throw new TypeError(`Invalid URL: ${url}`, { cause: { input: url } });
  });
}

// Collects every string reachable from `value` (see Scope above). Skips any
// object it has already visited, so cyclic values terminate.
function collectSurfaces(value: unknown, seen: Set<object>, out: string[]): void {
  if (value === undefined || value === null) return;
  if (typeof value === 'string') {
    out.push(value);
    return;
  }
  if (typeof value !== 'object' && typeof value !== 'function') {
    out.push(String(value));
    return;
  }
  if (seen.has(value)) return;
  seen.add(value);

  if (value instanceof Error) {
    // Own properties, enumerable or not: message, stack and cause (all own in
    // V8), and others such as an AggregateError's errors.
    for (const name of Object.getOwnPropertyNames(value)) {
      collectSurfaces((value as unknown as Record<string, unknown>)[name], seen, out);
    }
  }
  // Iterables (arrays, Headers, Map, Set, ...) hold their content in entries,
  // not in own properties: Object.values(new Headers(...)) is []. Map and
  // Headers entries are [key, value] arrays, walked in turn.
  const iterator = (value as { [Symbol.iterator]?: unknown })[Symbol.iterator];
  if (typeof iterator === 'function') {
    for (const child of value as Iterable<unknown>) collectSurfaces(child, seen, out);
  }
  if (!Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) {
      out.push(key);
      collectSurfaces(child, seen, out);
    }
  }
  // Platform objects (Request, Response, URL) keep their state behind
  // prototype getters, which console prints but Object.entries skips.
  for (let proto = Object.getPrototypeOf(value); proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
    for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(proto))) {
      if (!descriptor.get) continue;
      let child: unknown;
      try {
        child = (value as Record<string, unknown>)[name];
      } catch {
        continue;
      }
      collectSurfaces(child, seen, out);
    }
  }
}

// Every 8-character window of `secret` that appears in any of `values`.
// Expected to be empty.
export function echoedFragments(values: unknown[], secret: string): string[] {
  const surfaces: string[] = [];
  const seen = new Set<object>();
  for (const value of values) collectSurfaces(value, seen, surfaces);
  const fragments: string[] = [];
  for (let i = 0; i + 8 <= secret.length; i++) {
    const fragment = secret.slice(i, i + 8);
    if (surfaces.some((s) => s.includes(fragment))) fragments.push(fragment);
  }
  return fragments;
}
