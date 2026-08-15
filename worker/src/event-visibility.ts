export type EventRelayAction = 'hide' | 'allow';

export interface EventVisibilityOperation {
  eventId: string;
  relayAction: EventRelayAction;
  reason?: string;
  humanAction?: string;
}

export interface EventVisibilityResult {
  success: boolean;
  error?: string;
  recorded?: boolean;
}

export interface EventVisibilityCoordinatorEnv {
  REPORT_WATCHER?: DurableObjectNamespace;
}

export async function coordinateEventVisibility(
  env: EventVisibilityCoordinatorEnv,
  operation: EventVisibilityOperation,
): Promise<EventVisibilityResult> {
  if (!env.REPORT_WATCHER) {
    return { success: false, error: 'Event visibility coordinator not configured' };
  }

  const stub = env.REPORT_WATCHER.get(env.REPORT_WATCHER.idFromName('singleton'));
  const response = await stub.fetch(new Request('https://do/event-visibility', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(operation),
  }));
  const result = await response.json<EventVisibilityResult>();
  return response.ok ? result : { success: false, error: result.error || `Coordinator failed (${response.status})` };
}
