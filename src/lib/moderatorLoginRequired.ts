// ABOUTME: The worker's refusal of a write that carries no verified Divine login,
// ABOUTME: and the app-wide signal that tells the sign-in prompt to show.
//
// With REQUIRE_MODERATOR_LOGIN on, the worker answers such a write with 401 and
// this code (worker/src/moderator-identity.ts). Matched on the code, never on
// the message, so rewording the worker's error cannot break it.
const MODERATOR_LOGIN_REQUIRED = 'moderator_login_required';

export const MODERATOR_LOGIN_REQUIRED_MESSAGE = 'You need to be signed in with Divine to do this.';

export function isModeratorLoginRequired(code: unknown): boolean {
  return code === MODERATOR_LOGIN_REQUIRED;
}

// A plain listener set rather than React state: the refusal is seen in the API
// client, outside any component, and the one prompt (LoginRequiredPrompt) is
// mounted once at the app root.
type Listener = () => void;
const listeners = new Set<Listener>();

export function subscribeModeratorLoginRequired(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function announceModeratorLoginRequired(): void {
  for (const listener of listeners) listener();
}

/**
 * Handles a failed response's error code. When it is moderator_login_required,
 * raises the app's sign-in prompt if `prompt` is set (callers pass it for a
 * write) and returns the plain message to show in place of the worker's;
 * otherwise does nothing and returns undefined. A read passes `prompt: false`:
 * the one read the worker refuses this way (a suspended author's snapshot)
 * says so on its own screen. Every write path that reads an error code calls
 * this, so a refused action reads the same wherever its screen shows the error.
 */
export function handleLoginRefusal(code: unknown, { prompt }: { prompt: boolean }): string | undefined {
  if (!isModeratorLoginRequired(code)) return undefined;
  if (prompt) announceModeratorLoginRequired();
  return MODERATOR_LOGIN_REQUIRED_MESSAGE;
}
