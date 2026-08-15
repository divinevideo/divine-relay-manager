// ABOUTME: Durable Object for watching NIP-56 content reports (kind 1984)
// ABOUTME: Maintains persistent WebSocket to relay for auto-hide functionality

import { callNip86Rpc, type Nip86Env } from './nip86';
import { ensureSchema } from './db';
import type { EventVisibilityOperation, EventVisibilityResult } from './event-visibility';
import { markHumanAction, markHumanReviewed } from './human-decision';
import {
  AUTO_HIDE_ACTION,
  AUTO_HIDE_TIER_KINDS,
  isImmediateAutoHideTier,
  isThresholdAutoHideTier,
  type AutoHideConfig,
  type AutoHideTier,
} from '../../shared/autohide';
import {
  AGE_REVIEW_ACTION,
  DEADLINE_DAYS,
  TERMINAL_STATES,
  defaultResolutionForBand,
} from '../../shared/age-review';
import { getUserStatus, type KeycastEnv } from './keycast-client';
import { fetchAccountIdentity } from './relay-profile';

const UNRESOLVED_AUTO_HIDE_VISIBILITY = 'unresolved-hide';
const UNRESOLVED_HUMAN_HIDE_VISIBILITY = 'hide-unresolved';

/**
 * Extended environment for ReportWatcher DO
 */
export interface ReportWatcherEnv extends Nip86Env, KeycastEnv {
  DB?: D1Database;
  AUTO_HIDE_ENABLED?: string;
  TRUSTED_CLIENTS?: string;
}

export async function hasLatestHumanRestore(db: D1Database, targetEventId: string): Promise<boolean> {
  const row = await db.prepare(`
    SELECT 1 FROM moderation_targets
    WHERE target_id = ?
      AND ever_human_reviewed = 1
      AND last_human_action IN (
        'allow_event',
        'restore_event',
        'auto_hide_restored'
      )
  `).bind(targetEventId).first();
  return row !== null;
}

async function getAutoHideState(db: D1Database, targetEventId: string): Promise<{
  last_human_action: string | null;
  auto_hide_action: string | null;
} | null> {
  return db.prepare(`
    SELECT
      (SELECT last_human_action FROM moderation_targets WHERE target_id = ?) AS last_human_action,
      (SELECT action FROM moderation_decisions
       WHERE target_type = 'event' AND target_id = ?
         AND action IN (?, ?, ?, ?)
       ORDER BY id DESC LIMIT 1) AS auto_hide_action
  `).bind(
    targetEventId,
    targetEventId,
    AUTO_HIDE_ACTION.hidden,
    AUTO_HIDE_ACTION.reversed,
    AUTO_HIDE_ACTION.restored,
    AUTO_HIDE_ACTION.confirmed,
  ).first<{ last_human_action: string | null; auto_hide_action: string | null }>();
}

export async function hasActiveAutoHide(db: D1Database, targetEventId: string): Promise<boolean> {
  const row = await getAutoHideState(db, targetEventId);
  return row?.auto_hide_action === AUTO_HIDE_ACTION.hidden
    && row.last_human_action === null;
}

async function canConfirmAutoHide(db: D1Database, targetEventId: string): Promise<boolean> {
  const row = await getAutoHideState(db, targetEventId);
  return row?.auto_hide_action === AUTO_HIDE_ACTION.hidden
    && (row.last_human_action === null || ['hide_event', 'delete_event'].includes(row.last_human_action));
}

/**
 * Status of the ReportWatcher
 */
export interface ReportWatcherStatus {
  running: boolean;
  connected: boolean;
  connectedAt: number | null;
  lastEventAt: number | null;
  eventsProcessed: number;
  eventsAutoHidden: number;
  autoHideEnabled: boolean;
  reconnectAttempts: number;
}

/**
 * NIP-56 Report event structure (kind 1984)
 */
export interface ReportEvent {
  id: string;
  pubkey: string;  // Reporter's pubkey
  kind: 1984;
  content: string;
  tags: string[][];
  created_at: number;
}
export type { AutoHideConfig, AutoHideTier } from '../../shared/autohide';

type StoredAutoHideTier = Omit<AutoHideTier, 'kind'> & { kind?: string };
type StoredAutoHideConfig = Omit<AutoHideConfig, 'tiers'> & { tiers: StoredAutoHideTier[] };

const DEFAULT_IMMEDIATE_CATEGORIES = ['sexual_minors', 'csam', 'NS-csam'];
const DEFAULT_THRESHOLD_CATEGORIES = ['NS-sexualContent', 'NS-sexual-content', 'NS-violence', 'NS-extremism'];

// Reconnection settings
const INITIAL_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 60000;
const RECONNECT_BACKOFF_MULTIPLIER = 2;

// Alarm interval for connection health checks
const HEALTH_CHECK_INTERVAL_MS = 30000;

/**
 * ReportWatcher Durable Object
 *
 * Maintains a persistent WebSocket connection to the relay and subscribes
 * to kind 1984 (NIP-56 content reports). When a report with a trusted
 * category (e.g., sexual_minors) is received, it automatically hides
 * the content using NIP-86 banevent RPC.
 */
export class ReportWatcher implements DurableObject {
  private state: DurableObjectState;
  private env: ReportWatcherEnv;

  // Runtime state (not persisted across restarts)
  private schemaReady: boolean = false;
  private running: boolean = false;
  private ws: WebSocket | null = null;
  private connectedAt: number | null = null;
  private lastEventAt: number | null = null;
  private eventsProcessed: number = 0;
  private eventsAutoHidden: number = 0;
  private reconnectAttempts: number = 0;
  private reconnectDelay: number = INITIAL_RECONNECT_DELAY_MS;
  private subscriptionId: string = 'auto-hide-reports';
  private autoHideConfig: AutoHideConfig | null = null;
  private pendingAgeReviewPubkeys = new Set<string>();

  constructor(state: DurableObjectState, env: ReportWatcherEnv) {
    this.state = state;
    this.env = env;

    // Restore persisted state on construction
    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get<{
        running: boolean;
        eventsProcessed: number;
        eventsAutoHidden: number;
      }>('watcherState');

      if (stored) {
        this.running = stored.running;
        this.eventsProcessed = stored.eventsProcessed;
        this.eventsAutoHidden = stored.eventsAutoHidden || 0;

        if (this.running) {
          console.log('[ReportWatcher] Restoring connection after restart');
          this.connect();
        }
      }

      // Load or seed auto-hide config.
      // Older stored configs predate tier.kind and need to be normalized forward.
      const storedConfig = await this.state.storage.get<StoredAutoHideConfig>('autoHideConfig') ?? null;
      if (!storedConfig) {
        this.autoHideConfig = this.buildDefaultConfig();
        await this.state.storage.put('autoHideConfig', this.autoHideConfig);
        console.log('[ReportWatcher] Seeded default auto-hide config');
      } else {
        const { config, changed } = this.normalizeStoredConfig(storedConfig);
        this.autoHideConfig = config;
        if (changed) {
          await this.state.storage.put('autoHideConfig', config);
          console.log('[ReportWatcher] Migrated stored auto-hide config');
        }
      }
    });
  }

  /**
   * Handle HTTP requests to the Durable Object
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === '/start' && request.method === 'POST') {
        return this.handleStart();
      }

      if (path === '/stop' && request.method === 'POST') {
        return this.handleStop();
      }

      if (path === '/status' && request.method === 'GET') {
        return this.handleStatus();
      }

      if (path === '/config' && request.method === 'GET') {
        return this.handleGetConfig();
      }

      if (path === '/config' && request.method === 'PUT') {
        return this.handlePutConfig(request);
      }

      if (path === '/event-visibility' && request.method === 'POST') {
        return this.handleEventVisibility(request);
      }

      return new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      console.error('[ReportWatcher] Error handling request:', error);
      return new Response(JSON.stringify({
        error: error instanceof Error ? error.message : 'Unknown error'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  /**
   * Start watching for reports
   */
  private async handleStart(): Promise<Response> {
    if (this.running) {
      return new Response(JSON.stringify({
        success: true,
        message: 'Already running',
        status: this.getStatus(),
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    this.running = true;

    // Persist state
    await this.persistState();

    // Start WebSocket connection
    this.connect();

    // Schedule health check alarm
    await this.scheduleHealthCheck();

    console.log('[ReportWatcher] Started');

    return new Response(JSON.stringify({
      success: true,
      message: 'Started',
      status: this.getStatus(),
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  /**
   * Stop watching for reports
   */
  private async handleStop(): Promise<Response> {
    if (!this.running) {
      return new Response(JSON.stringify({
        success: true,
        message: 'Already stopped',
        status: this.getStatus(),
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    this.running = false;
    this.disconnect();

    // Persist state
    await this.persistState();

    console.log('[ReportWatcher] Stopped');

    return new Response(JSON.stringify({
      success: true,
      message: 'Stopped',
      status: this.getStatus(),
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  /**
   * Get current status
   */
  private handleStatus(): Response {
    return new Response(JSON.stringify({
      success: true,
      status: this.getStatus(),
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private handleGetConfig(): Response {
    return new Response(JSON.stringify({
      success: true,
      config: this.autoHideConfig,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handlePutConfig(request: Request): Promise<Response> {
    let config: AutoHideConfig;
    try {
      config = await request.json() as AutoHideConfig;
    } catch {
      return new Response(JSON.stringify({ success: false, error: 'Invalid JSON body' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const validationError = this.validateConfig(config);
    if (validationError) {
      return new Response(JSON.stringify({ success: false, error: validationError }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    this.autoHideConfig = config;
    await this.state.storage.put('autoHideConfig', config);
    console.log('[ReportWatcher] Auto-hide config updated');

    return new Response(JSON.stringify({
      success: true,
      config: this.autoHideConfig,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleEventVisibility(request: Request): Promise<Response> {
    let operation: EventVisibilityOperation;
    try {
      operation = await request.json<EventVisibilityOperation>();
    } catch {
      return Response.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
    }

    if (
      !/^[0-9a-f]{64}$/.test(operation.eventId)
      || !['hide', 'allow', 'review', 'confirm'].includes(operation.relayAction)
      || (operation.reason !== undefined && typeof operation.reason !== 'string')
      || (operation.humanAction !== undefined && typeof operation.humanAction !== 'string')
      || (operation.moderatorPubkey !== undefined && !/^[0-9a-f]{64}$/.test(operation.moderatorPubkey))
      || (operation.reportId !== undefined && !/^[0-9a-f]{64}$/.test(operation.reportId))
      || (operation.reporterPubkey !== undefined && !/^[0-9a-f]{64}$/.test(operation.reporterPubkey))
      || (operation.relayAction === 'review' && !operation.humanAction)
    ) {
      return Response.json({ success: false, error: 'Invalid event visibility operation' }, { status: 400 });
    }

    const result = await this.state.blockConcurrencyWhile(async (): Promise<EventVisibilityResult> => {
      try {
        if (this.env.DB && !this.schemaReady) {
          await ensureSchema(this.env.DB);
          this.schemaReady = true;
        }

        let relayFailure: EventVisibilityResult | undefined;
        if (operation.relayAction === 'confirm') {
          if (!this.env.DB) return { success: false, recorded: false, error: 'Moderation database is not configured' };
          const visibilityKey = this.visibilityStorageKey(operation.eventId);
          const visibility = await this.state.storage.get<string>(visibilityKey) || '';
          if (['allow', 'raw-allow'].includes(visibility)) {
            return { success: false, recorded: false, conflict: true, error: 'Auto-hide is no longer active' };
          }
          if ([UNRESOLVED_AUTO_HIDE_VISIBILITY, UNRESOLVED_HUMAN_HIDE_VISIBILITY].includes(visibility)) {
            const humanRestore = await this.hasHumanRestore(operation.eventId);
            if (humanRestore === null) {
              return { success: false, recorded: false, error: 'Human restore state is unavailable' };
            }
            if (humanRestore) {
              return { success: false, recorded: false, conflict: true, error: 'Auto-hide is no longer active' };
            }
            const recorded = await this.recordAutoHideHumanDecision(operation, AUTO_HIDE_ACTION.confirmed);
            if (recorded) await this.state.storage.delete(visibilityKey);
            return recorded
              ? { success: true, recorded: true }
              : { success: false, recorded: false, error: 'Failed to record auto-hide confirmation' };
          }
          if (!await canConfirmAutoHide(this.env.DB, operation.eventId)) {
            return { success: false, recorded: false, conflict: true, error: 'Auto-hide is no longer active' };
          }
          const recorded = await this.recordAutoHideHumanDecision(operation, AUTO_HIDE_ACTION.confirmed);
          if (!recorded) return { success: false, recorded: false, error: 'Failed to record auto-hide confirmation' };
          return { success: true, recorded: true };
        } else if (operation.relayAction === 'review') {
          let shouldRestoreAutoHide = false;
          const visibilityKey = this.visibilityStorageKey(operation.eventId);
          const visibility = await this.state.storage.get<string>(visibilityKey);
          if (visibility === UNRESOLVED_AUTO_HIDE_VISIBILITY) {
            shouldRestoreAutoHide = true;
          } else if (!['hide', UNRESOLVED_HUMAN_HIDE_VISIBILITY].includes(visibility || '') && this.env.DB) {
            try {
              shouldRestoreAutoHide = await hasActiveAutoHide(this.env.DB, operation.eventId);
            } catch (error) {
              relayFailure = {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to read auto-hide state',
              };
            }
          }
          if (shouldRestoreAutoHide) {
            const previousVisibility = visibility;
            await this.state.storage.put(visibilityKey, 'allow');
            const relayResult = await callNip86Rpc('allowevent', [operation.eventId], this.env);
            if (relayResult.success) {
              const recorded = await this.recordAutoHideHumanDecision(
                operation,
                AUTO_HIDE_ACTION.restored,
                AUTO_HIDE_ACTION.restored,
              );
              if (recorded) await this.state.storage.delete(visibilityKey);
              return recorded
                ? { success: true, recorded: true }
                : { success: false, recorded: false, error: 'Content was restored but its review state was not recorded' };
            } else {
              if (previousVisibility === undefined) await this.state.storage.delete(visibilityKey);
              else await this.state.storage.put(visibilityKey, previousVisibility);
              relayFailure = relayResult;
            }
          }
        } else {
          const visibilityKey = this.visibilityStorageKey(operation.eventId);
          const previousVisibility = await this.state.storage.get<string>(visibilityKey);
          let recordsAutoHideRestore = false;
          if (operation.relayAction === 'allow' && operation.humanAction !== undefined && this.env.DB) {
            try {
              recordsAutoHideRestore = await hasActiveAutoHide(this.env.DB, operation.eventId);
            } catch (error) {
              relayFailure = {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to read auto-hide state',
              };
            }
          }
          // Only a human restore is authoritative over an admitted auto-hide. Raw
          // allowevent RPCs still serialize here, but must not leave a tombstone that
          // suppresses future report-driven enforcement.
          if (operation.relayAction === 'allow') {
            if (operation.humanAction !== undefined) {
              await this.state.storage.put(visibilityKey, 'allow');
            } else if (previousVisibility !== 'allow') {
              await this.state.storage.put(visibilityKey, 'raw-allow');
            }
          }
          const relayResult = operation.relayAction === 'hide'
            ? await callNip86Rpc('banevent', [operation.eventId, operation.reason || 'Hidden by moderator'], this.env)
            : await callNip86Rpc('allowevent', [operation.eventId], this.env);
          if (!relayResult.success) {
            if (previousVisibility === undefined) await this.state.storage.delete(visibilityKey);
            else await this.state.storage.put(visibilityKey, previousVisibility);
            return relayResult;
          }
          if (recordsAutoHideRestore) {
            const recorded = await this.recordAutoHideHumanDecision(
              operation,
              AUTO_HIDE_ACTION.restored,
              AUTO_HIDE_ACTION.restored,
            );
            if (recorded) await this.state.storage.delete(visibilityKey);
            return recorded
              ? { success: true, recorded: true }
              : { success: false, recorded: false, error: 'Content was restored but its review state was not recorded' };
          }
        }

        if (operation.humanAction === undefined) return { success: true };
        if (!this.env.DB) {
          if (operation.relayAction === 'hide') {
            await this.state.storage.put(this.visibilityStorageKey(operation.eventId), 'hide');
          }
          return { success: true, recorded: false };
        }

        try {
          const recorded = operation.relayAction === 'review'
            ? await markHumanReviewed(this.env.DB, 'event', operation.eventId)
            : await markHumanAction(this.env.DB, 'event', operation.eventId, operation.humanAction);
          if (recorded && ['allow', 'hide'].includes(operation.relayAction)) {
            await this.state.storage.delete(this.visibilityStorageKey(operation.eventId));
          } else if (!recorded && operation.relayAction === 'hide') {
            await this.state.storage.put(this.visibilityStorageKey(operation.eventId), 'hide');
          }
          return relayFailure
            ? { ...relayFailure, recorded }
            : { success: true, recorded };
        } catch (error) {
          console.error('[ReportWatcher] Event visibility mark failed:', error);
          if (operation.relayAction === 'hide') {
            await this.state.storage.put(this.visibilityStorageKey(operation.eventId), 'hide');
          }
          return { success: true, recorded: false };
        }
      } catch (error) {
        console.error('[ReportWatcher] Event visibility operation failed:', error);
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
      }
    });

    return Response.json(result, { status: result.success ? 200 : result.conflict ? 409 : 502 });
  }

  private validateConfig(config: AutoHideConfig): string | null {
    if (!config || typeof config.enabled !== 'boolean') {
      return 'Missing or invalid "enabled" field';
    }
    if (!Array.isArray(config.trustedClients)) {
      return 'Missing or invalid "trustedClients" field';
    }
    if (!Array.isArray(config.tiers) || config.tiers.length === 0) {
      return 'Must have at least one tier';
    }

    const allCategories = new Set<string>();
    for (const tier of config.tiers) {
      if (!tier.name || typeof tier.name !== 'string') {
        return 'Each tier must have a name';
      }
      if (!Array.isArray(tier.categories)) {
        return `Tier "${tier.name}": categories must be an array`;
      }
      if (typeof tier.threshold !== 'number' || tier.threshold < 1) {
        return `Tier "${tier.name}": threshold must be >= 1`;
      }
      if (!AUTO_HIDE_TIER_KINDS.includes(tier.kind)) {
        return `Tier "${tier.name}": kind must be "immediate" or "threshold"`;
      }
      if (isImmediateAutoHideTier(tier) && tier.threshold !== 1) {
        return `Tier "${tier.name}": immediate tier threshold must be exactly 1`;
      }
      if (isThresholdAutoHideTier(tier) && tier.threshold < 2) {
        return `Tier "${tier.name}": threshold tier minimum is 2`;
      }

      for (const cat of tier.categories) {
        if (allCategories.has(cat)) {
          return `Category "${cat}" appears in multiple tiers (duplicate not allowed)`;
        }
        allCategories.add(cat);
      }
    }

    if (config.trustedClients.length === 0 && config.tiers.some(t => t.requireTrustedClient)) {
      return 'At least one trusted client required when a tier has requireTrustedClient enabled';
    }

    return null;
  }

  private buildDefaultConfig(): AutoHideConfig {
    return {
      enabled: this.env.AUTO_HIDE_ENABLED === 'true',
      trustedClients: (this.env.TRUSTED_CLIENTS || 'diVine,divine-web,divine-mobile').split(','),
      tiers: [
        {
          kind: 'immediate',
          name: 'Immediate',
          categories: [...DEFAULT_IMMEDIATE_CATEGORIES],
          threshold: 1,
          requireTrustedClient: true,
        },
        {
          kind: 'threshold',
          name: 'Threshold',
          categories: [...DEFAULT_THRESHOLD_CATEGORIES],
          threshold: 2,
          requireTrustedClient: false,
        },
      ],
    };
  }

  private normalizeStoredConfig(config: StoredAutoHideConfig): { config: AutoHideConfig; changed: boolean } {
    let changed = false;

    const tiers = config.tiers.map((tier) => {
      if (AUTO_HIDE_TIER_KINDS.includes(tier.kind as AutoHideTier['kind'])) {
        return tier as AutoHideTier;
      }

      changed = true;
      return {
        ...tier,
        kind: tier.threshold <= 1 ? 'immediate' : 'threshold',
      } satisfies AutoHideTier;
    });

    return {
      config: {
        ...config,
        tiers,
      },
      changed,
    };
  }

  /**
   * Build status object
   */
  private getStatus(): ReportWatcherStatus {
    return {
      running: this.running,
      connected: this.ws !== null && this.ws.readyState === WebSocket.OPEN,
      connectedAt: this.connectedAt,
      lastEventAt: this.lastEventAt,
      eventsProcessed: this.eventsProcessed,
      eventsAutoHidden: this.eventsAutoHidden,
      autoHideEnabled: this.autoHideConfig?.enabled ?? false,
      reconnectAttempts: this.reconnectAttempts,
    };
  }

  /**
   * Persist state to storage
   */
  private async persistState(): Promise<void> {
    await this.state.storage.put('watcherState', {
      running: this.running,
      eventsProcessed: this.eventsProcessed,
      eventsAutoHidden: this.eventsAutoHidden,
    });
  }

  /**
   * Connect to relay WebSocket
   */
  private connect(): void {
    if (this.ws) {
      this.disconnect();
    }

    const relayUrl = this.env.RELAY_URL;
    console.log(`[ReportWatcher] Connecting to ${relayUrl}`);

    try {
      this.ws = new WebSocket(relayUrl);

      this.ws.addEventListener('open', () => {
        console.log('[ReportWatcher] WebSocket connected');
        this.connectedAt = Date.now();
        this.reconnectAttempts = 0;
        this.reconnectDelay = INITIAL_RECONNECT_DELAY_MS;

        // Subscribe to kind 1984 reports
        // Using limit: 0 to only get new events (not historical)
        const subscription = JSON.stringify([
          'REQ',
          this.subscriptionId,
          { kinds: [1984], limit: 0 }
        ]);
        this.ws?.send(subscription);
        console.log('[ReportWatcher] Subscribed to kind 1984 reports');
      });

      this.ws.addEventListener('message', (event) => {
        const work = this.handleMessage(event.data as string).catch(error => {
          console.error('[ReportWatcher] Message handler failed:', error);
        });
        this.state.waitUntil(work);
      });

      this.ws.addEventListener('close', (event) => {
        console.log(`[ReportWatcher] WebSocket closed: ${event.code} ${event.reason}`);
        this.ws = null;
        this.connectedAt = null;

        // Reconnect if still supposed to be running
        if (this.running) {
          this.scheduleReconnect();
        }
      });

      this.ws.addEventListener('error', (error) => {
        console.error('[ReportWatcher] WebSocket error:', error);
        // The close event will fire after this, triggering reconnection
      });
    } catch (error) {
      console.error('[ReportWatcher] Failed to create WebSocket:', error);
      if (this.running) {
        this.scheduleReconnect();
      }
    }
  }

  /**
   * Disconnect from relay
   */
  private disconnect(): void {
    if (this.ws) {
      // Unsubscribe before closing
      try {
        if (this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify(['CLOSE', this.subscriptionId]));
        }
        this.ws.close();
      } catch {
        // Ignore errors during cleanup
      }
      this.ws = null;
      this.connectedAt = null;
    }
  }

  /**
   * Schedule reconnection with exponential backoff
   */
  private scheduleReconnect(): void {
    this.reconnectAttempts++;
    console.log(`[ReportWatcher] Scheduling reconnect in ${this.reconnectDelay}ms (attempt ${this.reconnectAttempts})`);

    // Use alarm for reconnection
    this.state.storage.setAlarm(Date.now() + this.reconnectDelay);

    // Increase delay for next attempt (exponential backoff)
    this.reconnectDelay = Math.min(
      this.reconnectDelay * RECONNECT_BACKOFF_MULTIPLIER,
      MAX_RECONNECT_DELAY_MS
    );
  }

  /**
   * Schedule health check alarm
   */
  private async scheduleHealthCheck(): Promise<void> {
    await this.state.storage.setAlarm(Date.now() + HEALTH_CHECK_INTERVAL_MS);
  }

  /**
   * Handle incoming WebSocket message
   */
  private async handleMessage(data: string): Promise<void> {
    try {
      const message = JSON.parse(data) as unknown[];

      if (!Array.isArray(message) || message.length < 2) {
        return;
      }

      const [type, ...rest] = message;

      switch (type) {
        case 'EVENT': {
          const [subId, event] = rest as [string, ReportEvent];
          if (subId === this.subscriptionId && event.kind === 1984) {
            await this.handleReportEvent(event);
          }
          break;
        }

        case 'EOSE': {
          console.log('[ReportWatcher] End of stored events');
          break;
        }

        case 'NOTICE': {
          console.log(`[ReportWatcher] Relay notice: ${rest[0]}`);
          break;
        }

        case 'OK': {
          // Event publish confirmation (not expected for subscriptions)
          break;
        }

        case 'CLOSED': {
          const [subId, message] = rest as [string, string];
          console.log(`[ReportWatcher] Subscription closed: ${subId} - ${message}`);
          break;
        }
      }
    } catch (error) {
      console.error('[ReportWatcher] Failed to parse message:', error);
    }
  }

  /**
   * Handle a kind 1984 report event
   */
  private async handleReportEvent(event: ReportEvent): Promise<void> {
    this.lastEventAt = Date.now();
    this.eventsProcessed++;

    // Extract report category from tags
    // Support multiple formats used by Divine clients:
    // 1. ["report", "<category>"] - Divine mobile app format (NIP-56)
    // 2. ["l", "NS-<category>", "social.nos.ontology"] - Divine web app format (NIP-32)
    // 3. ["l", "<category>", "MOD"] - Generic NIP-32 MOD namespace
    // 4. ["e", "<id>", "<category>"] or ["p", "<id>", "<category>"] - category in target tag
    const reportTag = event.tags.find(t => t[0] === 'report');
    const labelTagNos = event.tags.find(t => t[0] === 'l' && t[2] === 'social.nos.ontology');
    const labelTagMod = event.tags.find(t => t[0] === 'l' && t[2] === 'MOD');

    // Extract target (e tag for event, p tag for pubkey)
    const targetEventTag = event.tags.find(t => t[0] === 'e');
    const targetPubkeyTag = event.tags.find(t => t[0] === 'p');

    // Get category from first available source
    // Priority: report tag > NIP-32 label > e/p tag third element
    const category = reportTag?.[1]
      || labelTagNos?.[1]
      || labelTagMod?.[1]
      || targetEventTag?.[2]
      || targetPubkeyTag?.[2]
      || 'unknown';

    const targetType = targetEventTag ? 'event' : targetPubkeyTag ? 'pubkey' : 'unknown';
    const targetId = targetEventTag?.[1] || targetPubkeyTag?.[1] || 'unknown';

    console.log(`[ReportWatcher] Report received:`, {
      reportId: event.id,
      reporter: event.pubkey,
      category,
      targetType,
      targetId,
      content: event.content.slice(0, 50) + (event.content.length > 50 ? '...' : ''),
    });

    // Process auto-hide if enabled and category qualifies
    if (targetType === 'event' && targetId !== 'unknown') {
      try {
        await this.processAutoHide(event, category, targetId);
      } catch (error) {
        console.error('[ReportWatcher] Auto-hide processing failed:', error);
      }
    }

    // Create age review case for under-16 reports (pubkey-level).
    // Runs after auto-hide completes; both awaited so work survives DO eviction.
    const reportedPubkey = targetPubkeyTag?.[1];
    if (category === 'NS-underageUser' && reportedPubkey && !this.pendingAgeReviewPubkeys.has(reportedPubkey)) {
      this.pendingAgeReviewPubkeys.add(reportedPubkey);
      try {
        await this.createAgeReviewCase(event, reportedPubkey);
      } catch (error) {
        console.error('[ReportWatcher] Age review case creation failed:', error);
      } finally {
        this.pendingAgeReviewPubkeys.delete(reportedPubkey);
      }
    }
  }

  private async processAutoHide(
    event: ReportEvent,
    category: string,
    targetEventId: string
  ): Promise<void> {
    if (!this.schemaReady && this.env.DB) {
      try {
        await ensureSchema(this.env.DB);
        this.schemaReady = true;
      } catch (error) {
        console.error('[ReportWatcher] Failed to ensure schema:', error);
      }
    }

    const config = this.autoHideConfig;
    if (!config || !config.enabled) {
      console.log('[ReportWatcher] Auto-hide disabled, skipping');
      return;
    }

    // Find which tier this category belongs to
    const tier = config.tiers.find(t => t.categories.includes(category));
    if (!tier) {
      console.log(`[ReportWatcher] Category '${category}' not in any auto-hide tier, skipping`);
      return;
    }

    // Check trusted-client gate if tier requires it.
    //
    // Matched case-insensitively: per NIP-89 this tag element is a display name, not a
    // stable identifier, so its casing is each app's choice and shouldn't decide
    // enforcement. divine-mobile sends `Divine` while TRUSTED_CLIENTS carries the
    // stylized `diVine`, so an exact match skipped mobile reports.
    if (tier.requireTrustedClient) {
      const clientTag = event.tags.find((t: string[]) => t[0] === 'client');
      const clientName = clientTag?.[1];
      const normalizedClient = clientName?.trim().toLowerCase();

      if (!normalizedClient || !config.trustedClients.some(c => c.trim().toLowerCase() === normalizedClient)) {
        console.log(`[ReportWatcher] Report from untrusted client '${clientName || 'none'}', skipping (tier: ${tier.name})`);
        await this.logDecision({
          targetType: 'event',
          targetId: targetEventId,
          action: AUTO_HIDE_ACTION.skipped,
          reason: `${category}: untrusted client (${clientName || 'no client tag'})`,
          reportId: event.id,
          reporterPubkey: event.pubkey,
        });
        return;
      }
    }

    // A raw allow changes relay visibility without superseding the durable human
    // decision. Re-admit enforcement until a successful hide consumes this marker.
    const rawAllow = await this.state.storage.get<string>(this.visibilityStorageKey(targetEventId)) === 'raw-allow';
    const blockingHumanResolution = await this.hasBlockingHumanResolution(targetEventId, rawAllow);
    if (blockingHumanResolution === null) {
      console.error(`[ALERT] [ReportWatcher] Auto-hide skipped for ${targetEventId}: human-review state unavailable`);
      await this.logDecision({
        targetType: 'event',
        targetId: targetEventId,
        action: AUTO_HIDE_ACTION.skipped,
        reason: `${category}: human-review state unavailable`,
        reportId: event.id,
        reporterPubkey: event.pubkey,
      });
      return;
    }
    if (blockingHumanResolution) {
      console.log(`[ReportWatcher] Event ${targetEventId} has human resolution, skipping auto-hide`);
      return;
    }

    if (await this.isAlreadyAutoHidden(targetEventId)) {
      console.log(`[ReportWatcher] Event ${targetEventId} already auto-hidden, skipping`);
      return;
    }

    // Immediate tier: single report triggers ban
    if (isImmediateAutoHideTier(tier)) {
      await this.executeAutoHide(event, category, targetEventId, tier.name);
      return;
    }

    // Threshold tier: count unique reporters, ban when threshold met
    await this.processThresholdAutoHide(event, category, targetEventId, tier);
  }

  private async processThresholdAutoHide(
    event: ReportEvent,
    category: string,
    targetEventId: string,
    tier: AutoHideTier
  ): Promise<void> {
    if (!isThresholdAutoHideTier(tier)) {
      return;
    }

    await this.logDecision({
      targetType: 'event',
      targetId: targetEventId,
      action: AUTO_HIDE_ACTION.pending,
      reason: `${category}: awaiting threshold (${tier.name}, need ${tier.threshold})`,
      reportId: event.id,
      reporterPubkey: event.pubkey,
    });

    const count = await this.countUniqueReporters(targetEventId, category);

    if (count >= tier.threshold) {
      console.log(`[ReportWatcher] Threshold met for ${targetEventId} (${count}/${tier.threshold})`);
      await this.executeAutoHide(event, category, targetEventId, tier.name);
    } else {
      console.log(`[ReportWatcher] Below threshold for ${targetEventId} (${count}/${tier.threshold})`);
    }
  }

  private async executeAutoHide(
    event: ReportEvent,
    category: string,
    targetEventId: string,
    tierName: string
  ): Promise<void> {
    await this.state.blockConcurrencyWhile(async () => {
      try {
        await this.executeAutoHideSerialized(event, category, targetEventId, tierName);
      } catch (error) {
        console.error('[ReportWatcher] Serialized auto-hide failed:', error);
      }
    });
  }

  private async executeAutoHideSerialized(
    event: ReportEvent,
    category: string,
    targetEventId: string,
    tierName: string
  ): Promise<void> {
    const visibility = await this.state.storage.get<string>(this.visibilityStorageKey(targetEventId));
    if (['allow', UNRESOLVED_AUTO_HIDE_VISIBILITY, UNRESOLVED_HUMAN_HIDE_VISIBILITY].includes(visibility || '')) {
      const reason = visibility === 'allow'
        ? 'restored visibility was not recorded'
        : 'post-ban visibility remains unresolved';
      console.error(`[ALERT] [ReportWatcher] Serialized auto-hide skipped for ${targetEventId}: ${reason}`);
      await this.logDecision({
        targetType: 'event',
        targetId: targetEventId,
        action: AUTO_HIDE_ACTION.skipped,
        reason: `${category}: ${reason}`,
        reportId: event.id,
        reporterPubkey: event.pubkey,
      });
      return;
    }
    // The first check happens before tier processing. Recheck both the durable
    // decision and raw visibility override inside the same gate used by human actions.
    const rawAllow = await this.state.storage.get<string>(this.visibilityStorageKey(targetEventId)) === 'raw-allow';
    const blockingHumanResolution = await this.hasBlockingHumanResolution(targetEventId, rawAllow);
    if (blockingHumanResolution === null) {
      console.error(`[ALERT] [ReportWatcher] Serialized auto-hide skipped for ${targetEventId}: human-review state unavailable`);
      await this.logDecision({
        targetType: 'event',
        targetId: targetEventId,
        action: AUTO_HIDE_ACTION.skipped,
        reason: `${category}: human-review state unavailable inside visibility gate`,
        reportId: event.id,
        reporterPubkey: event.pubkey,
      });
      return;
    }
    if (blockingHumanResolution) {
      console.log(`[ReportWatcher] Event ${targetEventId} received a human resolution before auto-hide execution`);
      return;
    }

    console.log(`[ReportWatcher] Auto-hiding event ${targetEventId} (tier: ${tierName})`);

    const reason = `Auto-hidden: ${category} report (tier: ${tierName}, report_id: ${event.id})`;
    const result = await callNip86Rpc('banevent', [targetEventId, reason], this.env);

    if (result.success) {
      const visibilityKey = this.visibilityStorageKey(targetEventId);
      // A restore can race this pass after its first hasHumanResolution check.
      // Recheck the direction-bearing action after the ban and compensate only
      // for a restore; hides and deletes set the permanent reviewed bit too.
      const humanRestore = await this.hasHumanRestore(targetEventId);
      if (humanRestore === null) {
        const visibility = await this.state.storage.get<string>(visibilityKey);
        await this.state.storage.put(
          visibilityKey,
          visibility === 'hide' ? UNRESOLVED_HUMAN_HIDE_VISIBILITY : UNRESOLVED_AUTO_HIDE_VISIBILITY,
        );
        console.error(`[ALERT] [ReportWatcher] Auto-hide outcome unresolved for ${targetEventId}: human restore state unavailable after relay ban`);
        await this.logDecision({
          targetType: 'event',
          targetId: targetEventId,
          action: AUTO_HIDE_ACTION.unresolved,
          reason: `${category}: human restore state unavailable after relay ban`,
          reportId: event.id,
          reporterPubkey: event.pubkey,
        });
        return;
      }
      if (humanRestore) {
        await this.state.storage.put(visibilityKey, 'allow');
        const restore = await callNip86Rpc('allowevent', [targetEventId], this.env);
        if (restore.success) {
          await this.state.storage.delete(visibilityKey);
          console.log(`[ReportWatcher] Reversed raced auto-hide for human-reviewed event ${targetEventId}`);
          await this.logDecision({
            targetType: 'event',
            targetId: targetEventId,
            action: AUTO_HIDE_ACTION.reversed,
            reason: `${category}: raced human restore took precedence`,
            reportId: event.id,
            reporterPubkey: event.pubkey,
          });
          return;
        }
        console.error(`[ReportWatcher] Failed to reverse raced auto-hide: ${restore.error}`);
        await this.logDecision({
          targetType: 'event',
          targetId: targetEventId,
          action: AUTO_HIDE_ACTION.restoreFailed,
          reason: `${category}: failed to reverse raced human restore: ${restore.error}`,
          reportId: event.id,
          reporterPubkey: event.pubkey,
        });
        return;
      }

      if (await this.state.storage.get<string>(visibilityKey) !== 'hide') {
        await this.state.storage.delete(visibilityKey);
      }

      console.log(`[ReportWatcher] Successfully auto-hidden event ${targetEventId}`);
      this.eventsAutoHidden++;
      await this.persistState();

      await this.logDecision({
        targetType: 'event',
        targetId: targetEventId,
        action: AUTO_HIDE_ACTION.hidden,
        reason: category,
        reportId: event.id,
        reporterPubkey: event.pubkey,
      });
    } else {
      console.error(`[ReportWatcher] Failed to auto-hide event: ${result.error}`);

      await this.logDecision({
        targetType: 'event',
        targetId: targetEventId,
        action: AUTO_HIDE_ACTION.failed,
        reason: `${category}: ${result.error}`,
        reportId: event.id,
        reporterPubkey: event.pubkey,
      });
    }
  }

  private async countUniqueReporters(targetEventId: string, category: string): Promise<number> {
    if (!this.env.DB) {
      console.warn('[ReportWatcher] D1 not available for reporter count');
      return 0;
    }

    try {
      const result = await this.env.DB.prepare(`
        SELECT COUNT(DISTINCT reporter_pubkey) as count
        FROM moderation_decisions
        WHERE target_id = ?
          AND action IN (?, ?)
          AND (reason = ? OR reason LIKE ?)
      `).bind(
        targetEventId,
        AUTO_HIDE_ACTION.pending,
        AUTO_HIDE_ACTION.hidden,
        category,
        `${category}:%`
      ).first<{ count: number }>();

      return result?.count ?? 0;
    } catch (error) {
      console.error('[ReportWatcher] Failed to count reporters:', error);
      return 0;
    }
  }

  /**
   * Check if an event was already auto-hidden (for deduplication)
   */
  private async isAlreadyAutoHidden(targetEventId: string): Promise<boolean> {
    if (await this.state.storage.get<string>(this.visibilityStorageKey(targetEventId)) === 'raw-allow') {
      return false;
    }
    if (!this.env.DB) {
      // No D1 available - can't dedupe, allow processing
      console.warn('[ReportWatcher] D1 not available for deduplication check');
      return false;
    }

    try {
      const result = await this.env.DB.prepare(`
        SELECT 1 FROM moderation_decisions
        WHERE target_type = 'event'
          AND target_id = ?
          AND action IN (?, ?)
        LIMIT 1
      `).bind(targetEventId, AUTO_HIDE_ACTION.hidden, AUTO_HIDE_ACTION.confirmed).first();

      return result !== null;
    } catch (error) {
      console.error('[ReportWatcher] Failed to check auto-hide status:', error);
      // On error, allow processing (fail open for enforcement)
      return false;
    }
  }

  /**
   * Check if a human moderator has already made a decision on this target.
   * Reads from moderation_targets (persistent, survives reopen).
   */
  private async hasHumanResolution(targetEventId: string): Promise<boolean | null> {
    if (!this.env.DB) {
      console.error(`[ALERT] [ReportWatcher] Cannot check human resolution for ${targetEventId}: D1 is not bound`);
      return null;
    }

    try {
      const result = await this.env.DB.prepare(`
        SELECT 1 FROM moderation_targets
        WHERE target_id = ? AND ever_human_reviewed = 1
      `).bind(targetEventId).first();

      return result !== null;
    } catch (error) {
      console.error('[ReportWatcher] Failed to check human resolution:', error);
      return null;
    }
  }

  private async hasBlockingHumanResolution(targetEventId: string, rawAllow: boolean): Promise<boolean | null> {
    const humanResolution = await this.hasHumanResolution(targetEventId);
    if (humanResolution !== true || !rawAllow) return humanResolution;

    // A raw visibility override supersedes a prior hide/confirmation for report
    // admission, but it must never supersede an explicit human restore.
    return this.hasHumanRestore(targetEventId);
  }

  /**
   * Whether the latest human decision specifically restores this event.
   * The permanent reviewed bit alone is direction-free: hides and deletes set it too.
   */
  private async hasHumanRestore(targetEventId: string): Promise<boolean | null> {
    if (!this.env.DB) return false;

    try {
      return await hasLatestHumanRestore(this.env.DB, targetEventId);
    } catch (error) {
      console.error('[ReportWatcher] Failed to check latest human action:', error);
      return null;
    }
  }

  /**
   * Log moderation decision to D1
   */
  private async logDecision(decision: {
    targetType: string;
    targetId: string;
    action: string;
    reason: string;
    reportId: string;
    reporterPubkey: string;
    moderatorPubkey?: string;
  }): Promise<boolean> {
    if (!this.env.DB) {
      console.warn('[ReportWatcher] D1 database not available, skipping log');
      return false;
    }

    try {
      await this.env.DB.prepare(`
        INSERT INTO moderation_decisions
        (target_type, target_id, action, reason, moderator_pubkey, report_id, reporter_pubkey, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `).bind(
        decision.targetType,
        decision.targetId,
        decision.action,
        decision.reason,
        decision.moderatorPubkey || 'auto',
        decision.reportId,
        decision.reporterPubkey
      ).run();

      console.log(`[ReportWatcher] Logged decision: ${decision.action} for ${decision.targetId}`);
      return true;
    } catch (error) {
      console.error('[ReportWatcher] Failed to log decision:', error);
      return false;
    }
  }

  private async recordAutoHideHumanDecision(
    operation: EventVisibilityOperation,
    action: string,
    lastHumanAction?: string,
  ): Promise<boolean> {
    if (!this.env.DB) return false;
    const targetStatement = lastHumanAction
      ? this.env.DB.prepare(`
          INSERT INTO moderation_targets (target_id, target_type, ever_human_reviewed, last_human_action)
          VALUES (?, 'event', 1, ?)
          ON CONFLICT(target_id) DO UPDATE SET
            ever_human_reviewed = 1,
            last_human_action = excluded.last_human_action
        `).bind(operation.eventId, lastHumanAction)
      : this.env.DB.prepare(`
          INSERT INTO moderation_targets (target_id, target_type, ever_human_reviewed)
          VALUES (?, 'event', 1)
          ON CONFLICT(target_id) DO UPDATE SET ever_human_reviewed = 1
        `).bind(operation.eventId);
    try {
      await this.env.DB.batch([
        this.env.DB.prepare(`
          INSERT INTO moderation_decisions
          (target_type, target_id, action, reason, moderator_pubkey, report_id, reporter_pubkey, created_at)
          VALUES ('event', ?, ?, ?, ?, ?, ?, datetime('now'))
        `).bind(
          operation.eventId,
          action,
          operation.reason || operation.humanAction || 'human review',
          operation.moderatorPubkey || 'auto',
          operation.reportId || '',
          operation.reporterPubkey || '',
        ),
        targetStatement,
      ]);
      return true;
    } catch (error) {
      console.error(`[ReportWatcher] Failed to record ${action}:`, error);
      return false;
    }
  }

  private visibilityStorageKey(eventId: string): string {
    return `event-visibility:${eventId}`;
  }

  private async createAgeReviewCase(event: ReportEvent, reportedPubkey: string): Promise<void> {
    if (!this.env.DB) {
      console.warn('[ReportWatcher] D1 database not available, cannot create age review case');
      return;
    }

    if (!this.schemaReady) {
      try {
        await ensureSchema(this.env.DB);
        this.schemaReady = true;
      } catch (error) {
        console.error('[ReportWatcher] Failed to ensure schema:', error);
        return;
      }
    }

    // Skip if an active case already exists for this pubkey
    const existing = await this.env.DB.prepare(`
      SELECT id, state FROM age_review_cases
      WHERE pubkey = ? AND state NOT IN (${TERMINAL_STATES.map(() => '?').join(',')})
      LIMIT 1
    `).bind(reportedPubkey, ...TERMINAL_STATES).first<{ id: string; state: string }>();

    if (existing) {
      console.log(`[ReportWatcher] Active age review case ${existing.id} already exists for ${reportedPubkey}, skipping`);
      return;
    }

    // Auto-clear: if user is a previously verified minor, create case as immediately cleared
    try {
      const keycastStatus = await getUserStatus(reportedPubkey, this.env);
      if (keycastStatus.success && keycastStatus.verified_minor) {
        const caseId = crypto.randomUUID();
        // Capture here too. This case opens already cleared, so nothing hides the
        // profile today -- but the account may be actioned later, and a cleared
        // case is still one a moderator may need to identify after the fact.
        const lookup = await fetchAccountIdentity(reportedPubkey, this.env.RELAY_URL)
          .catch(() => ({ completed: false, profile: null }));
        const identity = lookup.profile;
        // Null unless the relay answered -- see the note on the main path.
        const identityCapturedAt = lookup.completed ? new Date().toISOString() : null;

        await this.env.DB.prepare(`
          INSERT INTO age_review_cases
          (id, pubkey, reporter_pubkey, report_id, suspected_age_band, state, allowed_resolution, resolution_note, created_via,
           account_name, account_nip05, account_vine_username, identity_captured_at)
          VALUES (?, ?, ?, ?, 'age_13_15', 'cleared', 'parent_video_or_email', 'Auto-cleared: previously verified minor', 'report', ?, ?, ?, ?)
        `).bind(
          caseId,
          reportedPubkey,
          event.pubkey,
          event.id,
          identity?.name ?? null,
          identity?.nip05 ?? null,
          identity?.vineUsername ?? null,
          identityCapturedAt,
        ).run();

        await this.logDecision({
          targetType: 'pubkey',
          targetId: reportedPubkey,
          action: AGE_REVIEW_ACTION.caseCreated,
          reason: `Under-16 report auto-cleared: verified minor (case ${caseId})`,
          reportId: event.id,
          reporterPubkey: event.pubkey,
        });

        console.log(`[ReportWatcher] Age review case ${caseId} auto-cleared for verified minor ${reportedPubkey}`);
        return;
      }
    } catch (err) {
      console.warn(`[ReportWatcher] Keycast verified_minor check failed for ${reportedPubkey}, proceeding with normal case:`, err);
    }

    const caseId = crypto.randomUUID();
    const band = 'age_13_15' as const;
    const deadline = new Date(Date.now() + DEADLINE_DAYS * 24 * 60 * 60 * 1000).toISOString();

    // Capture a readable identifier while one is still visible. The invariant
    // is that nothing which hides a *pubkey's* profile may run first:
    // suspendpubkey/banpubkey hide the account's content from relay queries and
    // a later lookup returns nothing. Those run only from the case-update
    // handler and the deadline cron, both of which act on a case that already
    // exists and has already captured.
    //
    // Not the stronger claim that no enforcement at all precedes this.
    // handleReportEvent awaits processAutoHide first, which can reach banEvent
    // -- but that targets a single event id and leaves the author's kind-0
    // queryable, so it does not threaten the capture.
    //
    // Best-effort by contract -- fetchAccountIdentity swallows its own errors,
    // and the extra catch here covers an unexpected throw so enrichment can
    // never be the reason a case fails to open.
    const lookup = await fetchAccountIdentity(reportedPubkey, this.env.RELAY_URL)
      .catch(() => ({ completed: false, profile: null }));
    const identity = lookup.profile;
    // Only stamp when the relay actually answered. A timeout or an unreachable
    // relay is not evidence the account has no profile, and a stamp would
    // exclude this case from the backfill for good -- right before enforcement
    // hides the profile and makes the loss permanent.
    const identityCapturedAt = lookup.completed ? new Date().toISOString() : null;

    await this.env.DB.prepare(`
      INSERT INTO age_review_cases
      (id, pubkey, reporter_pubkey, report_id, suspected_age_band, state, allowed_resolution, deadline_at,
       account_name, account_nip05, account_vine_username, identity_captured_at)
      VALUES (?, ?, ?, ?, ?, 'open_reported', ?, ?, ?, ?, ?, ?)
    `).bind(
      caseId,
      reportedPubkey,
      event.pubkey,
      event.id,
      band,
      defaultResolutionForBand(band),
      deadline,
      identity?.name ?? null,
      identity?.nip05 ?? null,
      identity?.vineUsername ?? null,
      identityCapturedAt,
    ).run();

    await this.logDecision({
      targetType: 'pubkey',
      targetId: reportedPubkey,
      action: AGE_REVIEW_ACTION.caseCreated,
      reason: `Under-16 report: age review case ${caseId} created (default band: ${band})`,
      reportId: event.id,
      reporterPubkey: event.pubkey,
    });

    console.log(`[ReportWatcher] Age review case created: ${caseId} for ${reportedPubkey} (deadline: ${deadline})`);
  }

  /**
   * Alarm handler for reconnection and health checks
   */
  async alarm(): Promise<void> {
    console.log('[ReportWatcher] Alarm triggered');

    if (!this.running) {
      console.log('[ReportWatcher] Not running, skipping alarm');
      return;
    }

    // Check if we need to reconnect
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.log('[ReportWatcher] Connection lost, reconnecting...');
      this.connect();
    } else {
      console.log('[ReportWatcher] Connection healthy');
    }

    // Schedule next health check
    await this.scheduleHealthCheck();
  }
}
