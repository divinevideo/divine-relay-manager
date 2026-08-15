export type EventVisibilityAction = 'hide' | 'allow' | 'review' | 'confirm';

export interface EventVisibilityOperation {
  eventId: string;
  relayAction: EventVisibilityAction;
  reason?: string;
  humanAction?: string;
  reportId?: string;
  reporterPubkey?: string;
  moderatorPubkey?: string;
}

export interface EventVisibilityResult {
  success: boolean;
  error?: string;
  recorded?: boolean;
  conflict?: boolean;
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

  try {
    const stub = env.REPORT_WATCHER.get(env.REPORT_WATCHER.idFromName('singleton'));
    const response = await stub.fetch(new Request('https://do/event-visibility', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(operation),
    }));
    const result = await response.json<EventVisibilityResult>();
    return response.ok
      ? result
      : { ...result, success: false, error: result.error || `Coordinator failed (${response.status})` };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Event visibility coordinator failed',
    };
  }
}
