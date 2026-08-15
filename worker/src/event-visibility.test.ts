import { describe, expect, it } from 'vitest';
import { coordinateEventVisibility } from './event-visibility';

const operation = {
  eventId: 'ab'.repeat(32),
  relayAction: 'hide' as const,
  humanAction: 'hide_event',
};

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

  it('preserves partial-success fields from coordinator errors', async () => {
    const env = {
      REPORT_WATCHER: {
        idFromName: () => 'singleton',
        get: () => ({
          fetch: async () => Response.json(
            { success: false, error: 'restore failed', recorded: true },
            { status: 502 },
          ),
        }),
      },
    } as never;

    await expect(coordinateEventVisibility(env, operation)).resolves.toEqual({
      success: false,
      error: 'restore failed',
      recorded: true,
    });
  });
});
