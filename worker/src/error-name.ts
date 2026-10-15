// ABOUTME: Describes a caught error by its name only, for logs near secret values
// ABOUTME: Used where the error message may repeat a secret, such as a webhook URL

/**
 * The error's name, without its message, stack or cause.
 *
 * Use when the failing call took a secret value as input. The Workers runtime
 * rejects a fetch to a malformed URL with `TypeError: Invalid URL: <the url>`,
 * so logging that error would repeat a webhook URL that is itself a credential.
 */
export function errorNameOnly(error: unknown): string {
  return error instanceof Error ? error.name : 'non-Error value';
}
