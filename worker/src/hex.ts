// ABOUTME: String-first checks for 64-character hex ids, event ids and pubkeys alike.
// ABOUTME: A bare RegExp.test coerces its argument, so an array holding a valid id passes it.

// A 64-character hex id in either case, as the API accepts one from a client.
export function isHex64(value: unknown): boolean {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
}

// The same in lowercase only, the form ids are stored and compared in.
// ReportWatcher holds its callers to it, since an uppercase event id would key
// a row nobody reads. Every route hands it lowercase ids, lowercasing them or
// forwarding only lowercase ones, except /api/publish: it lowercases a
// resolution label's hex target first, but a non-hex one (TODO(#160)) still
// goes over as sent and gets a 400 from ReportWatcher.
export function isLowerHex64(value: unknown): boolean {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}
