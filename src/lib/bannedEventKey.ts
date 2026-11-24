// ABOUTME: Query key for one event's getbannedevent read (useBannedEvent), shared with the pane that drops it.
// ABOUTME: Its own module: the many ReportDetail tests that mock the hook would otherwise lose these exports.

export const BANNED_EVENT_KEY_ROOT = 'banned-event';
/** One event's banned-event read. No environment part: the cache is cleared on a switch. */
export const bannedEventQueryKey = (eventId: string | undefined) => [BANNED_EVENT_KEY_ROOT, eventId] as const;
