import { afterEach, describe, expect, it, vi } from 'vitest';
import { coordinateEventVisibility } from './event-visibility';

const operation = {
  eventId: 'ab'.repeat(32),
  relayAction: 'hide' as const,
  humanAction: 'hide_event',
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('coordinateEventVisibility', () => {
  it('returns a structured error when the binding is unavailable', async () => {
    await expect(coordinateEventVisibility({}, operation)).resolves.toEqual({
      success: false,
      error: 'Event visibility coordinator not configured',
    });
  });

  it.each([
    async () => { throw new Error('stub unavailable'); },
    async () => new Response('not json', { status: 502 }),
  ])('converts coordinator transport failures into structured errors', async (fetch) => {
    const env = {
      REPORT_WATCHER: {
        idFromName: () => 'singleton',
        get: () => ({ fetch }),
      },
    } as never;

    const result = await coordinateEventVisibility(env, operation);

    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('bounds time waiting for the coordinator gate', async () => {
    const signal = new AbortController().signal;
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(signal);
    let requestSignal: AbortSignal | null = null;
    const env = {
      REPORT_WATCHER: {
        idFromName: () => 'singleton',
        get: () => ({
          fetch: async (request: Request) => {
            requestSignal = request.signal;
            return Response.json({ success: true });
          },
        }),
      },
    } as never;

    await coordinateEventVisibility(env, operation);

    expect(timeoutSpy).toHaveBeenCalledWith(90_000);
    expect(requestSignal).not.toBeNull();
  });
});
