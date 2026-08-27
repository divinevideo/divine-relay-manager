import { describe, it, expect } from 'vitest';
import { linkedTicketTarget } from './linkedTicketTarget';

const EVENT = 'e'.repeat(64);
const AUTHOR = 'a'.repeat(64);

describe('linkedTicketTarget', () => {
  it('event-scoped report looks up only the event, never the author', () => {
    expect(linkedTicketTarget({ type: 'event', value: EVENT }, AUTHOR)).toEqual({
      eventId: EVENT,
      pubkey: undefined,
    });
  });

  it('pubkey-scoped report looks up the author', () => {
    expect(linkedTicketTarget({ type: 'pubkey', value: AUTHOR }, AUTHOR)).toEqual({
      eventId: undefined,
      pubkey: AUTHOR,
    });
  });

  it('coalesces a null reported pubkey to undefined', () => {
    expect(linkedTicketTarget({ type: 'pubkey', value: AUTHOR }, null)).toEqual({
      eventId: undefined,
      pubkey: undefined,
    });
  });

  it('returns neither when there is no target', () => {
    expect(linkedTicketTarget(null, AUTHOR)).toEqual({ eventId: undefined, pubkey: undefined });
  });
});
