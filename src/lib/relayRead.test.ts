import { describe, it, expect } from 'vitest';
import { assertRelayReadCompleted, isDefinitiveRpcNegative } from './relayRead';
import { ApiError } from './adminApi';

function aborted(): AbortSignal {
  const c = new AbortController();
  c.abort();
  return c.signal;
}
const live = () => new AbortController().signal;

describe('assertRelayReadCompleted', () => {
  it('throws when our timeout fired, so an empty result is not read as absence', () => {
    expect(() => assertRelayReadCompleted(aborted(), live())).toThrow(/timed out/i);
  });

  it('does not throw when the read completed normally', () => {
    expect(() => assertRelayReadCompleted(live(), live())).not.toThrow();
  });

  it('stays silent when the query itself was cancelled', () => {
    // Unmount or key change aborts TanStack's signal; that is not a failure to
    // report, and throwing would surface a spurious error to the moderator.
    expect(() => assertRelayReadCompleted(aborted(), aborted())).not.toThrow();
  });
});

describe('isDefinitiveRpcNegative', () => {
  it('accepts the relay answering "not banned" (no HTTP status)', () => {
    expect(isDefinitiveRpcNegative(new ApiError('Event not found or not banned'))).toBe(true);
  });

  it('rejects a transport or auth failure, which must not read as a negative', () => {
    expect(isDefinitiveRpcNegative(new ApiError('Forbidden', 403, 'Forbidden'))).toBe(false);
    expect(isDefinitiveRpcNegative(new ApiError('Internal Server Error', 500, 'ISE'))).toBe(false);
  });

  it('rejects an unrecognised relay-side failure rather than assuming a negative', () => {
    expect(isDefinitiveRpcNegative(new ApiError('database unavailable'))).toBe(false);
  });

  it('rejects non-ApiError failures (network, abort)', () => {
    expect(isDefinitiveRpcNegative(new Error('Failed to fetch'))).toBe(false);
    expect(isDefinitiveRpcNegative(undefined)).toBe(false);
  });
});
