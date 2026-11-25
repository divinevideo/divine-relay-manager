// ABOUTME: Durable Object for watching NIP-56 content reports (kind 1984)
// ABOUTME: Maintains persistent WebSocket to relay for auto-hide functionality

import { verifyEvent, type Event as NostrEvent } from 'nostr-tools';
import { callNip86Rpc, type Nip86Env } from './nip86';
import { ensureSchema } from './db';
import { reportArrivalStatement } from './report-arrivals';
import { metaStatement, readMeta, reportIndexRefStatements, reportIndexRowStatements, runStatements, type ReportIndexSource } from './report-index';
import {
  CATCHUP_STOPPED_PERIODS_KEY,
  CATCHUP_WINDOWS_KEY,
  addPendingWindow,
  addStoppedPeriod,
  inStoppedPeriod,
  stopPeriodFor,
  stoppedPeriodMergeAlertText,
  stoppedPeriodReachFloor,
  type StoppedPeriod,
  planCatchUpWindow,
  runPendingCatchUp,
  type CatchUpSummary,
  type CatchUpWindow,
} from './report-catchup';
import { sendReportIndexAlert } from './report-index-alerts';
import { type EventVisibilityOperation, type EventVisibilityResult } from './event-visibility';
import { markHumanAction, markHumanReviewed } from './human-decision';
import {
  AUTO_HIDE_ACTION,
  AUTO_HIDE_TIER_KINDS,
  isImmediateAutoHideTier,
  isThresholdAutoHideTier,
  type AutoHideConfig,
  type AutoHideTier,
} from '../../shared/autohide';
import { getReportedList } from '../../shared/list-report';
import { ageReviewCategory } from '../../shared/report-classification';
import { AUTOMATED_MODERATOR } from '../../shared/automated-decision';
import { isLowerHex64 } from './hex';
import { canonicalHex64 } from '../../shared/hex-id';
import { type KeycastEnv } from './keycast-client';
import { openReportedAgeReviewCase } from './reported-age-review';
import { SexualQuarantine, OutsideVideoScope, ConfirmedAbsentTarget, TargetEvidenceLimit, QuarantineConflict, adultSexualCategory, type QuarantineSnapshot } from './sexual-quarantine';
import { createQuarantineIO, type SexualQuarantineEnv } from './sexual-quarantine-io';
import { replayAdultReports, replayReachFloor, reportCategory } from './sexual-report-replay';

const UNRESOLVED_AUTO_HIDE_VISIBILITY = 'unresolved-hide';
const UNRESOLVED_HUMAN_HIDE_VISIBILITY = 'hide-unresolved';

/**
 * Extended environment for ReportWatcher DO
 */
export interface ReportWatcherEnv extends Nip86Env, KeycastEnv, SexualQuarantineEnv {
  DB?: D1Database;
  AUTO_HIDE_ENABLED?: string;
  TRUSTED_CLIENTS?: string;
  SLACK_WEBHOOK_URL?: string;
  ENVIRONMENT?: string;
}

export async function hasLatestHumanRestore(db: D1Database, targetEventId: string): Promise<boolean> {
  const row = await db.prepare(`
    SELECT 1 FROM moderation_targets
    WHERE target_id = ?
      AND ever_human_reviewed = 1
      AND last_human_action IN (
        'allow_event',
        'restore_event',
        'auto_hide_restored',
        'sexual_quarantine_restore'
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
          AND action IN (?, ?, ?, ?, ?, ?)
       ORDER BY id DESC LIMIT 1) AS auto_hide_action
  `).bind(
    targetEventId,
    targetEventId,
    AUTO_HIDE_ACTION.hidden,
    AUTO_HIDE_ACTION.unresolved,
    AUTO_HIDE_ACTION.restoreFailed,
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
  return row !== null
    && (row.auto_hide_action === AUTO_HIDE_ACTION.hidden
      || row.auto_hide_action === AUTO_HIDE_ACTION.unresolved)
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
  sig?: string;
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

// How long the live REQ may go without EOSE before its socket is dropped.
// Funnelcake ends every REQ with EOSE, CLOSED or a dropped socket within about
// 35 s, so this never fires against a healthy relay.
const LIVE_EOSE_TIMEOUT_MS = 60000;

/** DO storage key: unix seconds of the last /stop, so catch-up can tell a deliberate stop from an outage. */
const DELIBERATE_STOP_KEY = 'report-watcher-deliberate-stop';
/**
 * DO storage key: unix seconds of the /start after that stop, until a connect
 * consumes both. The stopped period ends here: time from the start to the
 * connect is an outage, not more stopped time.
 */
const START_AFTER_STOP_KEY = 'report-watcher-start-after-stop';

/** Report ids claimed by the live path or catch-up, kept in insertion order up to this many. */
const CLAIMED_REPORT_IDS_CAP = 5000;

/** Thrown from the replay's ingest when the watcher stopped mid-replay. */
class ReplayStopped extends Error {}

const IDLE_CATCHUP: CatchUpSummary = { ran: false, found: 0, handled: 0, autoHidden: 0, complete: false };

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
  // True once the catch-up window for this connection is saved. Until then the
  // health alarm must not stamp watcher_last_alive_at: a stamp taken before the
  // window is saved would hide the gap from the next restart.
  private catchUpPlannedForConnection = false;
  // True once this connection's live subscription has reached EOSE. Until then
  // the relay has not acknowledged the REQ, so the socket may be receiving
  // nothing and the health alarm must not stamp watcher_last_alive_at either.
  private liveSubscriptionAcked = false;
  // Closes the socket if its live REQ never reaches EOSE (see armEoseWatchdog).
  private eoseWatchdog: ReturnType<typeof setTimeout> | null = null;
  // A plan is running (from the connect, or a retry from the alarm).
  private catchUpPlanInFlight = false;
  // Every report id the live path or catch-up has taken in this instance, so a
  // report found both ways is handled once. In memory only: after a restart,
  // report_arrivals and report_index carry the same guarantee.
  private claimedReportIds = new Map<string, number>();
  // One catch-up pass at a time: the connect and the cron can both ask.
  private catchUpInFlight: Promise<CatchUpSummary> | null = null;
  // While a catch-up pass runs: report ids that took an automated hide action
  // (a legacy hide or a quarantine hide trigger), so the pass counts exactly
  // its own auto actions for the burst alert. Null outside a pass.
  private autoActionedReportIds: Set<string> | null = null;
  private connectedAt: number | null = null;
  private lastEventAt: number | null = null;
  private eventsProcessed: number = 0;
  private eventsAutoHidden: number = 0;
  private reconnectAttempts: number = 0;
  private reconnectDelay: number = INITIAL_RECONNECT_DELAY_MS;
  private subscriptionId: string = 'auto-hide-reports';
  private autoHideConfig: AutoHideConfig | null = null;
  private pendingAgeReviewPubkeys = new Set<string>();
  private sexualEngine?: SexualQuarantine;
  private pendingLegacySexualReports = new Map<string, Promise<void>>();

  constructor(state: DurableObjectState, env: ReportWatcherEnv) {
    this.state = state;
    this.env = env;

    // Restore persisted state on construction
    this.state.blockConcurrencyWhile(async () => {
      if (this.env.SEXUAL_QUARANTINE_ENABLED === 'true') await this.state.storage.put('sexual-quarantine-activated', true);
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

      await this.ensureSexualRecoveryAlarm();
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

      // Only the Worker's scheduled handler calls this through the DO binding.
      // Its public report-watcher proxy refuses the /internal/ namespace.
      if (path === '/internal/sexual-quarantine-maintenance' && request.method === 'POST') {
        await this.ensureSexualRecoveryAlarm();
        return this.handleStatus();
      }

      // Same caller and the same refusal as above: the cron resumes pending
      // restart catch-up windows here.
      if (path === '/internal/report-catchup' && request.method === 'POST') {
        return Response.json(await this.runCatchUp());
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

      if (path === '/sexual-quarantine' || path.startsWith('/sexual-quarantine/')) {
        return this.handleSexualQuarantine(request, path);
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

    // The end of the stopped period an unconsumed stop marker opened. Before
    // the connect, so its plan reads it. Non-critical: without it the period
    // ends at the connect, as it did before.
    try {
      await this.state.storage.transaction(async (tx) => {
        // Running is checked after the read: a /stop can land during it.
        if (await tx.get<number>(DELIBERATE_STOP_KEY) !== undefined && this.running) {
          await tx.put(START_AFTER_STOP_KEY, Math.floor(Date.now() / 1000));
        }
      });
    } catch (error) {
      console.error('[ReportWatcher] Failed to record the start after a deliberate stop:', error);
    }
    // A /stop can land during any await above. It wins: no socket, no alarm
    // (and the transaction above wrote no start time).
    if (!this.running) return this.stoppedWhileStarting();

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

  private stoppedWhileStarting(): Response {
    console.log('[ReportWatcher] Stopped while starting; start abandoned');
    return new Response(JSON.stringify({
      success: true,
      message: 'Stopped while starting',
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

    // A deliberate stop is not an outage: the next start reads this marker so
    // catch-up does not treat the stopped interval as a gap to replay.
    // Non-critical: if the write fails, /stop still completes. A missing marker
    // makes catch-up treat the gap as an outage, so auto-hide and age review
    // run on it: the miss-nothing default, not the stop-respecting one.
    // An earlier marker that no connect has consumed (a start that never
    // reached the relay) is closed off at that start: its stopped period is
    // saved (to the clock margin after the start, as a connect would save it),
    // and this stop opens a new one. The time between was an outage.
    const merged: StoppedPeriod[] = [];
    try {
      await this.state.storage.transaction(async (tx) => {
        const nowSec = Math.floor(Date.now() / 1000);
        const stopMarker = await tx.get<number>(DELIBERATE_STOP_KEY);
        const startedAt = await tx.get<number>(START_AFTER_STOP_KEY);
        if (stopMarker !== undefined && startedAt !== undefined) {
          const periods = (await tx.get<StoppedPeriod[]>(CATCHUP_STOPPED_PERIODS_KEY)) ?? [];
          const windows = (await tx.get<CatchUpWindow[]>(CATCHUP_WINDOWS_KEY)) ?? [];
          // No heartbeat read here (D1 on /stop), so only the cap prunes; the
          // next connect and pass prune by the heartbeat.
          await tx.put(CATCHUP_STOPPED_PERIODS_KEY, addStoppedPeriod(periods, stopPeriodFor(stopMarker, startedAt, nowSec), windows, -Infinity, m => merged.push(m)));
        }
        if (stopMarker === undefined || startedAt !== undefined) await tx.put(DELIBERATE_STOP_KEY, nowSec);
        await tx.delete(START_AFTER_STOP_KEY);
      });
    } catch (error) {
      merged.length = 0;
      console.error('[ReportWatcher] Failed to record deliberate-stop marker:', error);
    }
    for (const m of merged) await sendReportIndexAlert(this.env, stoppedPeriodMergeAlertText(m));

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
      !isLowerHex64(operation.eventId)
      || !['hide', 'allow', 'review', 'confirm'].includes(operation.relayAction)
      || (operation.reason !== undefined && typeof operation.reason !== 'string')
      || (operation.humanAction !== undefined && typeof operation.humanAction !== 'string')
      || (operation.moderatorPubkey !== undefined && !isLowerHex64(operation.moderatorPubkey))
      || (operation.reportId !== undefined && !isLowerHex64(operation.reportId))
      || (operation.reporterPubkey !== undefined && !isLowerHex64(operation.reporterPubkey))
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

        // Reports may have been loaded before this case's current revision.
        // Only the versioned case view can decide this stream's holds. Once its
        // scoped release is complete, Allow remains a separate base-ban action.
        const sexual = this.sexualQuarantine();
        const existingCase = await sexual.get(operation.eventId);
        if (existingCase && existingCase.state !== 'out_of_scope' && ['allow', 'review', 'confirm'].includes(operation.relayAction)) {
          if (!existingCase.actor || existingCase.goal !== 'restore' || !existingCase.decisionRecordedAt
            || !['restored', 'restored_restricted'].includes(existingCase.state)) {
            return { success: false, conflict: true,
              error: `Review the current revision and provide a reason at /sexual-quarantine/${operation.eventId}` };
          }
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
        } else if (operation.relayAction === 'review' && operation.humanAction !== 'reviewed') {
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
        } else if (operation.relayAction === 'hide' || operation.relayAction === 'allow') {
          const visibilityKey = this.visibilityStorageKey(operation.eventId);
          const previousVisibility = await this.state.storage.get<string>(visibilityKey);
          let recordsAutoHideRestore = false;
          if (operation.relayAction === 'allow' && operation.humanAction !== undefined && this.env.DB) {
            try {
              const state = await getAutoHideState(this.env.DB, operation.eventId);
              recordsAutoHideRestore = state?.auto_hide_action === AUTO_HIDE_ACTION.hidden
                ? state.last_human_action === null
                : state?.auto_hide_action === AUTO_HIDE_ACTION.unresolved
                  || state?.auto_hide_action === AUTO_HIDE_ACTION.restoreFailed;
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
    this.catchUpPlannedForConnection = false;
    this.liveSubscriptionAcked = false;

    const relayUrl = this.env.RELAY_URL;
    console.log(`[ReportWatcher] Connecting to ${relayUrl}`);

    try {
      const socket = new WebSocket(relayUrl);
      this.ws = socket;

      this.ws.addEventListener('open', () => {
        // A replaced or orphaned socket's late open must not subscribe, arm a
        // watchdog or plan catch-up: only the tracked socket of a running
        // watcher does.
        if (!this.running || this.ws !== socket) return;
        console.log('[ReportWatcher] WebSocket connected');
        this.connectedAt = Date.now();
        // The backoff is reset on the live subscription's EOSE, not here: a
        // relay that opens the socket and then answers the REQ with CLOSED
        // (rate limit, auth required, a failing stored query) would otherwise
        // be reconnected every second, each time with a catch-up plan and pass.

        // Subscribe to kind 1984 reports
        // Using limit: 0 to only get new events (not historical)
        const subscription = JSON.stringify([
          'REQ',
          this.subscriptionId,
          { kinds: [1984], limit: 0 }
        ]);
        // Armed before the send: if the send throws, the watchdog still drops
        // this socket, which would otherwise sit open with no live REQ.
        this.armEoseWatchdog(socket);
        try {
          socket.send(subscription);
        } catch (error) {
          console.error('[ReportWatcher] Failed to send the live REQ; the EOSE watchdog will drop the socket:', error);
          return;
        }
        console.log('[ReportWatcher] Subscribed to kind 1984 reports');

        // After the live REQ, so nothing filed from here on is missed: plan the
        // gap since the last heartbeat, then walk it in the background. The
        // claim keeps a report seen both ways to one handling.
        this.state.waitUntil(this.planAndRunCatchUp(socket));
      });

      this.ws.addEventListener('message', (event) => {
        // Only the tracked socket of a running watcher is listened to. A
        // replaced or orphaned socket (after a reconnect or a /stop) can still
        // deliver, and handling that would run auto-hide and age review on a
        // stopped watcher, or act twice.
        if (!this.running || this.ws !== socket) return;
        const work = this.handleMessage(event.data as string, socket).catch(error => {
          console.error('[ReportWatcher] Message handler failed:', error);
        });
        this.state.waitUntil(work);
      });

      this.ws.addEventListener('close', (event) => {
        console.log(`[ReportWatcher] WebSocket closed: ${event.code} ${event.reason}`);
        // A replaced socket's late close must not drop the socket that
        // replaced it or schedule a second reconnect.
        if (this.ws !== socket) return;
        this.ws = null;
        this.connectedAt = null;
        this.clearEoseWatchdog();

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
   * Saves this connection's catch-up windows, then runs a pass.
   *
   * D1 (schema, heartbeat) is read before blockConcurrencyWhile: a slow D1
   * there could hold the gate past 30 s, which resets the object. Reading the
   * heartbeat outside the gate is safe: only this connection's plan can make
   * the alarm stamp it, and that has not happened yet. The pending list and
   * the stop marker are read and written inside the gate, so nothing else
   * touches them between the read and the write. Every failure inside the
   * callback is caught there (a throw resets the object). A failed plan leaves
   * catchUpPlannedForConnection false, so the heartbeat stays where it was;
   * the health alarm retries the plan while the socket stays open, and the
   * next connection plans the same gap otherwise.
   */
  private async planAndRunCatchUp(socket: WebSocket): Promise<void> {
    const db = this.env.DB;
    // One plan at a time (the connect, or an alarm retry). The flag covers only
    // the plan, not the pass after it, so a reconnect during a long pass still
    // plans its own gap.
    if (!db || this.catchUpPlanInFlight) return;
    this.catchUpPlanInFlight = true;
    let planned = false;
    try {
      planned = await this.planCatchUp(db, socket);
    } finally {
      this.catchUpPlanInFlight = false;
    }
    if (planned) await this.runCatchUp();
  }

  /** Saves this connection's windows; true once they are saved. Never throws. */
  private async planCatchUp(db: D1Database, socket: WebSocket): Promise<boolean> {
    // A newer connection replaced this one; it plans for itself.
    if (this.ws !== socket) return false;
    let lastAliveAt: number | undefined;
    try {
      if (!this.schemaReady) {
        await ensureSchema(db);
        this.schemaReady = true;
      }
      lastAliveAt = (await readMeta(db)).watcher_last_alive_at;
    } catch (error) {
      console.error('[ReportWatcher] Failed to read the heartbeat for restart catch-up; plan retried by the health alarm:', error);
      return false;
    }
    let merged: StoppedPeriod[] = [];
    const planned = await this.state.blockConcurrencyWhile(async () => {
      if (this.ws !== socket) return false;
      try {
        // One transaction for the marker, the windows and the periods: a
        // running pass read-modify-writes the same keys (its cursor saves and
        // its end-of-pass prune), and the marker is consumed exactly when what
        // it describes is saved.
        merged = await this.state.storage.transaction(async (tx) => {
          const mergedHere: StoppedPeriod[] = [];
          const stopMarker = await tx.get<number>(DELIBERATE_STOP_KEY);
          const startedAt = await tx.get<number>(START_AFTER_STOP_KEY);
          const nowSec = Math.floor(Date.now() / 1000);
          const fresh = planCatchUpWindow(lastAliveAt, nowSec);
          let windows = (await tx.get<CatchUpWindow[]>(CATCHUP_WINDOWS_KEY)) ?? [];
          const periods = (await tx.get<StoppedPeriod[]>(CATCHUP_STOPPED_PERIODS_KEY)) ?? [];
          if (fresh.length > 0) {
            for (const window of fresh) {
              const added = addPendingWindow(windows, window);
              windows = added.windows;
              if (added.merged) console.warn('[ReportWatcher] Catch-up windows over the cap; merged the two oldest');
            }
            await tx.put(CATCHUP_WINDOWS_KEY, windows);
          }
          if (stopMarker !== undefined) {
            // The stopped period is kept apart from the windows, so catch-up
            // runs no handler on a report created in it whichever window finds
            // it (see runPendingCatchUp). From the stop to the /start plus the
            // clock margin after it (stopPeriodFor); without a recorded start,
            // anchored at this connect.
            const reachFloor = Math.min(stoppedPeriodReachFloor(lastAliveAt, nowSec), await this.otherReachFloor(tx, nowSec));
            const kept = addStoppedPeriod(periods, stopPeriodFor(stopMarker, startedAt, nowSec), windows, reachFloor, m => mergedHere.push(m));
            await tx.put(CATCHUP_STOPPED_PERIODS_KEY, kept);
            await tx.delete(DELIBERATE_STOP_KEY);
          }
          await tx.delete(START_AFTER_STOP_KEY);
          return mergedHere;
        });
        this.catchUpPlannedForConnection = true;
        return true;
      } catch (error) {
        merged = [];
        console.error('[ReportWatcher] Failed to plan restart catch-up; heartbeat held for the next connection:', error);
        return false;
      }
    });
    // Outside the concurrency gate, so the webhook never holds it.
    for (const m of merged) await sendReportIndexAlert(this.env, stoppedPeriodMergeAlertText(m));
    return planned;
  }

  /**
   * The stopped periods as they stand: the saved ones, plus a stop that no
   * connect has consumed yet (stopPeriodFor, from its marker and the recorded
   * /start). Catch-up and the adult replay both read this, per report. One
   * transaction, so a plan consuming the marker cannot fall between the reads.
   */
  private async currentStoppedPeriods(): Promise<StoppedPeriod[]> {
    return this.state.storage.transaction(async (tx) => {
      const periods = (await tx.get<StoppedPeriod[]>(CATCHUP_STOPPED_PERIODS_KEY)) ?? [];
      const stopMarker = await tx.get<number>(DELIBERATE_STOP_KEY);
      if (stopMarker === undefined) return periods;
      const startedAt = await tx.get<number>(START_AFTER_STOP_KEY);
      return [...periods, stopPeriodFor(stopMarker, startedAt, Math.floor(Date.now() / 1000))];
    });
  }

  /**
   * How far back the adult replay can still read, else Infinity. Stopped
   * periods are kept from there on, so the replay can still skip them. It
   * counts while the sexual quarantine is active (env flag or the persisted
   * flag), and also while the replay has never run (no open window, no
   * cursor): a first activation reads a day back. Storage only.
   */
  private async otherReachFloor(
    storage: { get<T>(key: string): Promise<T | undefined> },
    nowSec: number,
  ): Promise<number> {
    const active = this.env.SEXUAL_QUARANTINE_ENABLED === 'true' || await storage.get<boolean>('sexual-quarantine-activated');
    const neverRan = await storage.get('sexual-replay-window') === undefined
      && await storage.get('sexual-replay-through') === undefined;
    return active || neverRan ? replayReachFloor(storage, nowSec) : Infinity;
  }

  /** One catch-up pass, unless one is already running or the watcher is stopped. Never throws. */
  private async runCatchUp(): Promise<CatchUpSummary> {
    const db = this.env.DB;
    // Stopped means no automated actions: pending windows wait for the next start.
    if (!db || !this.running || this.catchUpInFlight) return { ...IDLE_CATCHUP };
    const autoActioned = new Set<string>();
    this.autoActionedReportIds = autoActioned;
    const pass = (async (): Promise<CatchUpSummary> => {
      try {
        return await runPendingCatchUp({
          db,
          relayUrl: this.env.RELAY_URL,
          storage: this.state.storage,
          claim: (id) => this.claimReport(id),
          handle: async (report, handlerEnabled) => {
            await this.handleReportEvent(report, {
              source: 'catchup',
              preClaimed: true,
              sideEffects: handlerEnabled,
            });
            return autoActioned.delete(canonicalHex64(report.id) ?? report.id);
          },
          isRunning: () => this.running,
          stoppedPeriods: () => this.currentStoppedPeriods(),
          otherReachFloor: (nowSec) => this.otherReachFloor(this.state.storage, nowSec),
          alert: (text) => sendReportIndexAlert(this.env, text),
          nowMs: () => Date.now(),
        });
      } catch (error) {
        console.error('[ReportWatcher] Restart catch-up pass failed:', error);
        return { ...IDLE_CATCHUP };
      } finally {
        this.catchUpInFlight = null;
        this.autoActionedReportIds = null;
      }
    })();
    this.catchUpInFlight = pass;
    return pass;
  }

  /** Records an automated hide action for a report while a catch-up pass is counting. */
  private noteAutoAction(reportId: string): void {
    this.autoActionedReportIds?.add(canonicalHex64(reportId) ?? reportId);
  }

  /** True the first time an id is claimed in this instance. */
  private claimReport(id: string): boolean {
    const key = canonicalHex64(id) ?? String(id);
    if (this.claimedReportIds.has(key)) return false;
    this.claimedReportIds.set(key, Date.now());
    if (this.claimedReportIds.size > CLAIMED_REPORT_IDS_CAP) {
      const oldest = this.claimedReportIds.keys().next().value;
      if (oldest !== undefined) this.claimedReportIds.delete(oldest);
    }
    return true;
  }

  /**
   * Disconnect from relay
   */
  private disconnect(): void {
    this.clearEoseWatchdog();
    const ws = this.ws;
    if (ws) {
      // Untracked before closing, so its close event (sync or late) is
      // ignored by the close listener's identity check.
      this.ws = null;
      this.connectedAt = null;
      // Unsubscribe before closing. Separate try blocks: a send that throws
      // must not leave the socket open.
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(['CLOSE', this.subscriptionId]));
        }
      } catch {
        // Ignore errors during cleanup
      }
      try {
        ws.close();
      } catch {
        // Ignore errors during cleanup
      }
    }
  }

  /**
   * Drops `socket` if its live subscription has not reached EOSE in
   * LIVE_EOSE_TIMEOUT_MS. A relay that accepts the socket but never answers the
   * REQ would otherwise leave the watcher on a subscription that delivers
   * nothing, with no heartbeat to show for it. The watchdog disconnects and
   * schedules the backoff reconnect itself rather than waiting for the close
   * event, which a hung peer may never send; disconnect() untracks the socket
   * first, so a late close event is ignored and cannot schedule a second
   * reconnect. The backoff is not reset (only EOSE resets it), so repeated
   * stalls back off. The reconnect resubscribes and plans the gap. Cleared on
   * EOSE, on close and on disconnect.
   */
  private armEoseWatchdog(socket: WebSocket): void {
    // A replaced socket's late open must not disarm the tracked socket's watchdog.
    if (this.ws !== socket) return;
    this.clearEoseWatchdog();
    this.eoseWatchdog = setTimeout(() => {
      this.eoseWatchdog = null;
      // Only the socket it was armed for, never one that replaced it.
      if (this.ws !== socket) return;
      console.error(`[ReportWatcher] Live subscription had no EOSE after ${LIVE_EOSE_TIMEOUT_MS} ms; dropping the socket to reconnect`);
      // disconnect() catches its own send/close errors.
      this.disconnect();
      if (this.running) this.scheduleReconnect();
    }, LIVE_EOSE_TIMEOUT_MS);
  }

  private clearEoseWatchdog(): void {
    if (this.eoseWatchdog === null) return;
    clearTimeout(this.eoseWatchdog);
    this.eoseWatchdog = null;
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

  private async ensureSexualRecoveryAlarm(): Promise<void> {
    // Startup and cron repair a missing alarm even while admission/watching is
    // off. Keep the job check and alarm write atomic, and preserve every
    // existing alarm regardless of whether it is earlier or later.
    await this.state.storage.transaction(async tx => {
      if (await tx.getAlarm() !== null) return;
      const jobs = await tx.list({ prefix: 'sexual-job:', limit: 1 });
      if (jobs.size) await tx.setAlarm(Date.now() + HEALTH_CHECK_INTERVAL_MS);
    });
  }

  /**
   * Schedule health check alarm
   */
  private async scheduleHealthCheck(): Promise<void> {
    // Never postpone an earlier alarm. Every admitted report and case decision
    // calls this, and a steady stream of them must not starve a pending
    // reconnect or recovery pass. Inside alarm() getAlarm() reads null.
    const next = Date.now() + HEALTH_CHECK_INTERVAL_MS;
    const pending = await this.state.storage.getAlarm();
    if (pending === null || pending > next) await this.state.storage.setAlarm(next);
  }

  /**
   * Handle incoming WebSocket message
   */
  private async handleMessage(data: string, socket: WebSocket): Promise<void> {
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
          // The live subscription is healthy: only now is the backoff reset,
          // and only now may the health alarm stamp the heartbeat.
          if (rest[0] === this.subscriptionId && this.ws === socket) {
            this.reconnectAttempts = 0;
            this.reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
            this.liveSubscriptionAcked = true;
            this.clearEoseWatchdog();
          }
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
          // The relay ended the live subscription but may keep the socket
          // open. A socket with no subscription receives nothing, yet the
          // alarm would keep stamping the heartbeat on it and hide the dead
          // period from catch-up. Close it: the close handler schedules the
          // backoff reconnect, which resubscribes and plans that gap.
          if (subId === this.subscriptionId) {
            try {
              // The socket that received the CLOSED, never this.ws.
              socket.close(1000, 'live subscription closed by relay');
            } catch (error) {
              console.error('[ReportWatcher] Failed to close socket after its subscription closed:', error);
            }
          }
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
  private async handleReportEvent(
    event: ReportEvent,
    // preClaimed: catch-up already claimed this id.
    opts: { source?: ReportIndexSource; preClaimed?: boolean; sideEffects?: boolean } = {},
  ): Promise<void> {
    const { source = 'live', sideEffects = true, preClaimed = false } = opts;
    // The live path claims before any await, so a report catch-up is handling
    // (or has handled) in this instance is not handled again.
    if (!preClaimed && !this.claimReport(event.id)) {
      console.log('[ReportWatcher] Report already claimed in this instance, skipping');
      return;
    }
    this.lastEventAt = Date.now();
    this.eventsProcessed++;

    // Extract report category from tags
    // Support multiple formats used by Divine clients:
    // 1. ["report", "<category>"] - Divine mobile app format (NIP-56)
    // 2. ["l", "NS-<category>", "social.nos.ontology"] - Divine web app format (NIP-32)
    // 3. ["l", "<category>", "MOD"] - Generic NIP-32 MOD namespace
    // 4. ["e", "<id>", "<category>"] or ["p", "<id>", "<category>"] - category in target tag
    // Extract target (e tag for event, p tag for pubkey)
    const targetEventTag = event.tags.find(t => t[0] === 'e');
    const targetPubkeyTag = event.tags.find(t => t[0] === 'p');

    // Get category from first available source
    // Priority: a child-safety category in any of these sources, then
    // report tag > NIP-32 label > e/p tag third element
    const category = reportCategory(event.tags);

    const targetType = targetEventTag ? 'event' : targetPubkeyTag ? 'pubkey' : 'unknown';

    console.log('[ReportWatcher] Report received', { category, targetType });

    // Ids are lowercased once, here, before any lookup, decision or relay call
    // (#315, #313): the relay bans and every D1 table match them exactly, and
    // the reporter's client may spell them in uppercase. A value that is not a
    // 64-character hex id names nothing that can be hidden or reviewed.
    const targetEventId = canonicalHex64(targetEventTag?.[1]);
    if (targetEventTag && !targetEventId) {
      console.log('[ReportWatcher] Report e tag is not a 64-character hex id, skipping auto-hide');
    }

    // Record when this report arrived, and index it: created_at is the reporter's claim and
    // can be backdated, so "reported after the last human handling" (#324)
    // compares this clock. Live by default; catch-up passes its own source, and
    // sideEffects:false makes this write the only thing done. replayAdultReports
    // does not record. A report no path has seen has no row, and a missing row
    // falls back to created_at. Non-critical: logged, never allowed to stop
    // auto-hide or the age review below. Only a verified event is recorded,
    // since the relay does not vouch for the id.
    if (this.env.DB) {
      try {
        if (!this.schemaReady) {
          await ensureSchema(this.env.DB);
          this.schemaReady = true;
        }
        if (verifyEvent(event as unknown as NostrEvent)) {
          const now = Math.floor(Date.now() / 1000);
          // verifyEvent above only passes a signed event, so sig is present.
          const signed = { ...event, sig: event.sig as string };
          // First batch: the arrival and the index row, atomic and always two
          // statements, however many tags the report carries. Anyone can publish
          // a kind 1984 with thousands of e/p tags, and a batch over D1's
          // 50-statement limit would fail whole and leave the report unseen, so
          // a later catch-up could re-run the non-idempotent handlers on it.
          await this.env.DB.batch([
            reportArrivalStatement(this.env.DB, event.id, now),
            ...reportIndexRowStatements(this.env.DB, [signed], source, now),
          ]);
          // The refs follow in groups of at most 50, with their own failure
          // handling: the report is already recorded as seen. The inner catch
          // exists for its own log line, and so this write stays isolated if
          // code is ever added after it inside the outer try. Accepted: a refs
          // failure leaves this report's refs incomplete for good. It is
          // recorded as seen, so catch-up will not re-index it, and ref-based
          // lookups can miss it. The failure is logged.
          try {
            await runStatements(this.env.DB, reportIndexRefStatements(this.env.DB, [signed]));
          } catch (error) {
            console.error('[ReportWatcher] Failed to record report index refs:', error);
          }
        }
      } catch (error) {
        console.error('[ReportWatcher] Failed to record report arrival and index row:', error);
      }
    }

    if (!sideEffects) return;

    // Process auto-hide if enabled and category qualifies
    if (targetEventId) {
      try {
        await this.processAutoHide(event, category, targetEventId);
      } catch (error) {
        console.error('[ReportWatcher] Auto-hide processing failed:', error);
      }
    }

    // Create age review case for under-16 reports (pubkey-level).
    // Runs after auto-hide completes; both awaited so work survives DO eviction.
    // Gated on the same reading the moderator UI uses, not the auto-hide
    // category: a child-safety label elsewhere in the report must not
    // suppress the age review.
    const reportedPubkey = canonicalHex64(targetPubkeyTag?.[1]);
    const isUnderageReport = ageReviewCategory(event) === 'NS-underageUser';
    if (isUnderageReport && targetPubkeyTag && !reportedPubkey) {
      console.log('[ReportWatcher] Report p tag is not a 64-character hex id, skipping age review');
    }
    if (isUnderageReport && reportedPubkey && !this.pendingAgeReviewPubkeys.has(reportedPubkey)) {
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
    targetEventId: string,
    advanceNow = true,
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

    const adultReport = adultSexualCategory(category) && !getReportedList(event);
    const quarantineActivated = adultReport && (this.env.SEXUAL_QUARANTINE_ENABLED === 'true'
      || await this.state.storage.get('sexual-quarantine-activated'));
    if (quarantineActivated) {
      const legacyTier = config.tiers.find(t => t.categories.includes(category));
      // Preserve an explicitly configured category's trust and count policy.
      // Canonical adult fallback is only for an otherwise unconfigured alias.
      const videoTier = legacyTier || config.tiers.find(t => t.categories.some(c => adultSexualCategory(c)));
      const client = event.tags.find(t => t[0] === 'client')?.[1]?.trim().toLowerCase();
      const trusted = config.trustedClients.some(c => c.trim().toLowerCase() === client);
      // An ignored/untrusted report must not pin replay behind an unavailable
      // target. videoTier is the exact-category tier whenever one exists.
      if (!videoTier || (videoTier.requireTrustedClient && !trusted)) {
        // Preserve the existing skipped-report audit without forcing a target
        // read. This marker deduplicates replay but never fences later admission
        // if the configured client policy changes.
        await this.processLegacySexualReport(event, category, targetEventId, `sexual-ignored-logged:${targetEventId}:${event.id}`);
        return;
      }
      // Rejection is permanent for these bytes. Throwing would hold the replay
      // window on this report forever, so alert and skip it instead.
      const wire = JSON.parse(JSON.stringify(event)) as NostrEvent;
      if (JSON.stringify(wire).length > 60_000 || wire.kind !== 1984 || !verifyEvent(wire)) {
        console.error(`[ALERT] Sexual quarantine report ${event.id} not admitted: invalid signature or over the evidence bound`);
        return;
      }
      // A backstop: intake and replay already drop a target that is not a
      // 64-character hex id and lowercase the rest (#315), so no current
      // caller reaches this.
      if (!isLowerHex64(targetEventId)) {
        console.error(`[ALERT] Sexual quarantine report ${wire.id} not admitted: invalid target identifier`);
        return;
      }
      const legacyKey = `sexual-legacy-processed:${targetEventId}:${event.id}`;
      if (await this.state.storage.get(legacyKey)) return;
      const q = this.sexualQuarantine();
      const existing = await q.get(targetEventId);
      const absentKey = `sexual-absent:${targetEventId}:${event.id}`;
      const boundKey = `sexual-target-bound:${targetEventId}:${event.id}`;
      if (await this.state.storage.get(absentKey) || await this.state.storage.get(boundKey)) return;
      let nonvideo = existing?.state === 'out_of_scope';
      let snapshot: QuarantineSnapshot | undefined;
      if (!nonvideo && !existing?.snapshot) {
        // IO validates the target signature before throwing OutsideVideoScope.
        // Transport uncertainty retains replay. A confirmed absent response is
        // archived separately so one missing target cannot pin unrelated reports.
        try { snapshot = await createQuarantineIO(this.env).snapshot(targetEventId); }
        catch (error) {
          if (error instanceof ConfirmedAbsentTarget || error instanceof TargetEvidenceLimit) {
            const archiveKey = error instanceof TargetEvidenceLimit ? boundKey : absentKey;
            const disposition = error instanceof TargetEvidenceLimit ? 'target evidence exceeds capture limit' : 'target absent';
            const source = JSON.stringify(wire);
            await this.state.storage.transaction(async tx => {
              const parts = Math.ceil(source.length / 16000);
              for (let part = 0; part < parts; part++) await tx.put(`${archiveKey}:part:${part}`, source.slice(part * 16000, (part + 1) * 16000));
              await tx.put(archiveKey, { targetId: targetEventId, reportId: event.id, category, disposition, parts, receivedAt: Date.now() });
            });
            console.error(`[ALERT] Sexual quarantine ${disposition}: ${targetEventId}; archived report ${event.id} for backfill review`);
            return;
          }
          if (!(error instanceof OutsideVideoScope)) throw error;
          nonvideo = true;
        }
      }
      if (nonvideo) {
        await this.processLegacySexualReport(event, category, targetEventId, legacyKey);
        return;
      }

      // Once activated, video admission rollback must not resume base bans:
      // those cannot be released by this stream's named-hold Restore.
      if (this.env.SEXUAL_QUARANTINE_ENABLED !== 'true') return;
      let hideTriggered = false;
      const admitted = await this.state.blockConcurrencyWhile(async () => {
        // Decided cases still retain incoming evidence. admit() keeps their
        // human intent final, so this cannot re-hide a restored event. Other
        // human resolutions continue to fence new/undecided case admission.
        const currentCase = await q.get(targetEventId);
        if (!currentCase?.actor) {
          const human = await this.hasBlockingHumanResolution(targetEventId, false);
          if (human !== false) return false;
        }
        const before = currentCase?.goal;
        const admittedCase = await q.admit(targetEventId, { id: event.id, pubkey: event.pubkey, reason: category,
          source: JSON.parse(JSON.stringify(wire)) as object }, // A legacy fractional threshold means the next whole reporter count.
          Math.max(2, Math.ceil(videoTier.threshold)), snapshot);
        // This report is the one that sent the case to a hide: an automated
        // hide action, counted like a legacy hide.
        hideTriggered = before !== 'hide' && admittedCase?.goal === 'hide';
        return true;
      });
      if (!admitted) return;
      if (hideTriggered) this.noteAutoAction(event.id);
      await this.scheduleHealthCheck();
      if (advanceNow) await q.advance(targetEventId);
      return;
    }
    await this.processLegacyAutoHide(event, category, targetEventId);
  }

  private async processLegacySexualReport(event: ReportEvent, category: string, targetEventId: string, key: string): Promise<void> {
    const pending = this.pendingLegacySexualReports.get(key);
    if (pending) return pending;
    const work = (async () => {
      if (await this.state.storage.get(key)) return;
      await this.processLegacyAutoHide(event, category, targetEventId);
      // Records processing, not confirmed enforcement: the legacy writer keeps
      // its existing skip/failure policy. Prevent duplicate replay decisions.
      await this.state.storage.put(key, true);
    })();
    this.pendingLegacySexualReports.set(key, work);
    try { await work; } finally { this.pendingLegacySexualReports.delete(key); }
  }

  private async processLegacyAutoHide(event: ReportEvent, category: string, targetEventId: string): Promise<void> {
    const config = this.autoHideConfig;
    if (!config?.enabled) return;
    // Find which tier this category belongs to
    const tier = config.tiers.find(t => t.categories.includes(category));
    if (!tier) {
      console.log(`[ReportWatcher] Category '${category}' not in any auto-hide tier, skipping`);
      return;
    }

    // List reports go to human review, never to an automatic hide. Divine
    // clients name the reported list in an `a` tag (see shared/list-report).
    if (getReportedList(event)) {
      console.log(`[ReportWatcher] List report for ${targetEventId}, leaving it to human review`);
      // A category in the immediate tier would have hidden a video on this one
      // report, so the list report raises an alert instead of waiting silently.
      if (isImmediateAutoHideTier(tier)) {
        console.error(`[ALERT] [ReportWatcher] Immediate-tier list report for ${targetEventId} (${category}) needs human review`);
      }
      await this.logDecision({
        targetType: 'event',
        targetId: targetEventId,
        action: AUTO_HIDE_ACTION.skipped,
        reason: `${category}: list report, human review`,
        reportId: event.id,
        reporterPubkey: event.pubkey,
      });
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
      this.noteAutoAction(event.id);
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
    reporterPubkey: string | null;
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
        decision.moderatorPubkey || AUTOMATED_MODERATOR,
        decision.reportId,
        decision.reporterPubkey
      ).run();

      console.log(`[ReportWatcher] Logged decision: ${decision.action}`);
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
          operation.moderatorPubkey || AUTOMATED_MODERATOR,
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
    // Every case lookup is by lowercase pubkey (#313). handleReportEvent
    // lowercases the tag; this holds any other caller to the same form.
    if (!isLowerHex64(reportedPubkey)) {
      console.error('[ReportWatcher] Refusing to open an age review case: pubkey is not lowercase hex');
      return;
    }
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

    await openReportedAgeReviewCase(
      this.env.DB,
      this.env,
      reportedPubkey,
      { kind: 'report', reportEventId: event.id, reporterPubkey: event.pubkey },
      (decision) => this.logDecision(decision),
      '[ReportWatcher]',
    );
  }

  /**
   * Alarm handler for reconnection and health checks
   */
  async alarm(): Promise<void> {
    console.log('[ReportWatcher] Alarm triggered');

    // Reconnect first. Case recovery and replay below make slow network calls,
    // and live auto-hide for every category waits on this socket.
    if (this.running) {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        console.log('[ReportWatcher] Connection lost, reconnecting...');
        this.connect();
      } else {
        console.log('[ReportWatcher] Connection healthy');
      }
    }

    // A connection whose plan failed (D1 down at connect) retries it here, in
    // the background like the connect does, while its socket stays open.
    if (this.running && !this.catchUpPlannedForConnection && this.env.DB
      && this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.state.waitUntil(this.planAndRunCatchUp(this.ws));
    }

    // Heartbeat for restart catch-up: only a live socket whose catch-up window
    // is already saved and whose live subscription has reached EOSE may
    // advance it. Without EOSE the relay may be delivering nothing, and a stamp
    // would move the next catch-up window past reports filed meanwhile.
    // Non-critical, so its own try/catch.
    if (
      this.running && this.catchUpPlannedForConnection && this.liveSubscriptionAcked && this.env.DB
      && this.ws && this.ws.readyState === WebSocket.OPEN
    ) {
      try {
        await metaStatement(this.env.DB, 'watcher_last_alive_at', Math.floor(Date.now() / 1000)).run();
      } catch (error) {
        console.error('[ReportWatcher] Failed to stamp watcher heartbeat:', error);
      }
    }

    if (await this.state.storage.get('sexual-jobs-exist')) {
      // Case recovery must not abort the watcher's next health check.
      try {
        await this.sexualQuarantine().tick();
      } catch (error) {
        console.error('[ALERT] Sexual quarantine recovery incomplete; retry scheduled:', error);
      }
      const sexualJobs = await this.state.storage.list({ prefix: 'sexual-job:', limit: 1 });
      if (sexualJobs.size) await this.scheduleHealthCheck();
    }

    // Classification recovery remains necessary after admission rollback: a
    // failed target lookup may still belong to the unchanged non-video writer.
    // processAutoHide keeps new video holds disabled while replay retains its
    // durable cursor on uncertainty.
    const replayActivated = this.env.SEXUAL_QUARANTINE_ENABLED === 'true'
      || await this.state.storage.get('sexual-quarantine-activated');
    if (this.running && replayActivated && this.autoHideConfig?.enabled) {
      try {
        await replayAdultReports(this.state.storage, this.env.RELAY_URL, async (event, category, target) => {
          // A stop during the replay: nothing more runs, and the throw keeps
          // the cursor so the next start replays the rest.
          if (!this.running) throw new ReplayStopped();
          // Same gate as catch-up, read as it stands for each report (a stop
          // and a start can land during the run): no automated action on a
          // report created while the watcher was deliberately stopped. It
          // includes the clock margin after the /start. The replay also
          // re-reads live arrivals, so a report from those two minutes whose
          // live handling failed is not recovered here. Accepted: the window
          // is short and the report stays in the queue for a moderator.
          if (inStoppedPeriod(event.created_at, await this.currentStoppedPeriods())) return;
          if (await this.hasBlockingHumanResolution(target, false) === null) throw new Error('Review state unavailable');
          await this.processAutoHide(event, category, target, false);
        });
      } catch (error) {
        if (error instanceof ReplayStopped) console.log('[ReportWatcher] Stopped during the sexual report replay; cursor retained');
        else console.error('[ALERT] Sexual report replay incomplete; cursor retained');
      }
      await this.scheduleHealthCheck();
    }

    if (!this.running) {
      console.log('[ReportWatcher] Not running, skipping alarm');
      return;
    }

    // Schedule next health check
    await this.scheduleHealthCheck();
  }

  private sexualQuarantine(): SexualQuarantine {
    return this.sexualEngine ??= new SexualQuarantine(this.state.storage, createQuarantineIO(this.env));
  }

  // Only reached through the Worker's authenticated report-watcher proxy.
  private async handleSexualQuarantine(request: Request, path: string): Promise<Response> {
    const [, , eventId, suffix] = path.split('/');
    const headers = { 'Cache-Control': 'private, no-store' };
    const q = this.sexualQuarantine();
    if (!eventId && request.method === 'GET') {
      const cursor = new URL(request.url).searchParams.get('cursor') ?? undefined;
      if (cursor !== undefined && !/^sexual-review-v3:[01]:[0-9]{16}:[0-9a-f]{64}$/.test(cursor)) {
        return Response.json({ error: 'Invalid review queue cursor' }, { status: 400, headers });
      }
      return Response.json(await q.listPage(cursor), { headers });
    }
    if (!isLowerHex64(eventId)) return Response.json({ error: 'Invalid event ID' }, { status: 400, headers });
    if (request.method === 'GET') {
      const c = await q.get(eventId);
      return Response.json(suffix === 'history' ? await q.history(eventId) : c || { error: 'Case not found' }, { status: c ? 200 : 404, headers });
    }
    if (request.method !== 'POST' || suffix) return Response.json({ error: 'Method not allowed' }, { status: 405, headers });
    let input: { revision?: unknown; decision?: unknown; actor?: unknown; reason?: unknown };
    try { input = await request.json(); } catch { return Response.json({ error: 'Invalid JSON' }, { status: 400, headers }); }
    if (!Number.isSafeInteger(input.revision) || (input.decision !== 'restore' && input.decision !== 'remove')
      || typeof input.actor !== 'string' || !input.actor.trim() || input.actor.trim() === 'auto' || input.actor.length > 200
      || typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 2000) {
      return Response.json({ error: 'Revision, decision, reviewer and reason are required' }, { status: 400, headers });
    }
    const { revision, decision, actor, reason } = input;
    try {
      await q.decide(eventId, revision as number, decision as 'restore' | 'remove', actor as string, reason as string);
    } catch (error) {
      return error instanceof QuarantineConflict
        ? Response.json({ error: 'Case revision conflict' }, { status: 409, headers })
        : Response.json({ error: 'Could not save the decision; retry' }, { status: 500, headers });
    }
    // decide() durably saved intent and its due-work index. Await the alarm
    // before acknowledging it; enforcement and delivery run on that alarm,
    // outside the HTTP client's timeout and without unawaited background work.
    await this.scheduleHealthCheck();
    return Response.json(await q.get(eventId), { status: 202, headers });
  }
}
