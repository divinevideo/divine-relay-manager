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
  quarantineReleased?: boolean;
  remainingRestrictions?: boolean;
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

/** A scoped release must never claim that independent restrictions were lifted. */
export function quarantineRestoreResult(c: import('../../shared/sexual-quarantine').SexualCase | undefined): EventVisibilityResult {
  const quarantineReleased = !!c && c.goal === 'restore' && ['restored', 'restored_restricted'].includes(c.state);
  const recorded = quarantineReleased && !!c?.decisionRecordedAt;
  if (recorded && c?.state === 'restored_restricted') return {
    success: false, recorded: true, conflict: true, quarantineReleased: true, remainingRestrictions: true,
    error: 'Quarantine released; other restrictions still prevent public visibility',
  };
  return { success: recorded && c?.state === 'restored', recorded, quarantineReleased,
    ...(!recorded && { error: 'Decision saved; enforcement verification or Reports recording is pending' }) };
}
