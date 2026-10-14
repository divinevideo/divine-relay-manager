// Test-only: checks that a configured secret value does not reappear in an
// error or a log line. Not imported by the worker itself.

// The text an error or log argument can carry: message, stack and cause for an
// Error, the value itself for a string, JSON for anything else.
function surfacesOf(value: unknown, depth = 0): string[] {
  if (value === undefined || value === null) return [];
  if (typeof value === 'string') return [value];
  if (value instanceof Error) {
    const surfaces = [value.message, value.stack ?? ''];
    if (depth < 3) surfaces.push(...surfacesOf(value.cause, depth + 1));
    return surfaces;
  }
  try {
    return [JSON.stringify(value) ?? String(value)];
  } catch {
    return [String(value)];
  }
}

// Every 8-character window of `secret` that appears in any of `values`.
// Expected to be empty.
export function echoedFragments(values: unknown[], secret: string): string[] {
  const surfaces = values.flatMap((value) => surfacesOf(value));
  const fragments: string[] = [];
  for (let i = 0; i + 8 <= secret.length; i++) {
    const fragment = secret.slice(i, i + 8);
    if (surfaces.some((s) => s.includes(fragment))) fragments.push(fragment);
  }
  return fragments;
}
