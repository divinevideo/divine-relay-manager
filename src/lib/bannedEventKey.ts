// ABOUTME: Cache keys for getbannedevent reads and invalidation in the report pane.
// ABOUTME: Scoped to the worker URL so pending actions only refresh their own environment.

export const bannedEventQueryPrefix = (apiUrl: string) => ['banned-event', apiUrl] as const;
export const bannedEventQueryKey = (apiUrl: string, eventId: string | undefined) =>
  [...bannedEventQueryPrefix(apiUrl), eventId] as const;
