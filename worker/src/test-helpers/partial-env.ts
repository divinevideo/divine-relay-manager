// Test-only: a worker env that binds only some of its fields on purpose.
// Not imported by the worker itself.
//
// Many D1 tests pass just `{ DB }`. NOSTR_NSEC and RELAY_URL are required in
// the production env types, but those tests leave them unset on purpose: with
// no relay URL the identity lookup returns "not completed" without a request,
// and the relay and enforcement legs fail or are skipped, so the test
// exercises the D1 behaviour it is about. Filling them with placeholders would
// change which code paths run.
//
// Prefer this to `as never` or `as unknown as`: the bindings are still checked
// against the env type (a misspelled or mistyped binding is a type error), and
// the call site says the env is incomplete by design.
export function partialEnv<E extends object>(bindings: Partial<E>): E {
  return bindings as E;
}
