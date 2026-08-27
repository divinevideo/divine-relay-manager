import type { SecretStoreSecret } from './nip86';

export interface ZendeskSyncEnv {
  DB?: D1Database;
  ZENDESK_SUBDOMAIN?: string | SecretStoreSecret;
  ZENDESK_API_TOKEN?: string | SecretStoreSecret;
  ZENDESK_EMAIL?: string | SecretStoreSecret;
  ZENDESK_FIELD_CATEGORY?: string;
  ZENDESK_FIELD_ISSUE?: string;
  // Group to route resolved tickets to (the Trust & Safety queue), instead of
  // assigning the API credential's owner. Numeric Zendesk group id as a string.
  ZENDESK_GROUP_ID?: string;
  NOSTR_NSEC: string | SecretStoreSecret;
  RELAY_URL: string;
}

async function resolveString(val: string | SecretStoreSecret | undefined): Promise<string | undefined> {
  if (!val) return undefined;
  return typeof val === 'string' ? val : await val.get();
}

export interface ResolvedZendeskCreds {
  subdomain: string;
  email: string;
  apiToken: string;
}

export async function resolveZendeskCreds(env: Pick<ZendeskSyncEnv, 'ZENDESK_SUBDOMAIN' | 'ZENDESK_API_TOKEN' | 'ZENDESK_EMAIL'>): Promise<ResolvedZendeskCreds | null> {
  const [subdomain, apiToken, email] = await Promise.all([
    resolveString(env.ZENDESK_SUBDOMAIN),
    resolveString(env.ZENDESK_API_TOKEN),
    resolveString(env.ZENDESK_EMAIL),
  ]);
  if (!subdomain || !apiToken || !email) return null;
  return { subdomain, email, apiToken };
}

async function requireZendeskSubdomain(env: Pick<ZendeskSyncEnv, 'ZENDESK_SUBDOMAIN'>): Promise<string> {
  const subdomain = await resolveString(env.ZENDESK_SUBDOMAIN);
  if (!subdomain) throw new Error('Zendesk subdomain is not configured');
  return subdomain;
}

function buildResolutionCustomFields(env: ZendeskSyncEnv): Array<{ id: number; value: string }> | undefined {
  if (!env.ZENDESK_FIELD_CATEGORY || !env.ZENDESK_FIELD_ISSUE) {
    return undefined;
  }

  return [
    { id: Number.parseInt(env.ZENDESK_FIELD_CATEGORY, 10), value: 'trust___safety' },
    { id: Number.parseInt(env.ZENDESK_FIELD_ISSUE, 10), value: 'other_content_report' },
  ];
}

export async function ensureZendeskTable(db: D1Database): Promise<void> {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS zendesk_tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER NOT NULL UNIQUE,
      event_id TEXT,
      author_pubkey TEXT,
      violation_type TEXT,
      status TEXT DEFAULT 'open',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      resolved_at TEXT,
      resolution_action TEXT,
      resolution_moderator TEXT
    )
  `).run();

  try {
    await db.prepare(`CREATE INDEX IF NOT EXISTS idx_zendesk_event ON zendesk_tickets(event_id)`).run();
  } catch {
    // Index might already exist
  }

  try {
    await db.prepare(`CREATE INDEX IF NOT EXISTS idx_zendesk_pubkey ON zendesk_tickets(author_pubkey)`).run();
  } catch {
    // Index might already exist
  }

  try {
    await db.prepare(`CREATE INDEX IF NOT EXISTS idx_zendesk_status ON zendesk_tickets(status)`).run();
  } catch {
    // Index might already exist
  }

  // Expression indexes for the case-insensitive linkage lookups (getLinkedTickets /
  // syncZendeskAfterAction query `WHERE lower(event_id|author_pubkey) = ?`). Without
  // these the raw-column indexes above can't serve those queries, forcing a full
  // scan that grows with the ticket table.
  try {
    await db.prepare(`CREATE INDEX IF NOT EXISTS idx_zendesk_event_lower ON zendesk_tickets(lower(event_id))`).run();
  } catch {
    // Index might already exist
  }

  try {
    await db.prepare(`CREATE INDEX IF NOT EXISTS idx_zendesk_pubkey_lower ON zendesk_tickets(lower(author_pubkey))`).run();
  } catch {
    // Index might already exist
  }
}

// Returns true only when the note (and, when solve=true, the status change)
// actually landed at Zendesk. Callers that treat closure as best-effort (the
// moderation-action side effect) may ignore the result; callers for which the
// Zendesk write IS the operation (manual close) must check it.
export async function addZendeskInternalNote(
  ticketId: number,
  note: string,
  env: ZendeskSyncEnv,
  solve: boolean = false
): Promise<boolean> {
  const creds = await resolveZendeskCreds(env);
  if (!creds) {
    console.warn('[addZendeskInternalNote] Missing Zendesk credentials, skipping');
    return false;
  }

  try {
    const auth = btoa(`${creds.email}/token:${creds.apiToken}`);
    const url = `https://${creds.subdomain}.zendesk.com/api/v2/tickets/${ticketId}`;

    const payload: {
      ticket: {
        comment: { body: string; public: boolean };
        status?: string;
        group_id?: number;
        custom_fields?: Array<{ id: number; value: string }>;
      };
    } = {
      ticket: {
        comment: {
          body: note,
          public: false,
        },
      },
    };

    if (solve) {
      payload.ticket.status = 'solved';
      // Route resolved tickets to a group (Trust & Safety) instead of assigning
      // the API credential's owner. This instance allows solving without an
      // individual assignee, so the ticket lands unassigned in the queue.
      if (env.ZENDESK_GROUP_ID) payload.ticket.group_id = Number(env.ZENDESK_GROUP_ID);
      payload.ticket.custom_fields = buildResolutionCustomFields(env);
    }

    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[addZendeskInternalNote] Failed: ${response.status} - ${errorText}`);
      return false;
    }
    return true;
  } catch (error) {
    console.error('[addZendeskInternalNote] Error:', error);
    return false;
  }
}

export async function syncZendeskAfterAction(
  env: ZendeskSyncEnv,
  action: string,
  targetType: 'event' | 'pubkey' | 'media',
  targetId: string,
  moderator: string
): Promise<void> {
  console.log('[syncZendeskAfterAction] Called with:', { action, targetType, targetId, moderator });

  if (!env.DB) {
    console.log('[syncZendeskAfterAction] No DB configured, skipping');
    return;
  }

  try {
    await ensureZendeskTable(env.DB);

    // Match case-insensitively: event ids and pubkeys are stored lowercase going
    // forward, but older rows may be mixed-case, and the action-side ids arrive
    // lowercased. lower() on the column keeps the match robust either way.
    const id = targetId.toLowerCase();
    let linkedTickets: Array<{ ticket_id: number }> = [];

    if (targetType === 'event') {
      console.log('[syncZendeskAfterAction] Querying for event_id:', id);
      const res = await env.DB.prepare(
        `SELECT ticket_id FROM zendesk_tickets WHERE lower(event_id) = ? AND status = 'open'`
      ).bind(id).all<{ ticket_id: number }>();
      linkedTickets = res.results ?? [];
    } else if (targetType === 'pubkey') {
      console.log('[syncZendeskAfterAction] Querying for author_pubkey:', id);
      const res = await env.DB.prepare(
        `SELECT ticket_id FROM zendesk_tickets WHERE lower(author_pubkey) = ? AND status = 'open'`
      ).bind(id).all<{ ticket_id: number }>();
      linkedTickets = res.results ?? [];
    }

    console.log('[syncZendeskAfterAction] Query result:', linkedTickets);

    // Close EVERY open ticket linked to this target, not just the first. Multiple
    // reports on one piece of content (or one author) produce multiple tickets;
    // a single action resolves all of them.
    if (linkedTickets.length === 0) {
      console.log('[syncZendeskAfterAction] No linked open ticket found, skipping');
      return;
    }

    // suspend_user / unsuspend_user deliberately excluded — suspension is a
    // holding action, not a final resolution, so tickets stay open for follow-up.
    const resolutionActions = [
      'reviewed',
      'dismissed',
      'no-action',
      'false-positive',
      'delete_event',
      'hide_event',
      'allow_event',
      'ban_pubkey',
      'ban_user',
      'auto_hide_confirmed',
      'auto_hide_restored',
    ];
    const isResolution = resolutionActions.includes(action);

    const actionDisplay = action.replace(/_/g, ' ').replace(/([A-Z])/g, ' $1').trim();
    const timestamp = new Date().toISOString();

    const note = [
      '📋 **Moderation Action Taken**',
      '',
      `**Action:** ${actionDisplay}`,
      `**Target:** \`${targetId}\``,
      `**Moderator:** ${moderator}`,
      `**Time:** ${timestamp}`,
    ].join('\n');

    for (const { ticket_id } of linkedTickets) {
      const posted = await addZendeskInternalNote(ticket_id, note, env, isResolution);

      // Record the D1 resolution ONLY when Zendesk actually confirmed the close.
      // The panel reads this status; marking a row resolved after a failed solve
      // would show "Closed ✓" over a still-open ticket and hide the Close button.
      // Leaving it 'open' keeps the row honest and lets the next action (or a manual
      // close) retry. Still best-effort: this never throws — the moderation action
      // itself already succeeded.
      if (isResolution && posted) {
        await env.DB.prepare(`
          UPDATE zendesk_tickets
          SET status = 'resolved',
              resolved_at = CURRENT_TIMESTAMP,
              resolution_action = ?,
              resolution_moderator = ?
          WHERE ticket_id = ?
        `).bind(action, moderator, ticket_id).run();
        console.log(`[syncZendeskAfterAction] Resolved ticket #${ticket_id} with action: ${action}`);
      } else if (isResolution) {
        console.warn(`[syncZendeskAfterAction] Zendesk solve failed for ticket #${ticket_id}; left open for retry`);
      }
    }
  } catch (error) {
    console.error('[syncZendeskAfterAction] Error:', error);
  }
}

export interface LinkedTicket {
  ticket_id: number;
  status: string;
  url: string;
}

export function zendeskTicketUrl(subdomain: string, ticketId: number): string {
  return `https://${subdomain}.zendesk.com/agent/tickets/${ticketId}`;
}

// Look up the Zendesk tickets linked to an event and/or a pubkey, deduped by
// ticket_id (a ticket can match on both). Matches case-insensitively, mirroring
// the closure query. Returns every linked ticket regardless of status so the UI
// can show closed ones as an affirmative "done" state, not just openable ones.
export async function getLinkedTickets(
  env: ZendeskSyncEnv,
  target: { eventId?: string; pubkey?: string },
): Promise<LinkedTicket[]> {
  if (!env.DB) throw new Error('D1 database is not configured');
  await ensureZendeskTable(env.DB);
  const subdomain = await requireZendeskSubdomain(env);

  const byId = new Map<number, LinkedTicket>();
  const add = (rows: Array<{ ticket_id: number; status: string }>) => {
    for (const r of rows) {
      byId.set(r.ticket_id, { ticket_id: r.ticket_id, status: r.status, url: zendeskTicketUrl(subdomain, r.ticket_id) });
    }
  };

  if (target.eventId) {
    const r = await env.DB.prepare(
      `SELECT ticket_id, status FROM zendesk_tickets WHERE lower(event_id) = ?`
    ).bind(target.eventId.toLowerCase()).all<{ ticket_id: number; status: string }>();
    add(r.results ?? []);
  }
  if (target.pubkey) {
    const r = await env.DB.prepare(
      `SELECT ticket_id, status FROM zendesk_tickets WHERE lower(author_pubkey) = ?`
    ).bind(target.pubkey.toLowerCase()).all<{ ticket_id: number; status: string }>();
    add(r.results ?? []);
  }
  return [...byId.values()];
}

// Close a single ticket from Relay Manager: internal note + Zendesk solve + D1
// status. Deliberately does NOT write a moderation_decisions row — closing a
// ticket is not the same as actioning content (it may be a duplicate or no-op).
export async function closeTicketById(
  env: ZendeskSyncEnv,
  ticketId: number,
  moderator: string | null,
): Promise<boolean> {
  if (!env.DB) throw new Error('D1 database is not configured');
  await ensureZendeskTable(env.DB);

  // This endpoint is a fallback for tickets surfaced by the linked-ticket lookup,
  // not a general-purpose Zendesk mutation API. Refuse ids that Relay Manager does
  // not track before making the external write.
  const linked = await env.DB.prepare(
    `SELECT status FROM zendesk_tickets WHERE ticket_id = ?`
  ).bind(ticketId).first<{ status: string }>();
  if (!linked) return false;
  if (linked.status !== 'open') return true;

  const note = [
    '📋 **Ticket closed from Relay Manager**',
    '',
    `**Closed by:** ${moderator ?? 'unknown'}`,
    `**Time:** ${new Date().toISOString()}`,
  ].join('\n');
  const solved = await addZendeskInternalNote(ticketId, note, env, true);
  if (!solved) {
    // Manual close is this endpoint's PRIMARY operation, not a best-effort side
    // effect. If the Zendesk solve did not land (creds missing, non-2xx, network),
    // do NOT mark D1 resolved — that would flip the panel to "Closed ✓" over a
    // still-open ticket and hide the retry. Surface it so the UI keeps the button.
    throw new Error('Zendesk solve did not succeed; ticket not marked resolved');
  }
  // AND status = 'open' protects the audit trail if another action resolves the
  // ticket after the presence check and before this update.
  await env.DB.prepare(`
    UPDATE zendesk_tickets
    SET status = 'resolved',
        resolved_at = CURRENT_TIMESTAMP,
        resolution_action = 'manual_close',
        resolution_moderator = ?
    WHERE ticket_id = ? AND status = 'open'
  `).bind(moderator, ticketId).run();
  return true;
}
