// ABOUTME: Durable Object for watching NIP-56 content reports (kind 1984)
// ABOUTME: Maintains persistent WebSocket to relay for auto-hide functionality

import { type Nip86Env, banEvent } from './nip86';

/**
 * Extended environment for ReportWatcher DO
 */
export interface ReportWatcherEnv extends Nip86Env {
  DB?: D1Database;
  AUTO_HIDE_ENABLED?: string;
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

// Reconnection settings
const INITIAL_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 60000;
const RECONNECT_BACKOFF_MULTIPLIER = 2;

// Alarm interval for connection health checks
const HEALTH_CHECK_INTERVAL_MS = 30000;

// Categories that trigger auto-hide (MVP: CSAM-related categories)
// Maps various client formats to a normalized category for auto-hide
// - 'sexual_minors' - NIP-56 standard
// - 'csam' - Divine mobile/web app format
// - 'NS-csam' - Divine web app with NIP-32 prefix
const AUTO_HIDE_CATEGORIES = ['sexual_minors', 'csam', 'NS-csam'];

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
  private running: boolean = false;
  private ws: WebSocket | null = null;
  private connectedAt: number | null = null;
  private lastEventAt: number | null = null;
  private eventsProcessed: number = 0;
  private eventsAutoHidden: number = 0;
  private reconnectAttempts: number = 0;
  private reconnectDelay: number = INITIAL_RECONNECT_DELAY_MS;
  private subscriptionId: string = 'auto-hide-reports';

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

        // If we were running, reconnect
        if (this.running) {
          console.log('[ReportWatcher] Restoring connection after restart');
          this.connect();
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
      autoHideEnabled: this.env.AUTO_HIDE_ENABLED === 'true',
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
        this.handleMessage(event.data as string);
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
  private handleMessage(data: string): void {
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
            this.handleReportEvent(event);
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
  private handleReportEvent(event: ReportEvent): void {
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
    let category = reportTag?.[1]
      || labelTagNos?.[1]
      || labelTagMod?.[1]
      || targetEventTag?.[2]
      || targetPubkeyTag?.[2]
      || 'unknown';

    const targetType = targetEventTag ? 'event' : targetPubkeyTag ? 'pubkey' : 'unknown';
    const targetId = targetEventTag?.[1] || targetPubkeyTag?.[1] || 'unknown';

    console.log(`[ReportWatcher] Report received:`, {
      reportId: event.id,
      reporter: event.pubkey.slice(0, 8) + '...',
      category,
      targetType,
      targetId: targetId.slice(0, 8) + '...',
      content: event.content.slice(0, 50) + (event.content.length > 50 ? '...' : ''),
    });

    // Process auto-hide if enabled and category qualifies
    if (targetType === 'event' && targetId !== 'unknown') {
      this.processAutoHide(event, category, targetId).catch(error => {
        console.error('[ReportWatcher] Auto-hide processing failed:', error);
      });
    }
  }

  /**
   * Process auto-hide for a report
   */
  private async processAutoHide(
    event: ReportEvent,
    category: string,
    targetEventId: string
  ): Promise<void> {
    // Check if auto-hide is enabled
    if (this.env.AUTO_HIDE_ENABLED !== 'true') {
      console.log('[ReportWatcher] Auto-hide disabled, skipping');
      return;
    }

    // Check if category qualifies for auto-hide
    if (!AUTO_HIDE_CATEGORIES.includes(category)) {
      console.log(`[ReportWatcher] Category '${category}' not in auto-hide list, skipping`);
      return;
    }

    // Check if this event was already auto-hidden (deduplication)
    if (await this.isAlreadyAutoHidden(targetEventId)) {
      console.log(`[ReportWatcher] Event ${targetEventId.slice(0, 8)}... already auto-hidden, skipping`);
      return;
    }

    console.log(`[ReportWatcher] Processing auto-hide for event ${targetEventId.slice(0, 8)}...`);

    // Call banevent RPC to hide the content
    const reason = `Auto-hidden: ${category} report (report_id: ${event.id})`;
    const result = await banEvent(targetEventId, reason, this.env);

    if (result.success) {
      console.log(`[ReportWatcher] Successfully auto-hidden event ${targetEventId.slice(0, 8)}...`);
      this.eventsAutoHidden++;
      await this.persistState();

      // Log to D1
      await this.logDecision({
        targetType: 'event',
        targetId: targetEventId,
        action: 'auto_hidden',
        reason: category,
        reportId: event.id,
        reporterPubkey: event.pubkey,
      });
    } else {
      console.error(`[ReportWatcher] Failed to auto-hide event: ${result.error}`);

      // Log failure to D1 for monitoring
      await this.logDecision({
        targetType: 'event',
        targetId: targetEventId,
        action: 'auto_hide_failed',
        reason: `${category}: ${result.error}`,
        reportId: event.id,
        reporterPubkey: event.pubkey,
      });
    }
  }

  /**
   * Check if an event was already auto-hidden (for deduplication)
   */
  private async isAlreadyAutoHidden(targetEventId: string): Promise<boolean> {
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
          AND action IN ('auto_hidden', 'auto_hide_confirmed')
        LIMIT 1
      `).bind(targetEventId).first();

      return result !== null;
    } catch (error) {
      console.error('[ReportWatcher] Failed to check auto-hide status:', error);
      // On error, allow processing (fail open for enforcement)
      return false;
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
  }): Promise<void> {
    if (!this.env.DB) {
      console.warn('[ReportWatcher] D1 database not available, skipping log');
      return;
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
        'auto', // moderator_pubkey = 'auto' for automated decisions
        decision.reportId,
        decision.reporterPubkey
      ).run();

      console.log(`[ReportWatcher] Logged decision: ${decision.action} for ${decision.targetId.slice(0, 8)}...`);
    } catch (error) {
      console.error('[ReportWatcher] Failed to log decision:', error);
    }
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
