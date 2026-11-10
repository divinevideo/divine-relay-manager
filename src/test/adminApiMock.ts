// ABOUTME: Gives a mocked useAdminApi object an asModerator(token) like the real
// ABOUTME: hook's, recording which token each call made through it carried.
import { vi } from 'vitest';

type ApiDouble = Record<string, unknown>;

/**
 * Adds `asModerator` to a mocked api object. The scoped api it returns calls
 * the same doubles, so `expect(api.logDecision).toHaveBeenCalledWith(...)` still
 * works, and records each call in `moderatorCall` (a vi.fn, so clearAllMocks
 * resets it) as `(fn, token, args)`. A call made through the plain api is not
 * recorded, so a test can tell an attributed call from an unattributed one.
 * Every call made through the scoped api is recorded, including the read api's
 * moderateMedia and deleteMedia (writes the worker does not attribute), but the
 * real hook sends the login only with the calls in useAdminApi's
 * buildAttributionApi. Assert tokens for those calls only.
 */
export function withAsModerator<T extends ApiDouble>(api: T) {
  const moderatorCall = vi.fn<(fn: string, token: string | undefined, args: unknown[]) => void>();
  const asModerator = vi.fn((token: string | undefined) =>
    new Proxy(api, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof prop !== 'string' || typeof value !== 'function' || prop === 'asModerator') return value;
        return (...args: unknown[]) => {
          moderatorCall(prop, token, args);
          return (value as (...a: unknown[]) => unknown)(...args);
        };
      },
    }),
  );
  return Object.assign(api, { asModerator, moderatorCall });
}

/** The tokens the calls to `fn` made through asModerator carried, in order. */
export function tokensFor(
  api: { moderatorCall: { mock: { calls: Array<[string, string | undefined, unknown[]]> } } },
  fn: string,
): Array<string | undefined> {
  return api.moderatorCall.mock.calls.filter(([name]) => name === fn).map(([, token]) => token);
}
