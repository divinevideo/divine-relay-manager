// ABOUTME: String-first checks for 64-character hex ids, event ids and pubkeys alike.
// ABOUTME: A bare RegExp.test coerces its argument, so an array holding a valid id passes it.

// A 64-character hex id in either case, as the API accepts one from a client.
export function isHex64(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
}

// The same in lowercase only, the form ids are stored and compared in.
// ReportWatcher holds its callers to it: the worker lowercases ids before
// handing them over, and an uppercase event id would key a row nobody reads.
export function isLowerHex64(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}
